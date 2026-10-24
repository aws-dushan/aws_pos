"use client";

import { useState } from "react";
import { KeyRoundIcon } from "lucide-react";
import { api } from "@/lib/api";
import { withBase } from "@/lib/base-path";
import { Field } from "@/components/kit";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Signed in with a password someone else set (the first administrator of a new server, or one an administrator gave): the app stays
 * closed until its owner chooses their own. The server refuses everything else for this session meanwhile.
 */
export function FirstPasswordScreen({ name, onDone }: { name: string; onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (next !== again) { setError("The two new passwords are not the same."); return; }
    setBusy(true);
    setError(null);
    try {
      await api("/me/password", "POST", { current, next });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function signOut() {
    await api("/auth/logout", "POST").catch(() => {});
    window.location.href = withBase("/login");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <form onSubmit={save} className="grid w-full max-w-sm gap-4 rounded-3xl border bg-card p-6 shadow-pop">
        <Logo className="h-9" />
        <div className="grid gap-1">
          <h1 className="flex items-center gap-2 text-lg font-semibold"><KeyRoundIcon className="size-5" /> Choose your own password</h1>
          <p className="text-sm text-muted-foreground">Welcome, {name}. This password was set for you, so change it before you start.</p>
        </div>
        <Field label="Current password"><Input type="password" autoComplete="current-password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field label="New password" hint="At least 8 characters, letters and digits."><Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <Field label="New password again"><Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="h-11" disabled={busy || !current || !next || !again}>Change password and continue</Button>
        <Button type="button" variant="ghost" onClick={() => void signOut()}>Sign out</Button>
      </form>
    </main>
  );
}
