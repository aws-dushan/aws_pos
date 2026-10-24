"use client";

import { useState } from "react";
import { CalendarCheck2Icon, CalendarClockIcon, CalendarX2Icon, CheckIcon, FileTextIcon, LandmarkIcon, LockOpenIcon, ReceiptIcon, ScaleIcon, UsersIcon, WalletIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtIn } from "@/lib/num";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { confirmDialog, promptReason } from "@/components/confirm";
import { EmptyState, ErrorNote, LoadingRows, ObjectStatus, PageHeader, StatTile, TablePanel, TONE } from "@/components/kit";
import { Stagger, StaggerItem } from "@/components/motion";
import { MyShiftCard } from "@/components/my-shift";
import {
  CashMoveDialog, CloseShiftDialog, dayReportLines, OpenShiftDialog, ReportDialog, SHIFT_STATUS, shiftReportLines,
  type DayInfo, type ShiftReport, type ShiftStatus,
} from "@/components/shift";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Field } from "@/components/kit";
import type { ReceiptLine } from "@/lib/device";

const money = (n: number) => fmtIn(n, 2);
const SHIFT_TONE: Record<ShiftStatus, string> = { open: TONE.open, closed: TONE.done, needs_approval: TONE.warn, not_counted: TONE.danger };
const CONTROL = { manual: "Manual: a manager opens and closes the day", automatic: "Automatic", cashier: "Cashier-run: cashiers may open and close the day" };
const fmtDate = (d: string) => new Date(d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const fmtTime = (d: string | null) => (d ? new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "—");

/** Business day and shifts (REQ DAY-01 … DAY-10): open / close the day, my shift on this till, approvals, deposits, Z reports. */
export default function DayPage() {
  const { company, branch } = useSession();
  const cur = company?.currency ?? "AED";
  const info = useApi<DayInfo>("/day");
  useLiveEvent(["day.changed", "order.changed"], () => info.reload());
  const [opening, setOpening] = useState(false);
  const [moving, setMoving] = useState<string | null>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [report, setReport] = useState<ReceiptLine[] | null>(null);
  const [deposit, setDeposit] = useState(false);
  const title = `${company?.name ?? ""} · ${branch?.code ?? ""}`;
  const d = info.data;

  async function act(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); toast.success(ok); info.reload(); } catch (e) { toast.error((e as Error).message); }
  }
  async function showShift(id: string) {
    try { setReport(shiftReportLines(await api<ShiftReport>(`/shifts/${id}/report`), title)); } catch (e) { toast.error((e as Error).message); }
  }
  async function closeDay() {
    if (!d?.report) return;
    const open = d.report.openOrders.count;
    const ok = await confirmDialog({
      title: `Close ${fmtDate(d.day!.date)}?`, confirmLabel: "Close the day",
      message: <div className="space-y-2 text-sm">
        <p>The Z report is kept and the day locks. Selling continues in the next business day.</p>
        {open > 0 && <p className="text-warning">{open} order{open === 1 ? " is" : "s are"} still open ({cur} {money(d.report.openOrders.value)}). {d.openOrdersAtClose === "carry" ? "They carry over to the next day." : "Those never sent to the kitchen are voided; the rest carry over."}</p>}
      </div>,
    });
    if (!ok) return;
    try {
      const z = await api<DayInfo["report"]>("/day/close", "POST");
      toast.success("Day closed");
      info.reload();
      if (z) setReport(dayReportLines(z, title));
    } catch (e) { toast.error((e as Error).message); }
  }
  async function approve(id: string, who: string) {
    const note = await promptReason({ title: `Approve ${who}'s variance?`, confirmLabel: "Approve", reason: { label: "Note", placeholder: "What was found when counting again" } });
    if (note) await act(() => api(`/shifts/${id}/approve`, "POST", { note }), "Variance approved");
  }


  return (
    <div className="mx-auto max-w-[1180px] pb-8">
      <PageHeader title="Day & shifts" icon={CalendarClockIcon} module="appr"
        description={d ? `${CONTROL[d.dayControl]}${d.dayControl === "automatic" ? `: opens ${d.autoOpen}, closes ${d.autoClose}` : ""}.` : "The business day, shifts and cash counts."}
        actions={d?.canManage && (d.day
          ? <Button variant="outline" className="h-11" onClick={() => void closeDay()}><CalendarX2Icon /> Close the day</Button>
          : <Button className="h-11" onClick={() => void act(() => api("/day/open", "POST"), "Day open")}><CalendarCheck2Icon /> Open the day</Button>)} />
      <ErrorNote message={info.error} />
      {!d ? <LoadingRows rows={5} /> : (
        <Stagger className="space-y-5">
          {/* The day */}
          <StaggerItem>
            <div data-module="appr" className="surface flex flex-wrap items-center gap-4 p-5">
              <span className={cn("flex size-12 items-center justify-center rounded-2xl text-white", d.day ? "bg-mod-grad" : "bg-muted-foreground/40")}>
                {d.day ? <CalendarCheck2Icon className="size-6" /> : <CalendarX2Icon className="size-6" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-heading text-lg font-semibold">{d.day ? `Business day ${fmtDate(d.day.date)}` : "The day isn't open"}</div>
                <div className="text-sm text-muted-foreground">
                  {d.day ? `Opened ${fmtTime(d.day.openedAt)} by ${d.day.openedByName ?? "the system"}${d.day.reopened ? ` · reopened ${d.day.reopened}×` : ""}`
                    : d.dayControl === "manual" ? "A manager opens it to start selling." : d.dayControl === "automatic" ? `It opens at ${d.autoOpen}, or with the first sale.` : "It opens with the first shift or sale."}
                </div>
              </div>
              {d.day && <ObjectStatus className={TONE.open}>Open</ObjectStatus>}
            </div>
          </StaggerItem>

          {/* My shift */}
          <StaggerItem><MyShiftCard /></StaggerItem>

          {/* Waiting for approval */}
          {d.pending.length > 0 && (
            <StaggerItem>
              <div className="surface border-warning/40 p-5">
                <h2 className="mb-3 font-heading font-semibold text-warning">Variances waiting for approval</h2>
                <div className="space-y-2">
                  {d.pending.map((s) => (
                    <div key={s.id} className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{s.userName} · {s.registerName}</div>
                        <div className="text-xs text-muted-foreground">Expected {money(s.expectedCash ?? 0)}, counted {money(s.countedCash ?? 0)}{s.note ? ` · “${s.note}”` : ""}</div>
                      </div>
                      <span className={cn("font-heading font-semibold tabular-nums", (s.variance ?? 0) < 0 ? "text-danger" : "text-success")}>{(s.variance ?? 0) > 0 ? "+" : ""}{money(s.variance ?? 0)}</span>
                      <Button variant="outline" className="h-10" onClick={() => void showShift(s.id)}>Report</Button>
                      {d.canManage && <Button className="h-10" onClick={() => void approve(s.id, s.userName)}><CheckIcon /> Approve</Button>}
                    </div>
                  ))}
                </div>
              </div>
            </StaggerItem>
          )}

          {/* Today's figures */}
          {d.report && (
            <StaggerItem>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <StatTile module="fin" icon={ReceiptIcon} label="Sales" value={`${cur} ${money(d.report.sales.gross)}`} hint={`${d.report.sales.orders} orders · VAT ${money(d.report.sales.vat)}`} />
                <StatTile module="bank" icon={WalletIcon} label="Net sales" value={`${cur} ${money(d.report.netSales)}`} hint={`after ${d.report.refunds.count} credit note${d.report.refunds.count === 1 ? "" : "s"}`} />
                <StatTile module="sales" icon={UsersIcon} label="Open orders" value={d.report.openOrders.count} hint={`${cur} ${money(d.report.openOrders.value)} not paid yet`} />
                <StatTile module="appr" icon={ScaleIcon} label="Cash variance" value={money(d.report.variance)} tone={d.report.variance < 0 ? "danger" : "default"} hint={`tolerance ±${money(d.tolerance)} per shift`} />
              </div>
            </StaggerItem>
          )}

          {/* Shifts */}
          {d.day && (
            <StaggerItem>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="font-heading font-semibold">Shifts today</h2>
                <div className="flex gap-2">
                  {d.report && <Button variant="outline" className="h-10" onClick={() => setReport(dayReportLines(d.report!, title))}><FileTextIcon /> Day X report</Button>}
                  {d.canDeposit && <Button variant="outline" className="h-10" onClick={() => setDeposit(true)}><LandmarkIcon /> Bank deposit</Button>}
                </div>
              </div>
              {d.shifts.length ? (
                <TablePanel>
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead className="pl-5">Register</TableHead><TableHead>Cashier</TableHead><TableHead>Hours</TableHead>
                      <TableHead className="text-right">Float</TableHead><TableHead className="text-right">Expected</TableHead><TableHead className="text-right">Counted</TableHead>
                      <TableHead className="text-right">Variance</TableHead><TableHead>Status</TableHead><TableHead className="pr-5" />
                    </TableRow></TableHeader>
                    <TableBody>
                      {d.shifts.map((s) => (
                        <TableRow key={s.id}>
                          <TableCell className="pl-5 font-medium">{s.registerName}</TableCell>
                          <TableCell>{s.userName}</TableCell>
                          <TableCell className="tabular-nums text-muted-foreground">{fmtTime(s.openedAt)} – {s.closedAt ? fmtTime(s.closedAt) : "now"}</TableCell>
                          <TableCell className="text-right tabular-nums">{money(s.openingFloat)}</TableCell>
                          <TableCell className="text-right tabular-nums">{s.expectedCash === null ? "—" : money(s.expectedCash)}</TableCell>
                          <TableCell className="text-right tabular-nums">{s.countedCash === null ? "—" : money(s.countedCash)}</TableCell>
                          <TableCell className={cn("text-right tabular-nums", (s.variance ?? 0) < 0 && "text-danger")}>{s.variance === null ? "—" : money(s.variance)}</TableCell>
                          <TableCell><ObjectStatus className={SHIFT_TONE[s.status]}>{SHIFT_STATUS[s.status]}</ObjectStatus></TableCell>
                          <TableCell className="pr-5 text-right">
                            <Button variant="ghost" size="sm" onClick={() => void showShift(s.id)}>{s.status === "open" ? "X" : "Z"} report</Button>
                            {s.status === "open" && d.canManage && s.id !== d.myShiftId && <Button variant="ghost" size="sm" onClick={() => setClosing(s.id)}>Close</Button>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TablePanel>
              ) : <p className="surface px-5 py-8 text-center text-sm text-muted-foreground">No shifts yet today.</p>}
            </StaggerItem>
          )}

          {/* Closed days */}
          <StaggerItem>
            <h2 className="mb-2 font-heading font-semibold">Closed days</h2>
            {d.recent.length ? (
              <TablePanel>
                <Table>
                  <TableHeader><TableRow>
                    <TableHead className="pl-5">Day</TableHead><TableHead>Closed</TableHead><TableHead className="text-right">Orders</TableHead>
                    <TableHead className="text-right">Net sales</TableHead>
                    <TableHead className="text-right">Float</TableHead><TableHead className="text-right">Expected</TableHead><TableHead className="text-right">Counted</TableHead>
                    <TableHead className="text-right">Variance</TableHead><TableHead className="pr-5">Z report</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {d.recent.map((r, i) => (
                      <TableRow key={r.id}>
                        <TableCell className="pl-5 font-medium">{fmtDate(r.date)}{r.reopened > 0 && <span className="ml-2 text-xs text-muted-foreground">reopened {r.reopened}×</span>}</TableCell>
                        <TableCell className="text-muted-foreground">{fmtTime(r.closedAt)} · {r.closedByName ?? "automatically"}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.z?.sales.orders ?? "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.z ? money(r.z.netSales) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.z?.cash ? money(r.z.cash.openingFloat) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.z?.cash ? money(r.z.cash.expected) : "—"}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.z?.cash ? money(r.z.cash.counted) : "—"}{r.z?.cash?.uncounted ? <span className="ml-1 text-xs text-warning">({r.z.cash.uncounted} not counted)</span> : null}</TableCell>
                        <TableCell className={cn("text-right tabular-nums", (r.z?.variance ?? 0) < 0 && "text-danger")}>{r.z ? money(r.z.variance) : "—"}</TableCell>
                        <TableCell className="pr-5 text-right">
                          {/* A closed day's kept report is its Z (days closed before 24 Oct kept "open" in it). */}
                          {r.z && <Button variant="ghost" size="sm" onClick={() => setReport(dayReportLines({ ...r.z!, status: "closed" }, title))}>Z report</Button>}
                          {i === 0 && !d.day && d.canReopen && (
                            <Button variant="ghost" size="sm" onClick={() => void confirmDialog({ title: `Reopen ${fmtDate(r.date)}?`, message: "Sales go into it again until it's closed. This is recorded.", confirmLabel: "Reopen" })
                              .then((ok) => { if (ok) void act(() => api(`/day/${r.id}/reopen`, "POST"), "Day reopened"); })}><LockOpenIcon /> Reopen</Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TablePanel>
            ) : <EmptyState compact icon={CalendarClockIcon} title="No closed days yet">Each closed day keeps its Z report here.</EmptyState>}
          </StaggerItem>
        </Stagger>
      )}

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
      <DepositDialog open={deposit} currency={cur} onClose={() => setDeposit(false)} onDone={() => { setDeposit(false); info.reload(); }} />
      <ReportDialog lines={report} onClose={() => setReport(null)} />
    </div>
  );
}

function DepositDialog({ open, currency, onClose, onDone }: { open: boolean; currency: string; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ amount: "", bagNo: "", takenBy: "" });
  async function submit() {
    try {
      await api("/day/deposits", "POST", { amount: Number(f.amount), bagNo: f.bagNo, takenBy: f.takenBy });
      toast.success("Deposit recorded");
      setF({ amount: "", bagNo: "", takenBy: "" });
      onDone();
    } catch (e) { toast.error((e as Error).message); }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Bank deposit</DialogTitle><DialogDescription>Cash leaving the branch for the bank, with its bag number.</DialogDescription></DialogHeader>
        <div className="grid gap-3">
          <Field label={`Amount (${currency})`}><Input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d.]/g, "") })} inputMode="decimal" className="h-11" /></Field>
          <Field label="Bag or slip number"><Input value={f.bagNo} onChange={(e) => setF({ ...f, bagNo: e.target.value })} className="h-11" /></Field>
          <Field label="Taken by"><Input value={f.takenBy} onChange={(e) => setF({ ...f, takenBy: e.target.value })} placeholder="Name or cash-in-transit company" className="h-11" /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" className="h-11" onClick={onClose}>Cancel</Button>
          <Button className="h-11" disabled={!(Number(f.amount) > 0) || !f.takenBy.trim()} onClick={() => void submit()}>Record deposit</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
