"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button, Input, Label } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const supabase = createClient();
    const { data, error } =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}/projects` } });
    setBusy(false);
    if (error) return setMessage({ tone: "error", text: error.message });
    if (mode === "signup" && !data.session) {
      return setMessage({ tone: "info", text: "Check your email to confirm your account, then sign in." });
    }
    // Only allow same-site relative redirects.
    router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/projects");
    router.refresh();
  };

  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-panel p-6">
      <div>
        <h1 className="text-xl font-bold">
          DocuCut <span className="text-accent">AI</span>
        </h1>
        <p className="text-sm text-muted">{mode === "signin" ? "Sign in to your projects" : "Create an account"}</p>
      </div>
      <div>
        <Label>Email</Label>
        <Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div>
        <Label>Password</Label>
        <Input type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      {message && <p className={message.tone === "error" ? "text-sm text-danger" : "text-sm text-info"}>{message.text}</p>}
      <Button variant="primary" className="w-full" disabled={busy}>
        {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
      </Button>
      <button type="button" className="w-full text-center text-xs text-muted hover:text-foreground" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
        {mode === "signin" ? "No account? Create one" : "Have an account? Sign in"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
