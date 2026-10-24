"use client";

import { useEffect, useRef, useState } from "react";
import { BellRingIcon, KeyRoundIcon, Loader2Icon, MailIcon, ShieldCheckIcon, XCircleIcon } from "lucide-react";
import { api, setApprovalHandler, type ApprovalNeed } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtIn } from "@/lib/num";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { Numpad } from "@/components/numpad";
import { Segmented } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/*
 * Asking a manager (REQ APR-01 … APR-04). When an action is above the user's limit, the API client calls this: a manager types
 * their PIN on this till, or the request goes to managers (phone, back office, head office) and this waits, live, for their answer.
 * Mounted once inside the app (needs the live connection).
 */

export type Approval = {
  id: string; branchId: string; branchCode: string; registerName: string | null; kind: ApprovalNeed["kind"]; orderId: string | null; orderNumber: number | null;
  amount: number; late: boolean; summary: string; reason: string | null; requestedByName: string; requestedAt: string;
  status: "pending" | "approved" | "rejected" | "cancelled" | "used"; via: "pin" | "remote" | "code" | null; decidedByName: string | null; decidedAt: string | null; note: string | null;
};

const money = (n: number) => fmtIn(n, 2);

export function approvalSummary(n: ApprovalNeed, currency: string): string {
  if (n.kind === "discount") return `Discount of ${n.amount}%`;
  if (n.kind === "cash_out") return `Cash out of ${currency} ${money(n.amount)}`;
  return `Refund of ${currency} ${money(n.amount)}${n.late ? " (outside the return window)" : ""}`;
}

type Pending = { need: ApprovalNeed; message: string; resolve: (id: string | null) => void };

