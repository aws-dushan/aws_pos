"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { motion, useAnimationControls } from "motion/react";
import { ArrowRightIcon, DeleteIcon, Loader2Icon, MonitorSmartphoneIcon, StoreIcon } from "lucide-react";
import { api } from "@/lib/api";
import { useNow, useStored } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { LOCK_NOTE_KEY, TILL_KEY, TILL_REGISTER_KEY } from "@/components/session";
import { motionOff } from "@/components/motion";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/logo";

type BranchInfo = { id: string; name: string; code: string; companyName: string; registers: { id: string; name: string }[] };

/**
 * The till's PIN pad (REQ USR-01). A manager sets a browser up as a till for a branch once (user menu › "Use this device as a till");
 * from then on cashiers sign in here with their PIN. Keyboard digits, Backspace and Enter work too.
 */
export default function TillPage() {
  const router = useRouter();
  const branchId = useStored(TILL_KEY);
  const registerId = useStored(TILL_REGISTER_KEY);
  const now = useNow(10000);
  const [branch, setBranch] = useState<BranchInfo | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Locked by itself (the day closed): why, until the next sign-in.
  const [cleared, setCleared] = useState(false);
  const stored = useSyncExternalStore(() => () => {}, () => { try { return sessionStorage.getItem(LOCK_NOTE_KEY); } catch { return null; } }, () => null);
  const note = cleared ? null : stored;
  const shake = useAnimationControls();
  // The digits so far, kept in a ref too: taps faster than a render (a quick cashier) each count.
  const typed = useRef("");

  useEffect(() => {
    if (branchId) api<BranchInfo>(`/auth/branch/${branchId}`).then(setBranch).catch((e: Error) => setError(e.message));
  }, [branchId]);

  const submit = useCallback(async (value: string) => {
    if (!branchId || value.length < 4 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/auth/pin", "POST", { branchId, pin: value, registerId });
      try { sessionStorage.removeItem(LOCK_NOTE_KEY); } catch { /* storage unavailable */ }
      setCleared(true);
      router.replace("/");
    } catch (e) {
      setError((e as Error).message);
      typed.current = "";
      setPin("");
      setBusy(false);
      if (!motionOff()) void shake.start({ x: [0, -12, 10, -8, 6, -3, 0], transition: { duration: 0.42, ease: "easeOut" } });
    }
  }, [branchId, registerId, busy, router, shake]);

  const press = useCallback((k: string) => {
    if (busy) return;
    setError(null);
    const cur = typed.current;
    const next = k === "back" ? cur.slice(0, -1) : k === "clear" ? "" : cur.length < 6 ? cur + k : cur;
    typed.current = next;
    setPin(next);
    if (next.length === 6 && cur.length === 5) void submit(next);
  }, [busy, submit]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") press("back");
      else if (e.key === "Escape") press("clear");
      else if (e.key === "Enter") void submit(typed.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press, submit]);

  // Rendering on the server (or before the browser's storage is read): nothing yet.
  if (!now) return null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4 md:p-8">
      <div className="grid w-full max-w-[1080px] overflow-hidden rounded-[28px] border bg-card shadow-pop lg:grid-cols-[1.05fr_1fr]">
        <section className="relative hidden flex-col justify-between p-10 text-white lg:flex" style={{ background: "var(--hero)" }}>
          <Logo variant="full" tone="dark" className="h-14 self-start" />
          <div className="space-y-3">
            {branch ? (
              <>
                <div className="flex items-center gap-2 text-sm text-white/70"><StoreIcon className="size-4" /> {branch.companyName}</div>
                <h2 className="font-heading text-[2.6rem] leading-[1.1] font-semibold tracking-tight">{branch.name}</h2>
                <div className="font-mono text-sm text-white/60">{branch.code}{registerId && branch.registers.find((r) => r.id === registerId) ? ` · ${branch.registers.find((r) => r.id === registerId)!.name}` : ""}</div>
              </>
            ) : <h2 className="font-heading text-[2.4rem] leading-[1.15] font-light tracking-tight">Till sign-in</h2>}
          </div>
          <TillClock />
        </section>

        <section className="flex items-center justify-center px-6 py-12 sm:px-12">
          {!branchId ? (
            <div className="animate-rise-in w-full max-w-[380px] space-y-6 text-center">
              <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-mod-grad text-white shadow-[0_8px_20px_-8px_var(--primary)]"><MonitorSmartphoneIcon className="size-6" /></span>
              <div className="space-y-2">
                <h1 className="font-heading text-[1.6rem] leading-tight font-light tracking-tight">This device isn&apos;t a till yet.</h1>
                <p className="text-sm text-muted-foreground">A manager signs in once, picks the branch, and chooses <span className="font-medium text-foreground">Use this device as a till</span> in the user menu. Cashiers then sign in here with their PIN.</p>
              </div>
              <Button className="h-11 w-full rounded-xl" nativeButton={false} render={<Link href="/login" />}>Manager sign-in <ArrowRightIcon /></Button>
            </div>
          ) : (
            <div className="animate-rise-in w-full max-w-[340px] space-y-7">
              <div className="space-y-1.5 text-center">
                {note && <p role="status" className="mb-3 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-sm font-medium text-warning">{note}</p>}
                <h1 className="font-heading text-[1.7rem] leading-tight font-light tracking-tight">Enter your PIN</h1>
                <p className="text-sm text-muted-foreground lg:hidden">{branch ? `${branch.companyName} · ${branch.name}` : " "}</p>
              </div>

              <motion.div animate={shake} className="flex justify-center gap-3" aria-live="polite" aria-label={`${pin.length} digits entered`}>
                {Array.from({ length: 6 }, (_, i) => (
                  <span key={i} className={cn("size-3.5 rounded-full border-2 transition-all duration-150",
                    i < pin.length ? "scale-110 border-primary bg-primary" : i < 4 ? "border-muted-foreground/40" : "border-dashed border-muted-foreground/25")} />
                ))}
              </motion.div>

              <div className="grid grid-cols-3 gap-3">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"].map((k) => (
                  <button key={k} type="button" onClick={() => press(k)} disabled={busy}
                    aria-label={k === "back" ? "Delete last digit" : k === "clear" ? "Clear" : k}
                    className={cn("flex h-16 items-center justify-center rounded-2xl border bg-card font-heading text-2xl font-medium shadow-soft transition-[transform,background-color] duration-100 select-none hover:bg-muted active:scale-[0.94] disabled:opacity-60",
                      (k === "clear" || k === "back") && "text-base font-normal text-muted-foreground")}>
                    {k === "back" ? <DeleteIcon className="size-5" /> : k === "clear" ? "Clear" : k}
                  </button>
                ))}
              </div>

              {error && <p role="alert" className="animate-rise-in rounded-xl border border-danger/25 bg-danger/5 px-3 py-2 text-center text-sm text-danger">{error}</p>}
              <Button onClick={() => void submit(typed.current)} disabled={busy || pin.length < 4} className="h-12 w-full rounded-xl text-[0.95rem]">
                {busy ? <><Loader2Icon className="animate-spin" /> Signing in…</> : <>Sign in <ArrowRightIcon /></>}
              </Button>
              <Link href="/login" className="link-slide mx-auto block w-fit text-xs text-muted-foreground hover:text-foreground">Manager sign-in</Link>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function TillClock() {
  const now = useNow(10000);
  if (!now) return <div />;
  return (
    <div>
      <div className="font-heading text-5xl font-light tabular-nums">{now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</div>
      <div className="mt-1 text-sm text-white/60">{now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</div>
    </div>
  );
}
