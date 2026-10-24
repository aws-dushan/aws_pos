"use client";

import { useEffect, useState } from "react";
import { BanknoteIcon, CalendarClockIcon, FileTextIcon, MonitorSmartphoneIcon, ScaleIcon, WalletIcon } from "lucide-react";
import { toast } from "sonner";
import { api, pickRegister, useApi } from "@/lib/api";
import { fmtIn } from "@/lib/num";
import type { ReceiptLine } from "@/lib/device";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { ModuleIcon } from "@/components/modules";
import { Button } from "@/components/ui/button";
import { CashMoveDialog, CloseShiftDialog, OpenShiftDialog, ReportDialog, shiftReportLines, type DayInfo, type ShiftReport } from "@/components/shift";

const money = (n: number) => fmtIn(n, 2);
const fmtTime = (d: string) => new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** The float count is offered by itself once per person, register and day on this device; after that the card's button. */
const asked = new Set<string>();

/** Where "Close my shift" (user menu, the lock reminder) sends the cashier: the Dashboard, with the count open. */
export const CLOSE_SHIFT_HREF = "/?close-shift=1";
const CLOSE_SHIFT_EVENT = "onepos:close-shift";
/** Opens the closing count: on the Dashboard already, the card hears it; otherwise it reads the address when it opens. */
export function goCloseShift(push: (href: string) => void) {
  push(CLOSE_SHIFT_HREF);
  window.dispatchEvent(new Event(CLOSE_SHIFT_EVENT));
}

/**
 * My shift (REQ DAY-03 … DAY-06), on the Dashboard, the Register and Day & shifts: on a back-office PC first the register I'm at,
 * then the float count to open the shift (offered by itself with `autoOpen`), and while it's open: X report, cash in / out /
 * drop and Close shift, always in view. No money is taken outside a shift on a register.
 */