export function ApprovalHost() {
  const { company } = useSession();
  const cur = company?.currency ?? "AED";
  const [req, setReq] = useState<Pending | null>(null);
  const [mode, setMode] = useState<"pin" | "remote" | "code">("pin");
  const [pin, setPin] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<Approval | null>(null);
  const reqRef = useRef<Pending | null>(null);
  const canCode = req?.need.kind === "discount" && !!req.need.orderId;

  useEffect(() => {
    setApprovalHandler((need, message) => new Promise((resolve) => {
      reqRef.current?.resolve(null);   // one at a time
      const p = { need, message, resolve };
      reqRef.current = p;
      setReq(p); setMode("pin"); setPin(""); setReason(""); setError(null); setWaiting(null);
    }));
    return () => setApprovalHandler(null);
  }, []);

  function finish(id: string | null) {
    reqRef.current?.resolve(id);
    reqRef.current = null;
    setReq(null);
  }

  function body(extra: object) {
    const n = req!.need;
    return { kind: n.kind, amount: n.amount, late: n.late, orderId: n.orderId, shiftId: n.shiftId, summary: approvalSummary(n, cur), reason: reason.trim() || null, ...extra };
  }

  async function withPin() {
    setBusy(true); setError(null);
    try {
      const a = await api<Approval>("/approvals", "POST", body({ pin }));
      finish(a.id);
    } catch (e) {
      setError((e as Error).message); setPin("");
    } finally { setBusy(false); }
  }

  // A code from a manager's approval email (a discount on an order): approves it here and now, like a PIN.
  async function withCode() {
    setBusy(true); setError(null);
    try {
      const a = await api<Approval>("/approvals", "POST", body({ code: pin }));
      finish(a.id);
    } catch (e) {
      setError((e as Error).message); setPin("");
    } finally { setBusy(false); }
  }

  async function sendRemote() {
    setBusy(true); setError(null);
    try { setWaiting(await api<Approval>("/approvals", "POST", body({}))); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  // Waiting for a manager: the live event re-reads it; a slow poll covers a missed event.
  async function check() {
    if (!waiting || waiting.status !== "pending") return;
    try {
      const a = await api<Approval>(`/approvals/${waiting.id}`);
      if (a.status === "approved") finish(a.id);
      else setWaiting(a);
    } catch { /* try again on the next tick */ }
  }
  useLiveEvent(["approvals.changed"], () => void check());
  useEffect(() => {
    if (!waiting || waiting.status !== "pending") return;
    const t = window.setInterval(() => void check(), 4000);
    return () => window.clearInterval(t);
  });

  async function cancel() {
    if (waiting?.status === "pending") await api(`/approvals/${waiting.id}/cancel`, "POST").catch(() => {});
    finish(null);
  }

  return (
    <Dialog open={!!req} onOpenChange={(o) => { if (!o) void cancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ShieldCheckIcon className="size-5 text-primary" /> Manager approval</DialogTitle>
          <DialogDescription>{req?.message}</DialogDescription>
        </DialogHeader>
        {req && (
          <div className="rounded-xl border bg-muted/40 px-4 py-3">
            <div className="text-xs text-muted-foreground">Asking for</div>
            <div className="font-heading text-lg font-semibold">{approvalSummary(req.need, cur)}</div>
          </div>
        )}

        {waiting ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            {waiting.status === "pending" ? <>
              <span className="relative flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
                <BellRingIcon className="size-6" /><span className="absolute inset-0 animate-ping rounded-full bg-primary/15" />
              </span>
              <div className="font-medium">Waiting for a manager…</div>
              <p className="text-sm text-muted-foreground">Managers see it on their phone or back office under Approvals. This carries on by itself once it&apos;s approved.</p>
            </> : <>
              <XCircleIcon className="size-12 text-danger" />
              <div className="font-medium">{waiting.status === "rejected" ? `Rejected by ${waiting.decidedByName}` : "No longer waiting"}</div>
              {waiting.note && <p className="text-sm text-muted-foreground">“{waiting.note}”</p>}
            </>}
          </div>
        ) : <>
          <Segmented id="approval-mode" value={mode} onChange={(m) => { setMode(m); setPin(""); setError(null); }} className="w-full"
            options={[{ value: "pin", label: "Manager here", icon: KeyRoundIcon }, { value: "remote", label: "Send to a manager", icon: BellRingIcon },
              ...(canCode ? [{ value: "code" as const, label: "Code", icon: MailIcon }] : [])]} />
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" className="h-11" />
          {mode === "code" ? <>
            <p className="text-sm text-muted-foreground">The 6-digit code from the manager&apos;s approval email. It works for this order, once, within 24 hours.</p>
            <div className="flex h-12 items-center justify-center rounded-xl border bg-card font-mono text-2xl tracking-[0.4em]" aria-label="Code">{pin || <span className="text-muted-foreground/40">······</span>}</div>
            <Numpad value={pin} onChange={setPin} decimals={0} max={6} onEnter={() => { if (!busy && pin.length === 6) void withCode(); }} />
          </> : mode === "pin" ? <>
            <div className="flex h-12 items-center justify-center gap-3 rounded-xl border bg-card" aria-label="PIN">
              {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => (
                <span key={i} className={cn("size-3 rounded-full transition-colors", i < pin.length ? "bg-foreground" : "bg-muted-foreground/25")} />
              ))}
            </div>
            <Numpad value={pin} onChange={setPin} decimals={0} max={8} onEnter={() => { if (!busy && pin.length >= 4) void withPin(); }} />
          </> : <p className="text-sm text-muted-foreground">The request goes to the managers of this branch and head office. You can keep this open while they answer.</p>}
          {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
        </>}

        <DialogFooter>
          <Button variant="outline" className="h-12" onClick={() => void cancel()}>{waiting && waiting.status !== "pending" ? "Close" : "Cancel"}</Button>
          {!waiting && (mode === "code"
            ? <Button className="h-12 min-w-36" disabled={busy || pin.length !== 6} onClick={() => void withCode()}>{busy ? <Loader2Icon className="animate-spin" /> : <MailIcon />} Approve</Button>
            : mode === "pin"
            ? <Button className="h-12 min-w-36" disabled={busy || pin.length < 4} onClick={() => void withPin()}>{busy ? <Loader2Icon className="animate-spin" /> : <KeyRoundIcon />} Approve</Button>
            : <Button className="h-12 min-w-36" disabled={busy} onClick={() => void sendRemote()}>{busy ? <Loader2Icon className="animate-spin" /> : <BellRingIcon />} Send request</Button>)}
          {waiting && waiting.status !== "pending" && <Button className="h-12" onClick={() => { setWaiting(null); setMode("pin"); }}>Ask again</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
