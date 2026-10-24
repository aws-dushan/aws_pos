"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRightIcon, EyeIcon, EyeOffIcon, Grid3x3Icon, Loader2Icon } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Logo, PRODUCT } from "@/components/logo";

const input = "h-11 w-full rounded-xl border border-input bg-card px-3.5 text-[0.95rem] transition-[border-color,box-shadow] outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-4 focus-visible:ring-ring/15 dark:bg-input/30";

/** Back-office sign-in (managers, head office, administrators); the same page as AWS One's. Tills use the PIN pad (/till). */
export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = !!username && !!password;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/login", "POST", { username, password });
      router.replace("/");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4 md:p-8">
      <div className="grid w-full max-w-[1080px] overflow-hidden rounded-[28px] border bg-card shadow-pop lg:grid-cols-[1.05fr_1fr]">
        {/* Brand panel: one static gradient, the logo and the line, centred. */}
        <section className="relative hidden flex-col items-center justify-center gap-10 p-12 text-center text-white lg:flex" style={{ background: "var(--hero)" }}>
          <Logo variant="full" tone="dark" className="h-24 xl:h-28" />
          <h2 className="max-w-md font-heading text-[2.4rem] leading-[1.15] font-light tracking-tight text-balance">
            Every table, ticket and till <span className="font-semibold">across your branches.</span>
          </h2>
        </section>

        <section className="flex items-center justify-center px-6 py-14 sm:px-12">
          <form onSubmit={submit} className="animate-rise-in w-full max-w-[360px] space-y-7">
            <div className="lg:hidden">
              <Logo className="h-11" />
            </div>
            <div className="space-y-2">
              <h1 className="font-heading text-[1.9rem] leading-tight font-light tracking-tight">Welcome back.</h1>
              <p className="text-sm text-muted-foreground">Sign in with your {PRODUCT} account.</p>
            </div>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username" className="text-[0.8rem] text-foreground/80">Username</Label>
                <input id="username" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} className={input} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password" className="text-[0.8rem] text-foreground/80">Password</Label>
                <div className="relative">
                  <input id="password" type={showPassword ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
                    className={cn(input, "pr-11")} />
                  <button type="button" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? "Hide password" : "Show password"}
                    className="absolute top-1/2 right-2 -translate-y-1/2 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                    {showPassword ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
                  </button>
                </div>
              </div>
            </div>
            {error && <p role="alert" className="animate-rise-in rounded-xl border border-danger/25 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</p>}
            <Button type="submit" disabled={busy || !ready}
              className={cn("h-11 w-full rounded-xl text-[0.95rem]", ready && !busy && "shadow-[0_8px_24px_-10px_var(--primary)]")}>
              {busy ? <><Loader2Icon className="animate-spin" /> Signing in…</> : <>Sign in <ArrowRightIcon /></>}
            </Button>
            <Link href="/till" className="link-slide mx-auto flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
              <Grid3x3Icon className="size-4" /> Sign in at a till with a PIN
            </Link>
          </form>
        </section>
      </div>
    </main>
  );
}
