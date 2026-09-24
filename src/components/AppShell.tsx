"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import { cx } from "./ui";

const NAV = [
  { href: "/projects", label: "Projects", icon: "▦" },
  { href: "/editor", label: "Editor", icon: "✂" },
  { href: "/library", label: "Media Library", icon: "▤" },
  { href: "/styles", label: "Styles", icon: "◐" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

export function AppShell({ children, email }: { children: ReactNode; email: string | null }) {
  const path = usePathname();
  const router = useRouter();
  const signOut = async () => {
    await createClient().auth.signOut();
    router.replace("/login");
  };
  return (
    <div className="flex h-dvh min-h-0">
      <nav className="flex w-52 shrink-0 flex-col border-r border-line bg-panel">
        <div className="px-4 py-4">
          <div className="text-base font-bold tracking-tight">
            DocuCut <span className="text-accent">AI</span>
          </div>
          <div className="text-[11px] text-muted">Documentary editor</div>
        </div>
        <ul className="flex-1 space-y-0.5 px-2">
          {NAV.map((n) => {
            const active = path === n.href || (n.href === "/editor" ? path.startsWith("/projects/") : path.startsWith(`${n.href}/`) || path === n.href);
            return (
              <li key={n.href}>
                <Link
                  href={n.href}
                  className={cx("flex items-center gap-2.5 rounded-md px-3 py-2 text-sm", active ? "bg-panel-2 text-foreground" : "text-muted hover:bg-panel-2 hover:text-foreground")}
                >
                  <span className="w-4 text-center opacity-80">{n.icon}</span>
                  {n.label}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="border-t border-line px-4 py-3 text-xs text-muted">
          <div className="truncate">{email}</div>
          <button onClick={signOut} className="mt-1 hover:text-foreground">
            Sign out
          </button>
        </div>
      </nav>
      <main className="min-w-0 flex-1 overflow-auto">{children}</main>
    </div>
  );
}
