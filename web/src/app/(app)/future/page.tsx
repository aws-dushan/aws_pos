"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BanIcon, CalendarClockIcon, CheckIcon, ChefHatIcon, HandCoinsIcon, PencilIcon, PhoneIcon, PlusIcon, ReceiptTextIcon, ShoppingBasketIcon, StickyNoteIcon } from "lucide-react";
import { toast } from "sonner";
import { api, newKey, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtIn } from "@/lib/num";
import { collectLabel, type OrderDetail } from "@/lib/pos";
import { printNewTickets } from "@/lib/kitchen-print";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { confirmDialog, promptReason } from "@/components/confirm";
import { EmptyState, ErrorNote, Field, LoadingRows, ObjectStatus, PageHeader, Segmented, TONE } from "@/components/kit";
import { Stagger, StaggerItem } from "@/components/motion";
import { printOrderReceipt, ReceiptDialog } from "@/components/pos-payment";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type View = "today" | "tomorrow" | "overdue" | "open" | "done";
type Row = {
  id: string; futureRef: string | null; futureStatus: "waiting" | "collected" | "cancelled"; status: string; orderType: "takeaway" | "delivery";
  customerName: string | null; customerPhone: string | null; deliveryAddress: string | null; note: string | null; collectAt: string; collectDate: string;
  total: number; paid: number; due: number; items: number; unsent: number; readyAt: string | null; openedAt: string; openedByName: string | null; lockedBy: string | null;
};
type List = { today: string; counts: { today: number; tomorrow: number; overdue: number; open: number }; orders: Row[] };

