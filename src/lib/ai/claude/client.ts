import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stableHash } from "@/lib/media/cache";
import type { ConnectionStatus } from "@/lib/media/providers/types";
import { estimateCost, MODEL_DEFAULT, type UsageSink } from "./usage";

export class AiError extends Error {
  constructor(
    public readonly code: "NOT_CONFIGURED" | "INVALID_KEY" | "RATE_LIMITED" | "REFUSED" | "INVALID_OUTPUT" | "API_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}

/** Stored AI responses keyed by deterministic hash — unchanged inputs never hit the API twice. */
export interface AiResponseCache {
  get(fn: string, key: string): Promise<unknown | null>;
  set(fn: string, key: string, value: unknown, meta: { model: string }): Promise<void>;
}

export class FileAiCache implements AiResponseCache {
  constructor(private dir = path.join(process.cwd(), ".cache", "ai")) {}
  async get(fn: string, key: string) {
    try {
      return JSON.parse(await readFile(path.join(this.dir, `${fn}-${key}.json`), "utf8"));
    } catch {
      return null;
    }
  }
  async set(fn: string, key: string, value: unknown) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(path.join(this.dir, `${fn}-${key}.json`), JSON.stringify(value));
  }
}

export interface ClaudeContext {
  client: Anthropic;
  model: string;
  effort: "low" | "medium" | "high";
  cache?: AiResponseCache;
  usage?: UsageSink;
}

export function createClaudeClient(apiKey: string | undefined): Anthropic {
  if (!apiKey) throw new AiError("NOT_CONFIGURED", "ANTHROPIC_API_KEY is not configured");
  return new Anthropic({ apiKey, maxRetries: 2, timeout: 5 * 60_000 });
}

/** Best-effort local repair of near-JSON (code fences, prose around the object, trailing commas). */
export function repairJson(text: string): unknown | undefined {
  let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  t = t.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function issuesToText(error: z.ZodError): string {
  return error.issues
    .slice(0, 12)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
}

type ImageBlock = {
  type: "image";
  source: { type: "url"; url: string } | { type: "base64"; media_type: "image/jpeg" | "image/png"; data: string };
};
type TextBlock = { type: "text"; text: string };
export type UserContent = string | (ImageBlock | TextBlock)[];

/**
 * One structured Claude call. Output is constrained to the schema by the API,
 * validated again with Zod, repaired/retried on failure, cached by input hash,
 * and never returned unless it validates.
 */
export async function callStructured<S extends z.ZodType>(
  ctx: ClaudeContext,
  opts: { fn: string; system: string; content: UserContent; schema: S; maxTokens?: number; cacheKeyExtra?: unknown },
): Promise<z.infer<S>> {
  const key = stableHash({ fn: opts.fn, model: ctx.model, system: opts.system, content: opts.content, extra: opts.cacheKeyExtra });
  const cached = await ctx.cache?.get(opts.fn, key).catch(() => null);
  if (cached) {
    const ok = opts.schema.safeParse(cached);
    if (ok.success) {
      await ctx.usage?.record({
        fn: opts.fn, model: ctx.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, cached: true,
      });
      return ok.data;
    }
  }

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: opts.content }];
  let lastProblem = "";

  for (let attempt = 1; attempt <= 3; attempt++) {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await ctx.client.beta.messages.create({
        model: ctx.model,
        max_tokens: opts.maxTokens ?? 16000,
        system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
        messages,
        thinking: { type: "adaptive" },
        output_config: { effort: ctx.effort, format: betaZodOutputFormat(opts.schema) },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: ctx.model === MODEL_DEFAULT ? "default" : undefined,
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new AiError("INVALID_KEY", "Claude rejected the API key (invalid or expired).");
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new AiError("RATE_LIMITED", "Claude rate limit reached after retries. Try again shortly.");
      }
      if (err instanceof Anthropic.BadRequestError && messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "image"))) {
        // Usually an unreachable image URL: retry text-only.
        stripImages(messages);
        lastProblem = `image fetch failed: ${err.message}`;
        continue;
      }
      if (err instanceof Anthropic.APIError) throw new AiError("API_ERROR", `Claude API error ${err.status}: ${err.message}`);
      throw new AiError("API_ERROR", (err as Error).message);
    }

    const u = response.usage;
    await ctx.usage?.record({
      fn: opts.fn,
      model: response.model ?? ctx.model,
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      costUsd: estimateCost(response.model ?? ctx.model, {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      }),
      cached: false,
    });

    if (response.stop_reason === "refusal") {
      throw new AiError("REFUSED", `Claude declined this request (${response.stop_details?.category ?? "unspecified"}).`);
    }

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = repairJson(text);
    }

    if (response.stop_reason === "max_tokens") {
      lastProblem = "output was truncated (max_tokens)";
    } else if (parsed !== undefined) {
      const result = opts.schema.safeParse(parsed);
      if (result.success) {
        await ctx.cache?.set(opts.fn, key, result.data, { model: ctx.model }).catch(() => undefined);
        return result.data;
      }
      lastProblem = issuesToText(result.error);
    } else {
      lastProblem = "response was not valid JSON";
    }

    // Ask Claude to correct its own output, then validate again.
    messages.push({ role: "assistant", content: text || "{}" });
    messages.push({
      role: "user",
      content: `That output failed validation:\n${lastProblem}\nReturn the complete corrected JSON object only.`,
    });
  }

  throw new AiError("INVALID_OUTPUT", `Claude output failed validation after 3 attempts: ${lastProblem}`);
}

function stripImages(messages: Anthropic.Beta.BetaMessageParam[]) {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      m.content = m.content.filter((b) => b.type !== "image") as typeof m.content;
    }
  }
}

export async function testClaude(apiKey: string | undefined): Promise<ConnectionStatus> {
  if (!apiKey) return { state: "not_connected", message: "No ANTHROPIC_API_KEY configured." };
  try {
    const client = createClaudeClient(apiKey);
    const res = await client.messages.create({
      model: MODEL_DEFAULT,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with the word OK." }],
    });
    return { state: "connected", message: `OK — ${res.model} responded.` };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { state: "invalid_key", message: "API key rejected (invalid or expired)." };
    if (err instanceof Anthropic.RateLimitError) return { state: "rate_limited", message: "Rate limited." };
    if (err instanceof Anthropic.APIError) return { state: "error", message: `API error ${err.status}: ${err.message}` };
    return { state: "error", message: (err as Error).message };
  }
}