export function MyShiftCard({ autoOpen = false, hideWhenOpen = false, className }: { autoOpen?: boolean; hideWhenOpen?: boolean; className?: string }) {
  const { me, company, branch, can, isTill } = useSession();
  const cur = company?.currency ?? "AED";
  const shifts = !!branch && can("day.shift");
  const info = useApi<DayInfo>(shifts ? "/day" : null);
  useLiveEvent(["day.changed"], () => info.reload());
  const d = info.data;
  const regs = useApi<{ id: string; code: string; name: string; isActive: boolean }[]>(shifts && !isTill && d && !d.registerId ? `/branches/${branch!.id}/registers` : null);
  const [opening, setOpening] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [report, setReport] = useState<ReceiptLine[] | null>(null);
  const mine = d?.shifts.find((s) => s.id === d.myShiftId) ?? null;
  const noDay = !!d && !d.day && d.dayControl === "manual";
  const title = `${company?.name ?? ""} · ${branch?.code ?? ""}`;

  // Signed in with no shift on this register: the float count comes up by itself (once).
  const autoKey = autoOpen && d?.registerId && !d.myShiftId && !noDay ? `${me.user.id}:${d.registerId}:${new Date().toDateString()}` : null;
  if (autoKey && !asked.has(autoKey)) {
    asked.add(autoKey);
    setOpening(true);
  }

  // "Close my shift" from the user menu or the lock reminder: the count opens here (arriving here, or already here).
  const [closeAsked, setCloseAsked] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("close-shift"));
  if (closeAsked && mine) {
    setCloseAsked(false);
    setClosing(mine.id);
  }
  useEffect(() => {
    if (!closeAsked && window.location.search.includes("close-shift")) window.history.replaceState(null, "", window.location.pathname);
  }, [closeAsked]);
  useEffect(() => {
    if (!mine) return;
    const open = () => { window.history.replaceState(null, "", window.location.pathname); setClosing(mine.id); };
    window.addEventListener(CLOSE_SHIFT_EVENT, open);
    return () => window.removeEventListener(CLOSE_SHIFT_EVENT, open);
  }, [mine]);

  async function showShift(id: string) {
    try { setReport(shiftReportLines(await api<ShiftReport>(`/shifts/${id}/report`), title)); } catch (e) { toast.error((e as Error).message); }
  }
  function choose(id: string | null) {
    pickRegister(branch!.id, id);
    info.reload();
  }

  if (!shifts || !d || (mine && hideWhenOpen)) return dialogs();

  let body: React.ReactNode;
  if (!d.registerId) {
    if (isTill) return dialogs();
    const active = regs.data?.filter((r) => r.isActive) ?? [];
    body = (
      <>
        <Head icon={MonitorSmartphoneIcon} title="Taking payments on this PC?" text={active.length || !regs.data
          ? "Pick the register you're at. Your shift and every payment count in its drawer."
          : "This branch has no register yet: a manager adds one from the user menu (top right) → Use this device as a till."} />
        <div className="flex flex-wrap gap-2">
          {active.map((r) => <Button key={r.id} variant="outline" className="h-12 min-w-32" onClick={() => choose(r.id)}><MonitorSmartphoneIcon /> {r.name}</Button>)}
        </div>
      </>
    );
  } else if (noDay) {
    body = (
      <>
        <Head icon={CalendarClockIcon} title="The business day isn't open" text="A manager opens it under Day & shifts. Payments can't be taken before that." />
        {d.canManage && <Button className="h-12" onClick={() => void api("/day/open", "POST").then(() => info.reload(), (e: Error) => toast.error(e.message))}>Open the day</Button>}
      </>
    );
  } else if (!mine) {
    body = (
      <>
        <Head icon={WalletIcon} title="Open your shift" text="Count the float in the drawer to start taking payments." />
        <div className="flex flex-wrap gap-2">
          {!isTill && <Button variant="ghost" className="h-12" onClick={() => choose(null)}>Other register</Button>}
          <Button className="h-12 min-w-40" onClick={() => setOpening(true)}><WalletIcon /> Open shift</Button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <Head icon={WalletIcon} title={mine.sharedDrawer ? "Shared drawer" : "My shift"}
          text={mine.sharedDrawer
            ? `${mine.registerName} · opened by ${mine.userName} at ${fmtTime(mine.openedAt)} · your payments are kept under your name`
            : `${mine.registerName} · since ${fmtTime(mine.openedAt)} · float ${cur} ${money(mine.openingFloat)}`} />
        <div className="grid w-full grid-cols-3 gap-2 sm:w-auto">
          <Button variant="outline" className="h-12" onClick={() => void showShift(mine.id)}><FileTextIcon /> X report</Button>
          <Button variant="outline" className="h-12" onClick={() => setMoving(mine.id)}><BanknoteIcon /> Cash in / out</Button>
          <Button className="h-12" onClick={() => setClosing(mine.id)}><ScaleIcon /> Close shift</Button>
        </div>
      </>
    );
  }

  return (
    <>
      <div data-module={noDay ? "appr" : "fin"} className={`surface flex flex-wrap items-center gap-4 p-4 animate-rise-in ${className ?? ""}`}>{body}</div>
      {dialogs()}
    </>
  );

  function dialogs() {
    return (
      <>
        <OpenShiftDialog open={opening} defaultFloat={d?.defaultFloat ?? 0} currency={cur} onClose={() => setOpening(false)} onDone={() => { setOpening(false); info.reload(); }} />
        <CashMoveDialog shiftId={moving} currency={cur} onClose={() => setMoving(null)} onDone={() => { setMoving(null); info.reload(); }} />
        <CloseShiftDialog shiftId={closing} currency={cur} onClose={() => setClosing(null)}
          onDone={(r) => {
            setClosing(null); info.reload();
            const v = r.shift.variance ?? 0;
            if (r.shift.status === "needs_approval") toast.warning(`Variance ${money(v)}: a manager needs to approve it.`);
            else toast.success(v === 0 ? "Shift closed. The drawer balances." : `Shift closed. Variance ${money(v)}.`);
            setReport(shiftReportLines(r, title));
          }} />
        <ReportDialog lines={report} onClose={() => setReport(null)} />
      </>
    );
  }
}

function Head({ icon, title, text }: { icon: React.ComponentType<{ className?: string }>; title: string; text: string }) {
  return (
    <>
      <ModuleIcon module="fin" icon={icon} size="lg" solid />
      <div className="min-w-0 flex-1">
        <div className="font-heading font-semibold">{title}</div>
        <div className="text-sm text-muted-foreground">{text}</div>
      </div>
    </>
  );
}