const money = (n: number) => fmtIn(n, 2);
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Future orders: taken now with an advance, collected (and invoiced) on their day. */
export default function FutureOrdersPage() {
  const router = useRouter();
  const { company, branch } = useSession();
  const cur = company?.currency ?? "AED";
  const [view, setView] = useState<View>("today");
  const list = useApi<List>(`/future-orders?view=${view}`);
  useLiveEvent(["order.changed", "kitchen.changed"], () => list.reload());
  const [editing, setEditing] = useState<Row | "new" | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(r: Row, path: string, body?: unknown) {
    setBusy(r.id);
    try { return await api<OrderDetail>(path, "POST", body ?? {}, { key: newKey() }); }
    catch (e) { toast.error((e as Error).message); return null; }
    finally { setBusy(null); list.reload(); }
  }

  async function collect(r: Row) {
    if (!(await confirmDialog({
      title: `Collect ${r.futureRef}?`,
      message: r.due > 0 ? `${r.customerName}: advance ${cur} ${money(r.paid)} paid, ${cur} ${money(r.due)} left. The register takes the balance next.`
        : `${r.customerName}: paid in full (${cur} ${money(r.paid)}). The tax invoice prints now.`,
      confirmLabel: r.due > 0 ? "Collect and take balance" : "Hand over",
    }))) return;
    const d = await act(r, `/future-orders/${r.id}/collect`);
    if (!d) return;
    if (d.order.status === "paid") {
      const printed = await printOrderReceipt(d.order.id, false).catch((e: Error) => { toast.error(`Receipt not printed: ${e.message}`); return false; });
      toast.success(`${r.futureRef} handed over.`);
      if (!printed) setReceipt(d.order.id);
    } else router.push(`/register?order=${d.order.id}`);
  }

  async function cancel(r: Row) {
    const reason = await promptReason({
      title: `Cancel ${r.futureRef}?`, tone: "danger", confirmLabel: "Cancel order",
      message: r.paid > 0 ? `The advance of ${cur} ${money(r.paid)} goes back the way it was paid (cash from this drawer, a card back to the card). An advance from an earlier day needs a manager.` : "Nothing was paid on it.",
      reason: { label: "Reason", placeholder: "e.g. customer cancelled" },
    });
    if (!reason) return;
    if (await act(r, `/future-orders/${r.id}/cancel`, { reason })) toast.success(`${r.futureRef} cancelled.`);
  }

  async function send(r: Row) {
    const d = await act(r, `/orders/${r.id}/send`);
    if (d) { toast.success(`${r.unsent} item${r.unsent === 1 ? "" : "s"} sent to the kitchen`); void printNewTickets(d); }
  }

  const c = list.data?.counts;
  const rows = list.data?.orders ?? [];
  const views: { value: View; label: string }[] = [
    { value: "today", label: `Today${c?.today ? ` (${c.today})` : ""}` },
    { value: "tomorrow", label: `Tomorrow${c?.tomorrow ? ` (${c.tomorrow})` : ""}` },
    { value: "overdue", label: `Overdue${c?.overdue ? ` (${c.overdue})` : ""}` },
    { value: "open", label: `All open${c?.open ? ` (${c.open})` : ""}` },
    { value: "done", label: "Done" },
  ];

  return (
    <div className="mx-auto max-w-[1000px] pb-8">
      <PageHeader title="Future orders" icon={CalendarClockIcon} module="sales" count={c?.open ?? null}
        description="Taken now with an advance, collected on their day. The bill is invoiced when it's collected."
        actions={branch?.futureOrders ? <Button size="lg" onClick={() => setEditing("new")}><PlusIcon /> New future order</Button> : undefined} />
      <Segmented id="future-view" value={view} options={views} onChange={setView} className="mb-5 max-w-full overflow-x-auto" />
      <ErrorNote message={list.error} />

      {list.loading && !list.data ? <LoadingRows rows={4} /> : rows.length ? (
        <Stagger className="space-y-3">
          {rows.map((r) => {
            const waiting = r.futureStatus === "waiting";
            const late = waiting && list.data && r.collectDate < list.data.today;
            return (
              <StaggerItem key={r.id}>
                <div className={cn("surface flex flex-wrap items-center gap-4 p-4", !waiting && "opacity-70")}>
                  <div className="w-28">
                    <div className={cn("font-heading font-semibold tabular-nums", late && "text-danger")}>{collectLabel(r.collectAt)}</div>
                    <div className="font-mono text-xs text-muted-foreground">{r.futureRef}</div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{r.customerName}</span>
                      {r.futureStatus === "cancelled" ? <ObjectStatus className={TONE.struck}>Cancelled</ObjectStatus>
                        : r.futureStatus === "collected" ? (r.status === "refunded" ? <ObjectStatus className={TONE.violet}>Returned</ObjectStatus>
                          : <ObjectStatus className={TONE.done}>{r.status === "paid" ? "Collected" : "Collecting"}</ObjectStatus>)
                        : r.readyAt ? <ObjectStatus className={TONE.done}>Ready</ObjectStatus>
                        : late ? <ObjectStatus className={TONE.danger}>Overdue</ObjectStatus> : <ObjectStatus className={TONE.open}>Waiting</ObjectStatus>}
                      {r.orderType === "delivery" && <span className="text-xs text-muted-foreground">Delivery</span>}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-muted-foreground">
                      {r.customerPhone && <span className="inline-flex items-center gap-1"><PhoneIcon className="size-3.5" /> {r.customerPhone}</span>}
                      <span>{r.items} item{r.items === 1 ? "" : "s"} · {cur} {money(r.total)}</span>
                      <span className={r.paid > 0 ? "text-success" : undefined}>Advance {money(r.paid)}</span>
                      {waiting && <span className={cn(r.due > 0 && "font-medium text-foreground")}>{r.due > 0 ? `Balance ${money(r.due)}` : "Paid in full"}</span>}
                      {r.note && <span className="inline-flex items-center gap-1 text-foreground"><StickyNoteIcon className="size-3.5" /> {r.note}</span>}
                      {r.lockedBy && <span className="text-warning">Open on {r.lockedBy}</span>}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {waiting && <>
                      <Button className="h-11" disabled={busy === r.id || r.items === 0} onClick={() => void collect(r)}><HandCoinsIcon /> Collect</Button>
                      <Button variant="outline" className="h-11" onClick={() => router.push(`/register?order=${r.id}`)}><ShoppingBasketIcon /> Items &amp; advance</Button>
                      {branch?.kitchenEnabled && r.unsent > 0 && <Button variant="outline" className="h-11" disabled={busy === r.id} onClick={() => void send(r)}><ChefHatIcon /> Send ({r.unsent})</Button>}
                      <Button variant="outline" className="h-11" disabled={busy === r.id} onClick={() => void act(r, `/future-orders/${r.id}/ready`)}>
                        <CheckIcon /> {r.readyAt ? "Not ready" : "Ready"}
                      </Button>
                      <Button variant="ghost" className="h-11" aria-label="Change" onClick={() => setEditing(r)}><PencilIcon /></Button>
                      <Button variant="ghost" className="h-11" aria-label="Cancel" onClick={() => void cancel(r)}><BanIcon /></Button>
                    </>}
                    {r.futureStatus !== "cancelled" && <Button variant="ghost" className="h-11" aria-label="Receipt" onClick={() => setReceipt(r.id)}><ReceiptTextIcon /></Button>}
                    {r.futureStatus === "collected" && r.status === "open" && <Button className="h-11" onClick={() => router.push(`/register?order=${r.id}`)}>Take balance</Button>}
                  </div>
                </div>
              </StaggerItem>
            );
          })}
        </Stagger>
      ) : (
        <EmptyState icon={CalendarClockIcon} title={view === "done" ? "Nothing collected or cancelled lately" : "No future orders here"} module="sales"
          action={branch?.futureOrders && view !== "done" ? <Button size="lg" onClick={() => setEditing("new")}><PlusIcon /> New future order</Button> : undefined}>
          {branch?.futureOrders ? "Take an order for a later day: the customer, when they collect, the items and an advance." : "Future orders are switched off for this branch (Companies & branches)."}
        </EmptyState>
      )}

      <FutureDialog value={editing} onClose={() => setEditing(null)}
        onSaved={(d) => { setEditing(null); list.reload(); if (d) router.push(`/register?order=${d.order.id}`); }} />
      <ReceiptDialog orderId={receipt} onClose={() => setReceipt(null)} />
    </div>
  );
}

