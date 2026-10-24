"use client";

import { useEffect, useState } from "react";
import { AlarmClockIcon, Loader2Icon, TimerResetIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { useNow } from "@/lib/hooks";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import type { DayInfo } from "@/components/shift";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/**
 * The automatic day close, on every register of the branch: 10 minutes before, a strip says when the day closes; at closing time
 * a minute's countdown, which anyone on a shift can delay (customers still waiting) or end with "Close now". When it closes the
 * tills lock to the PIN pad (AppShell, "day.autoclosed").
 */
export function DayClosing() {
  const { branch, can } = useSession();
  const on = !!branch && can("day.shift");
  const info = useApi<DayInfo>(on ? "/day" : null);
  useLiveEvent(["day.changed"], () => info.reload());
  // A till that missed an event (asleep, offline a moment) catches up within a minute.
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => info.reload(), 60_000);
    return () => window.clearInterval(t);
  }, [on, info]);
  const now = useNow(1000);
  const [busy, setBusy] = useState<"delay" | "close" | null>(null);
  const d = info.data;
  if (!on || !now || !d?.day || !d.registerId || !d.closesAt) return null;

  async function act(kind: "delay" | "close") {
    setBusy(kind);
    try {
      if (kind === "delay") {
        const r = await api<{ delayedUntil: string }>("/day/delay-close", "POST");
        toast.success(`Closing waits until ${hhmm(r.delayedUntil)}.`);
      } else await api("/day/close-now", "POST");
      info.reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (d.closingAt) {
    const secs = Math.max(0, Math.ceil((Date.parse(d.closingAt) - now.getTime()) / 1000));
    return (
      <Dialog open onOpenChange={() => {}}>
        <DialogContent showCloseButton={false} className="sm:max-w-md" data-module="appr">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><AlarmClockIcon className="size-5 text-warning" /> The day is closing</DialogTitle>
            <DialogDescription>
              Every till of {branch!.name} locks when the count ends, and shifts still open close without a count. Orders still open carry to the next day.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2 text-center font-heading text-6xl font-semibold tabular-nums" aria-live="polite">
            {secs > 0 ? `0:${String(secs).padStart(2, "0")}` : <span className="inline-flex items-center gap-3 text-3xl"><Loader2Icon className="size-7 animate-spin" /> Closing…</span>}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button className="h-14" disabled={!d.canDelay || !!busy} onClick={() => void act("delay")}>
              {busy === "delay" ? <Loader2Icon className="animate-spin" /> : <TimerResetIcon />} Customers waiting: {d.delayStep} min
            </Button>
            <Button variant="outline" className="h-14" disabled={!!busy} onClick={() => void act("close")}>
              {busy === "close" && <Loader2Icon className="animate-spin" />} Close now
            </Button>
          </div>
          {!d.canDelay && <p className="text-center text-xs text-muted-foreground">Closing can&apos;t wait any longer{d.delayedMinutes ? ` (already delayed ${d.delayedMinutes} min)` : ""}.</p>}
        </DialogContent>
      </Dialog>
    );
  }

  const mins = Math.ceil((Date.parse(d.closesAt) - now.getTime()) / 60_000);
  if (mins > 10 || mins <= 0) return null;
  return (
    <div role="status" className="sticky top-14 z-20 mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-sm text-warning backdrop-blur animate-rise-in">
      <AlarmClockIcon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 font-medium">
        The day closes at {hhmm(d.closesAt)} (in {mins} min{mins === 1 ? "" : "s"}). Finish open orders and close your shift.
      </span>
      {d.canDelay && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void act("delay")}><TimerResetIcon /> Wait {d.delayStep} min more</Button>}
    </div>
  );
}
