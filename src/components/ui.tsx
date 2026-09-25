"use client";

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import type { RightsStatus } from "@/lib/domain/types";

// Small shadcn-style primitives (hand-rolled to keep the bundle lean).

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

/**
 * Remote thumbnail filling its (relative) parent. Unlike a CSS background image it loads lazily,
 * only once scrolled near the viewport, so long lists don't fetch every thumbnail up front.
 */
export function Thumb({ src, fit = "cover" }: { src: string | null | undefined; fit?: "cover" | "contain" }) {
  if (!src) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- remote provider thumbnails from many hosts
    <img src={src} alt="" loading="lazy" decoding="async" className={cx("pointer-events-none absolute inset-0 h-full w-full", fit === "cover" ? "object-cover" : "object-contain")} />
  );
}

export function Button({ variant = "secondary", size = "md", className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        variant === "primary" && "bg-accent text-accent-ink hover:brightness-110",
        variant === "secondary" && "bg-panel-2 border border-line text-foreground hover:bg-[#252930]",
        variant === "ghost" && "text-muted hover:text-foreground hover:bg-panel-2",
        variant === "danger" && "bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25",
        className,
      )}
    />
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx("h-9 w-full rounded-md border border-line bg-background px-3 text-sm outline-none placeholder:text-muted focus:border-accent", props.className)}
    />
  );
}

export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <select {...props} className={cx("h-9 w-full rounded-md border border-line bg-background px-2 text-sm outline-none focus:border-accent", props.className)}>
      {children}
    </select>
  );
}

export function Label({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <label className="mb-1 block text-xs font-medium text-muted">
      {children}
      {hint && <span className="ml-1 font-normal opacity-70">— {hint}</span>}
    </label>
  );
}

export function Panel({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-lg border border-line bg-panel", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

const RIGHTS_STYLE: Record<RightsStatus, string> = {
  CLEAR: "bg-ok/15 text-ok border-ok/30",
  ATTRIBUTION_REQUIRED: "bg-info/15 text-info border-info/30",
  USER_REVIEW: "bg-accent/15 text-accent border-accent/30",
  UNKNOWN: "bg-[#6b6f76]/20 text-[#aeb3ba] border-[#6b6f76]/40",
  RESTRICTED: "bg-danger/15 text-danger border-danger/30",
};
const RIGHTS_TEXT: Record<RightsStatus, string> = {
  CLEAR: "Clear",
  ATTRIBUTION_REQUIRED: "Attribution",
  USER_REVIEW: "Review",
  UNKNOWN: "Unknown",
  RESTRICTED: "Restricted",
};

export function RightsBadge({ status }: { status: RightsStatus }) {
  return <span className={cx("inline-flex h-5 items-center rounded border px-1.5 text-[10px] font-semibold uppercase tracking-wide", RIGHTS_STYLE[status])}>{RIGHTS_TEXT[status]}</span>;
}

export function Tag({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "accent" | "ok" | "danger" }) {
  return (
    <span
      className={cx(
        "inline-flex h-5 items-center rounded px-1.5 text-[10px] font-medium",
        tone === "default" && "bg-panel-2 text-muted",
        tone === "accent" && "bg-accent/15 text-accent",
        tone === "ok" && "bg-ok/15 text-ok",
        tone === "danger" && "bg-danger/15 text-danger",
      )}
    >
      {children}
    </span>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-panel-2">
      <div className="h-full bg-accent transition-all" style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
    </div>
  );
}

export function ComingSoon({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted">
      {children} <Tag>Coming Soon</Tag>
    </span>
  );
}

export async function api<T = unknown>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init?.json !== undefined ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export function fmtTime(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}