/** A new future order (who, takeaway or delivery, when it's collected, a note), or another collection time / note. */
function FutureDialog({ value, onClose, onSaved }: { value: Row | "new" | null; onClose: () => void; onSaved: (created: OrderDetail | null) => void }) {
  const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); return ymd(d); };
  const blank = { name: "", phone: "", type: "takeaway" as "takeaway" | "delivery", address: "", date: tomorrow(), time: "16:00", note: "" };
  const [f, setF] = useState(blank);
  const [seen, setSeen] = useState<Row | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  if (value !== seen) {
    setSeen(value);
    if (value === "new") setF({ ...blank, date: tomorrow() });
    else if (value) {
      const at = new Date(value.collectAt);
      setF({ ...blank, name: value.customerName ?? "", phone: value.customerPhone ?? "", type: value.orderType, address: value.deliveryAddress ?? "",
        date: ymd(at), time: at.toTimeString().slice(0, 5), note: value.note ?? "" });
    }
  }
  const slots = Array.from({ length: 4 * 24 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`);
  const isNew = value === "new";

  async function save() {
    setBusy(true);
    try {
      const collectAt = new Date(`${f.date}T${f.time}:00`).toISOString();
      if (isNew) {
        const d = await api<OrderDetail>("/future-orders", "POST", { type: f.type, customerName: f.name, customerPhone: f.phone, deliveryAddress: f.address || null, collectAt, note: f.note || null }, { key: newKey() });
        toast.success(`Future order ${d.order.futureRef} made: add the items and take the advance.`);
        onSaved(d);
      } else {
        await api(`/future-orders/${value!.id}`, "PUT", { collectAt, note: f.note }, { key: newKey() });
        toast.success("Changed.");
        onSaved(null);
      }
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Dialog open={!!value} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{isNew ? "New future order" : `Change ${typeof value === "object" && value ? value.futureRef : ""}`}</DialogTitle>
          <DialogDescription>{isNew ? "Next: the items and the advance, on the register." : "Another collection time, or the note."}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          {isNew && <>
            <Field label="Customer name" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} className="h-11" /></Field>
            <Field label="Phone" required><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} inputMode="tel" className="h-11" /></Field>
            <Field label="Collected or delivered" span>
              <Segmented id="future-type" value={f.type} onChange={(v) => setF({ ...f, type: v })}
                options={[{ value: "takeaway", label: "Collected" }, { value: "delivery", label: "Delivered" }]} />
            </Field>
            {f.type === "delivery" && <Field label="Delivery address" required span><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} className="h-11" /></Field>}
          </>}
          <Field label="Date"><Input type="date" value={f.date} min={ymd(new Date())} onChange={(e) => setF({ ...f, date: e.target.value })} className="h-11" /></Field>
          <Field label="Time">
            <select value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} className="h-11 w-full rounded-lg border border-input bg-card px-2 text-sm">
              {slots.map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Note" hint="e.g. the writing on the cake" span><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} className="h-11" /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" className="h-11" onClick={onClose}>Cancel</Button>
          <Button className="h-11 min-w-36" disabled={busy || (isNew && (!f.name.trim() || !f.phone.trim() || (f.type === "delivery" && !f.address.trim()))) || !f.date}
            onClick={() => void save()}>{isNew ? "Next: items" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
