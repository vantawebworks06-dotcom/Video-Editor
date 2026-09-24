// Cost estimation for Claude calls. Prices are USD per million tokens (Anthropic first-party API).
export const MODEL_DEFAULT = "claude-opus-5";
/** Budget Mode uses the less expensive current-generation model. */
export const MODEL_BUDGET = "claude-sonnet-5";

const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-opus-4-8": { input: 5, output: 25 },
};

export interface UsageRecord {
  fn: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  cached: boolean; // served from our response cache (no API call)
}

export function estimateCost(model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number }) {
  const p = PRICING[model] ?? PRICING[MODEL_DEFAULT]!;
  return (
    (u.input * p.input + u.output * p.output + u.cacheRead * p.input * 0.1 + u.cacheWrite * p.input * 1.25) / 1_000_000
  );
}

export interface UsageSink {
  record(r: UsageRecord): Promise<void> | void;
}

/** Accumulates usage in memory; the worker also persists each record. */
export class UsageTracker implements UsageSink {
  records: UsageRecord[] = [];
  constructor(private next?: UsageSink) {}
  async record(r: UsageRecord) {
    this.records.push(r);
    await this.next?.record(r);
  }
  get totals() {
    const live = this.records.filter((r) => !r.cached);
    return {
      calls: live.length,
      cachedCalls: this.records.length - live.length,
      inputTokens: live.reduce((s, r) => s + r.inputTokens, 0),
      outputTokens: live.reduce((s, r) => s + r.outputTokens, 0),
      costUsd: live.reduce((s, r) => s + r.costUsd, 0),
    };
  }
}
