"use client";

import { useMemo, useState } from "react";
import { FileTextIcon, MinusIcon, NotebookPenIcon, PlusIcon, PrinterIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtIn } from "@/lib/num";
import { withBase } from "@/lib/base-path";
import { fmtQty, noPrice, priceOf, type Menu, type MenuItem, type OrderDetail, type OrderType } from "@/lib/pos";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { EmptyState, ErrorNote, Field, PageHeader, SearchField, Segmented, TablePanel } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const money = (n: number) => fmtIn(n, 2);
type Line = { item: MenuItem; qty: string; price: string };
type Entered = { id: string; number: number; slipNo: string; at: string; businessDate: string; total: number; invoiceNo: string | null; status: string };

/** Local date-time for an <input type="datetime-local">. */
const localNow = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

/**
 * Paper fallback (REQ ONL-04): print numbered blank order pads ahead of time; after an outage, key each written slip in.
 * It becomes a paid order of today's business day with a tax invoice number.
 */
export default function PaperPage() {
  const { company, branch } = useSession();
  const cur = company?.currency ?? "AED";
  const menu = useApi<Menu>("/pos/menu");
  const entered = useApi<Entered[]>("/orders/paper");
  useLiveEvent(["order.changed"], () => entered.reload());

  const [padFrom, setPadFrom] = useState("1");
  const [padCount, setPadCount] = useState("20");
  const [slip, setSlip] = useState("");
  const [at, setAt] = useState(localNow);
  const [type, setType] = useState<OrderType>("takeaway");
  const [lines, setLines] = useState<Line[]>([]);
  const [discount, setDiscount] = useState("0");
  const [method, setMethod] = useState<"cash" | "card" | "other">("cash");
  const [reference, setReference] = useState("");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);

  const found = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return (menu.data?.items ?? []).filter((i) => i.name.toLowerCase().includes(t) || (i.erpItemCode ?? "").toLowerCase().includes(t)).slice(0, 8);
  }, [menu.data, q]);
  // The total as the slip should show it (prices include VAT); the server works it out exactly and refuses a mismatch.
  const subtotal = lines.reduce((t, l) => t + Number(l.qty || 0) * Number(l.price || 0), 0);
  const total = Math.round(subtotal * (1 - Number(discount || 0) / 100) * 100) / 100;

  function add(i: MenuItem) {
    setLines((ls) => ls.some((l) => l.item.id === i.id)
      ? ls.map((l) => (l.item.id === i.id ? { ...l, qty: fmtQty(Number(l.qty || 0) + 1) } : l))
      : [...ls, { item: i, qty: "1", price: noPrice(i) ? "" : String(priceOf(i)) }]);
    setQ("");
  }

  async function save() {
    setBusy(true);
    try {
      const d = await api<OrderDetail>("/orders/paper", "POST", {
        slipNo: slip, at: new Date(at).toISOString(), type, discountPct: Number(discount || 0),
        lines: lines.map((l) => ({ itemId: l.item.id, qty: Number(l.qty), unitPrice: noPrice(l.item) ? Number(l.price) : null })),
        payments: [{ method, amount: total, reference: reference || null }],
      });
      toast.success(`Slip ${slip} entered as order #${d.order.number} · ${d.order.invoiceNo}`);
      setSlip(String(Number(slip) + 1 || "")); setLines([]); setDiscount("0"); setReference(""); entered.reload();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-[1180px] pb-8">
      <PageHeader title="Paper sales" icon={NotebookPenIcon} module="bank"
        description={`If ${branch?.name ?? "the branch"} can't reach One POS, orders are written on numbered pads. Key each slip in here once it's back.`} />
      <ErrorNote message={menu.error} />

      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_280px] lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* Enter a slip */}
        <section className="surface p-5">
          <h2 className="mb-4 font-heading font-semibold">Enter a paper slip</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Slip number" required><Input value={slip} onChange={(e) => setSlip(e.target.value)} placeholder="e.g. 0007" className="h-11" /></Field>
            <Field label="Date and time on the slip"><Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className="h-11" /></Field>
            <Field label="Order type">
              <Segmented id="paper-type" value={type} onChange={setType} className="w-full"
                options={[...(branch?.tableService ? [{ value: "dine_in" as const, label: "Dine-in" }] : []), { value: "takeaway" as const, label: "Takeaway" }, { value: "delivery" as const, label: "Delivery" }]} />
            </Field>
          </div>

          <div className="relative mt-5">
            <SearchField value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an item by name or code to add it" className="w-full" />
            {found.length > 0 && (
              <div className="absolute inset-x-0 top-full z-10 mt-1 overflow-hidden rounded-xl border bg-popover shadow-lg">
                {found.map((i) => (
                  <button key={i.id} type="button" onClick={() => add(i)} className="flex h-11 w-full items-center justify-between gap-3 px-4 text-left text-sm hover:bg-muted">
                    <span className="truncate">{i.name}{i.erpItemCode && <span className="ml-2 font-mono text-xs text-muted-foreground">{i.erpItemCode}</span>}</span>
                    <span className="tabular-nums text-muted-foreground">{noPrice(i) ? "no price" : money(priceOf(i))}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {lines.length ? (
            <div className="mt-4 divide-y rounded-xl border">
              {lines.map((l, idx) => (
                <div key={l.item.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{l.item.name}</span>
                  <div className="flex items-center rounded-lg border">
                    <button type="button" aria-label="Less" className="flex size-10 items-center justify-center text-muted-foreground"
                      onClick={() => setLines(lines.map((x, j) => (j === idx ? { ...x, qty: fmtQty(Math.max(0, Number(x.qty || 0) - 1)) } : x)))}><MinusIcon className="size-4" /></button>
                    <Input value={l.qty} onChange={(e) => setLines(lines.map((x, j) => (j === idx ? { ...x, qty: e.target.value.replace(/[^\d.]/g, "") } : x)))}
                      inputMode="decimal" aria-label="Quantity" className="h-10 w-16 border-0 text-center shadow-none" />
                    <button type="button" aria-label="More" className="flex size-10 items-center justify-center text-muted-foreground"
                      onClick={() => setLines(lines.map((x, j) => (j === idx ? { ...x, qty: fmtQty(Number(x.qty || 0) + 1) } : x)))}><PlusIcon className="size-4" /></button>
                  </div>
                  {noPrice(l.item)
                    ? <Input value={l.price} onChange={(e) => setLines(lines.map((x, j) => (j === idx ? { ...x, price: e.target.value.replace(/[^\d.]/g, "") } : x)))}
                        inputMode="decimal" placeholder="Price on slip" className="h-10 w-28" />
                    : <span className="w-20 text-right text-sm text-muted-foreground tabular-nums">{money(Number(l.price))}</span>}
                  <span className="w-24 text-right font-medium tabular-nums">{money(Number(l.qty || 0) * Number(l.price || 0))}</span>
                  <Button variant="ghost" size="icon" aria-label={`Remove ${l.item.name}`} onClick={() => setLines(lines.filter((_, j) => j !== idx))}><Trash2Icon /></Button>
                </div>
              ))}
            </div>
          ) : <p className="mt-4 rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">Add the items written on the slip.</p>}

          <div className="mt-5 grid gap-4 sm:grid-cols-[8rem_1fr_1fr]">
            <Field label="Discount %"><Input value={discount} onChange={(e) => setDiscount(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" className="h-11" /></Field>
            <Field label="Paid by">
              <Segmented id="paper-method" value={method} onChange={setMethod} className="w-full" options={[{ value: "cash", label: "Cash" }, { value: "card", label: "Card" }, { value: "other", label: "Other" }]} />
            </Field>
            <Field label="Card or other reference"><Input value={reference} onChange={(e) => setReference(e.target.value)} disabled={method === "cash"} className="h-11" /></Field>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <div>
              <div className="text-xs text-muted-foreground">Total on the slip</div>
              <div className="font-heading text-2xl font-semibold tabular-nums"><span className="mr-1 text-sm text-muted-foreground">{cur}</span>{money(total)}</div>
            </div>
            <Button className="h-12 min-w-44" disabled={busy || !slip.trim() || !lines.length || lines.some((l) => !(Number(l.qty) > 0) || !(Number(l.price) > 0))} onClick={() => void save()}>
              <FileTextIcon /> Enter slip
            </Button>
          </div>
        </section>

        {/* Pads */}
        <aside className="space-y-5">
          <section className="surface p-5">
            <h2 className="font-heading font-semibold">Blank order pads</h2>
            <p className="mt-1 text-sm text-muted-foreground">Print numbered slips to keep at the till for outages, four to a page.</p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <Field label="First number"><Input value={padFrom} onChange={(e) => setPadFrom(e.target.value.replace(/\D/g, ""))} inputMode="numeric" className="h-11" /></Field>
              <Field label="How many"><Input value={padCount} onChange={(e) => setPadCount(e.target.value.replace(/\D/g, ""))} inputMode="numeric" className="h-11" /></Field>
            </div>
            <Button variant="outline" className="mt-4 h-11 w-full" disabled={!(Number(padCount) > 0)}
              onClick={() => window.open(withBase(`/paper/pad?from=${Number(padFrom) || 1}&count=${Math.min(200, Number(padCount))}&company=${encodeURIComponent(company?.name ?? "")}&branch=${encodeURIComponent(branch?.name ?? "")}&code=${encodeURIComponent(branch?.code ?? "")}`), "_blank")}>
              <PrinterIcon /> Print pads
            </Button>
          </section>
        </aside>
      </div>

      <h2 className="mt-8 mb-2 font-heading font-semibold">Slips entered</h2>
      {entered.data?.length ? (
        <TablePanel>
          <Table>
            <TableHeader><TableRow>
              <TableHead className="pl-5">Slip</TableHead><TableHead>Written</TableHead><TableHead>Order</TableHead><TableHead>Tax invoice</TableHead><TableHead className="pr-5 text-right">Total</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {entered.data.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="pl-5 font-mono">{e.slipNo}</TableCell>
                  <TableCell className="text-muted-foreground">{new Date(e.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</TableCell>
                  <TableCell>#{e.number} <span className="text-xs text-muted-foreground">· day {new Date(e.businessDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span></TableCell>
                  <TableCell className={cn("font-mono text-xs", e.status !== "paid" && "text-muted-foreground")}>{e.invoiceNo}</TableCell>
                  <TableCell className="pr-5 text-right tabular-nums">{money(e.total)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TablePanel>
      ) : <EmptyState compact icon={NotebookPenIcon} title="No paper slips entered" module="bank">Slips keyed in after an outage are listed here.</EmptyState>}
    </div>
  );
}
