"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArmchairIcon, BikeIcon, ChefHatIcon, ChevronLeftIcon, EllipsisIcon, HandPlatterIcon, MinusIcon, PlusIcon, ReceiptTextIcon,
  ShoppingBagIcon, ShoppingBasketIcon, StickyNoteIcon, Trash2Icon, UsersRoundIcon, UtensilsCrossedIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { openOrderOn, usePos, usePosState } from "@/prototype/store";
import { money, orderTotals } from "@/prototype/totals";
import { attempt, EmptyState, ObjectStatus, PageHeader, SearchField, Segmented, TONE } from "@/components/kit";
import { CountUp, EASE, motionOff, Stagger, StaggerItem } from "@/components/motion";
import { ModuleIcon, type ModuleKey } from "@/components/modules";
import { PaymentDialog, ReceiptDialog } from "@/prototype/payment";
import { confirmDialog } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { MenuItem, Order, OrderType } from "@/prototype/types";

export default function RegisterPage() {
  return <Suspense fallback={null}><Register /></Suspense>;
}

/** The order the register shows right now (module level, so a StrictMode remount doesn't discard it). */
let activeOrder: string | null = null;

function Register() {
  const s = usePosState();
  const pos = usePos();
  const router = useRouter();
  const params = useSearchParams();
  const orderId = params.get("order");
  const order = orderId ? s.orders.find((o) => o.id === orderId) : undefined;
  const handled = useRef<string | null>(null);

  // ?new=takeaway|delivery (or 1: the default quick type) and ?table=<id> start an order, then the URL names it.
  useEffect(() => {
    const key = params.toString();
    if (handled.current === key) return;
    const fresh = params.get("new");
    const table = params.get("table");
    if (!fresh && !table) return;
    handled.current = key;
    let id = "";
    const type: OrderType = table ? "dine-in" : fresh === "takeaway" || fresh === "delivery" ? fresh : s.settings.defaultQuickType;
    if (attempt(() => { id = pos.openOrder(type, { tableId: table ?? undefined }); })) router.replace(`/register?order=${id}`);
    else router.replace("/register");
  }, [params, pos, router, s.settings.defaultQuickType]);

  // Leaving an order nothing was added to removes it again (and frees its table).
  useEffect(() => {
    if (!orderId) return;
    activeOrder = orderId;
    return () => {
      activeOrder = null;
      window.setTimeout(() => { if (activeOrder !== orderId) pos.discardIfEmpty(orderId); }, 60);
    };
  }, [orderId, pos]);

  if (params.get("new") || params.get("table")) return null;
  if (!order || order.status !== "open") return <StartPanel closed={order} />;
  return <OrderScreen key={order.id} order={order} />;
}

/* ------------------------------------------------------------------ start */

function StartPanel({ closed }: { closed?: Order }) {
  const s = usePosState();
  const open = s.orders.filter((o) => o.status === "open").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const starts: { label: string; hint: string; href: string; icon: React.ComponentType<{ className?: string }>; module: ModuleKey }[] = [
    ...(s.settings.tableService ? [{ label: "Dine-in", hint: "Pick a table on the floor", href: "/floor", icon: ArmchairIcon, module: "sales" as const }] : []),
    { label: "Takeaway", hint: "Counter order, ticket number", href: "/register?new=takeaway", icon: ShoppingBagIcon, module: "fin" },
    { label: "Delivery", hint: "Name and phone for the rider", href: "/register?new=delivery", icon: BikeIcon, module: "bank" },
  ];
  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader title="Register" icon={ShoppingBasketIcon} module="fin"
        description={closed ? `Order #${closed.number} is ${closed.status === "paid" ? "paid" : "voided"}. Start the next one.` : "Start an order or pick up an open one."} />
      <Stagger className={cn("grid gap-4", starts.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
        {starts.map((a) => (
          <StaggerItem key={a.label}>
            <Link href={a.href} data-module={a.module} className="group surface card-lift flex items-center gap-4 p-5">
              <ModuleIcon module={a.module} icon={a.icon} size="lg" solid className="hover-hop" />
              <span>
                <span className="block font-heading text-base font-semibold">{a.label}</span>
                <span className="block text-xs text-muted-foreground">{a.hint}</span>
              </span>
            </Link>
          </StaggerItem>
        ))}
      </Stagger>
      <h2 className="mt-8 mb-3 font-heading text-[0.95rem] font-semibold">Open orders <span className="ml-1 rounded-full bg-muted px-2 text-xs text-muted-foreground tabular-nums">{open.length}</span></h2>
      {open.length ? (
        <Stagger className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {open.map((o) => {
            const table = o.tableId ? s.tables.find((t) => t.id === o.tableId) : undefined;
            const t = orderTotals(o, s.settings);
            return (
              <StaggerItem key={o.id}>
                <Link href={`/register?order=${o.id}`} className="surface card-lift flex items-center gap-3 p-4">
                  <ModuleIcon module={o.type === "dine-in" ? "sales" : o.type === "delivery" ? "bank" : "fin"} icon={o.type === "dine-in" ? ArmchairIcon : o.type === "delivery" ? BikeIcon : ShoppingBagIcon} size="md" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{table ? `Table ${table.name}` : o.customerName || (o.type === "delivery" ? "Delivery" : "Takeaway")} <span className="font-mono text-xs text-muted-foreground">#{o.number}</span></div>
                    <div className="text-xs text-muted-foreground">{t.items} items{o.billRequested ? " · bill asked" : ""}</div>
                  </div>
                  <span className="text-sm font-semibold tabular-nums">{money(t.total)}</span>
                </Link>
              </StaggerItem>
            );
          })}
        </Stagger>
      ) : <p className="surface px-5 py-8 text-center text-sm text-muted-foreground">No open orders.</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ order */

function OrderScreen({ order }: { order: Order }) {
  const s = usePosState();
  const pos = usePos();
  const router = useRouter();
  const [cat, setCat] = useState<string>("all");
  const [q, setQ] = useState("");
  const [paying, setPaying] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [pickTable, setPickTable] = useState<null | "move" | "dine-in">(null);
  const search = useRef<HTMLInputElement>(null);
  const cur = s.settings.currency;
  const t = orderTotals(order, s.settings);
  const unsent = order.lines.reduce((n, l) => n + l.qty - l.sentQty, 0);
  const table = order.tableId ? s.tables.find((x) => x.id === order.tableId) : undefined;

  const term = q.trim().toLowerCase();
  const items = s.items.filter((i) => (cat === "all" || i.categoryId === cat) && (!term || i.name.toLowerCase().includes(term)));
  const qtyOf = (id: string) => order.lines.filter((l) => l.itemId === id).reduce((n, l) => n + l.qty, 0);

  function send() {
    let n = 0;
    if (attempt(() => { n = pos.sendToKitchen(order.id); })) toast.success(`${n} item${n === 1 ? "" : "s"} sent to the kitchen`, { icon: <ChefHatIcon className="size-4" /> });
  }
  function openPay() {
    if (!order.lines.length) return toast.error("Add something to the order first.");
    if (unsent) send();   // anything not yet sent goes to the kitchen with the payment
    setPaying(true);
  }
  async function voidIt() {
    if (!(await confirmDialog({ title: `Void order #${order.number}?`, message: "Its kitchen tickets are withdrawn and the table is freed. This can't be undone.", confirmLabel: "Void order", tone: "danger" }))) return;
    if (attempt(() => pos.voidOrder(order.id))) { toast.success(`Order #${order.number} voided`); router.push(order.type === "dine-in" && s.settings.tableService ? "/floor" : "/register"); }
  }

  // Keys: "/" search, F8 send, F9 pay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest?.("input,textarea,select");
      if (e.key === "/" && !typing) { e.preventDefault(); search.current?.focus(); }
      if (e.key === "F8") { e.preventDefault(); document.querySelector<HTMLButtonElement>("[data-shortcut=send]")?.click(); }
      if (e.key === "F9") { e.preventDefault(); document.querySelector<HTMLButtonElement>("[data-shortcut=pay]")?.click(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const types: { value: OrderType; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    ...(s.settings.tableService ? [{ value: "dine-in" as const, label: "Dine-in", icon: ArmchairIcon }] : []),
    { value: "takeaway", label: "Takeaway", icon: ShoppingBagIcon },
    { value: "delivery", label: "Delivery", icon: BikeIcon },
  ];

  return (
    <div className="grid gap-4 py-3 lg:h-[calc(100dvh-3.5rem)] lg:grid-cols-[minmax(0,1fr)_400px] xl:grid-cols-[minmax(0,1fr)_440px]">
      {/* Menu */}
      <section className="flex min-h-0 flex-col gap-3" aria-label="Menu">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="icon-lg" aria-label="Back" render={<Link href={order.type === "dine-in" && s.settings.tableService ? "/floor" : "/register"} />}><ChevronLeftIcon /></Button>
          <SearchField ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the menu  ( / )" className="min-w-48 flex-1 [&_input]:h-9" />
        </div>
        <div role="tablist" aria-label="Categories" className="scrollbar-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
          {[{ id: "all", name: "All", tone: "home" as const }, ...s.categories].map((c) => {
            const on = cat === c.id;
            return (
              <button key={c.id} type="button" role="tab" aria-selected={on} data-module={c.tone} onClick={() => setCat(c.id)}
                className={cn("relative flex h-9 shrink-0 items-center gap-2 rounded-xl px-3.5 text-[0.8125rem] font-medium transition-colors", on ? "text-white" : "border bg-card text-muted-foreground hover:text-foreground")}>
                {on && <motion.span layoutId="cat-pill" className="absolute inset-0 rounded-xl bg-mod-grad shadow-[0_6px_14px_-6px_var(--mod)]" transition={{ type: "spring", stiffness: 420, damping: 30 }} />}
                {!on && c.id !== "all" && <span className="relative size-2 rounded-full bg-mod" />}
                <span className="relative">{c.name}</span>
              </button>
            );
          })}
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto pr-1">
          {items.length ? (
            <motion.div key={cat + term} className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
              initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: 0.02 } } }}>
              {items.map((i) => <ItemCard key={i.id} item={i} qty={qtyOf(i.id)} currency={cur} tone={s.categories.find((c) => c.id === i.categoryId)?.tone ?? "fin"} onAdd={() => attempt(() => pos.addItem(order.id, i))} />)}
            </motion.div>
          ) : <EmptyState compact icon={UtensilsCrossedIcon} title="Nothing matches" module="inv">Try another word or category.</EmptyState>}
        </div>
      </section>

      {/* Ticket */}
      <section data-module="fin" className="surface flex min-h-[28rem] flex-col overflow-hidden lg:min-h-0" aria-label="Order">
        <div className="space-y-3 border-b p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h2 className="font-heading text-base font-semibold">Order <span className="font-mono text-sm text-muted-foreground">#{order.number}</span></h2>
              {order.billRequested ? <ObjectStatus className={TONE.warn}>Bill asked</ObjectStatus> : <ObjectStatus className={TONE.open}>Open</ObjectStatus>}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="More"><EllipsisIcon /></Button>} />
              <DropdownMenuContent align="end" className="w-52">
                {order.type === "dine-in" && <DropdownMenuItem onClick={() => setPickTable("move")}><ArmchairIcon className="size-4" /> Move to another table</DropdownMenuItem>}
                <DropdownMenuItem onClick={() => router.push("/register")}><PlusIcon className="size-4" /> Park &amp; start another</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={voidIt} className="text-danger"><Trash2Icon className="size-4" /> Void order</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <Segmented id="order-type" value={order.type} className="w-full" options={types}
            onChange={(v) => { if (v === "dine-in") setPickTable("dine-in"); else attempt(() => pos.setOrderType(order.id, v)); }} />
          {order.type === "dine-in" ? (
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setPickTable("move")} className="flex h-9 flex-1 items-center gap-2 rounded-lg border bg-card px-3 text-sm transition-colors hover:bg-muted">
                <ArmchairIcon className="size-4 text-mod-sales" /> <span className="font-medium">Table {table?.name ?? "–"}</span>
                <span className="ml-auto text-xs text-muted-foreground">change</span>
              </button>
              <div className="flex h-9 items-center rounded-lg border bg-card">
                <button type="button" aria-label="Fewer guests" className="flex size-9 items-center justify-center text-muted-foreground hover:text-foreground" onClick={() => pos.setOrder(order.id, { guests: Math.max(1, (order.guests ?? 1) - 1) })}><MinusIcon className="size-3.5" /></button>
                <span className="flex min-w-12 items-center justify-center gap-1 text-sm font-medium tabular-nums"><UsersRoundIcon className="size-3.5 text-muted-foreground" />{order.guests ?? "–"}</span>
                <button type="button" aria-label="More guests" className="flex size-9 items-center justify-center text-muted-foreground hover:text-foreground" onClick={() => pos.setOrder(order.id, { guests: (order.guests ?? 0) + 1 })}><PlusIcon className="size-3.5" /></button>
              </div>
            </div>
          ) : (
            <input value={order.customerName ?? ""} onChange={(e) => pos.setOrder(order.id, { customerName: e.target.value })}
              placeholder={order.type === "delivery" ? "Customer name / phone" : "Customer name (optional)"}
              className="h-9 w-full rounded-lg border border-input bg-card px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 dark:bg-input/30" />
          )}
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
          {order.lines.length ? (
            <ul className="divide-y">
              <AnimatePresence initial={false}>
                {order.lines.map((l) => <LineRow key={l.id} order={order} lineId={l.id} />)}
              </AnimatePresence>
            </ul>
          ) : (
            <EmptyState compact icon={HandPlatterIcon} title="Nothing on the order yet" module="fin">Tap items on the left to add them.</EmptyState>
          )}
        </div>

        <div className="space-y-3 border-t bg-muted/40 p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">Discount</span>
            <Segmented id="discount" size="sm" value={String(order.discountPct)} onChange={(v) => pos.setOrder(order.id, { discountPct: Number(v) })}
              options={[0, 5, 10, 15, 20].map((p) => ({ value: String(p), label: p ? `${p}%` : "None" }))} />
          </div>
          <div className="space-y-1 text-sm">
            <Row label="Subtotal" value={money(t.subtotal)} />
            {t.discount > 0 && <Row label={`Discount ${order.discountPct}%`} value={`−${money(t.discount)}`} className="text-success" />}
            {t.service > 0 && <Row label={`Service charge ${s.settings.serviceChargeRate}%`} value={money(t.service)} />}
            <Row label={`VAT ${s.settings.vatRate}%${s.settings.vatInclusive ? " (included)" : ""}`} value={money(t.vat)} muted />
            {t.paid > 0 && <Row label="Paid so far" value={`−${money(t.paid)}`} className="text-success" />}
            <div className="flex items-baseline justify-between border-t pt-2">
              <span className="font-heading font-semibold">{t.paid > 0 ? "Left to pay" : "Total"}</span>
              <span className="font-heading text-2xl font-semibold tracking-tight"><span className="mr-1 text-xs font-medium text-muted-foreground">{cur}</span><CountUp value={t.due} format={money} duration={0.35} /></span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" size="lg" className="h-11" data-shortcut="send" disabled={!unsent} onClick={send} title="Send to kitchen (F8)">
              <ChefHatIcon /> Send{unsent ? ` (${unsent})` : ""}
            </Button>
            {order.type === "dine-in" ? (
              <Button variant={order.billRequested ? "secondary" : "outline"} size="lg" className="h-11" disabled={!order.lines.length}
                onClick={() => { pos.setOrder(order.id, { billRequested: !order.billRequested }); if (!order.billRequested) setReceipt(order.id); }}>
                <ReceiptTextIcon /> {order.billRequested ? "Bill printed" : "Print bill"}
              </Button>
            ) : (
              <Button variant="outline" size="lg" className="h-11" onClick={() => router.push("/register")}><PlusIcon /> Park</Button>
            )}
            <Button size="lg" data-shortcut="pay" className="col-span-2 h-12 text-base" disabled={!order.lines.length} onClick={openPay} title="Pay (F9)">
              Pay {cur} {money(t.due)}
            </Button>
          </div>
        </div>
      </section>

      <PaymentDialog order={order} open={paying} onOpenChange={setPaying}
        onPaid={(o) => { setPaying(false); setReceipt(o.id); }} />
      <ReceiptDialog orderId={receipt} onClose={() => {
        setReceipt(null);
        const done = s.orders.find((o) => o.id === order.id)?.status === "paid";
        if (done) router.push(order.type === "dine-in" && s.settings.tableService ? "/floor" : "/register");
      }} />
      <TablePicker mode={pickTable} order={order} onClose={() => setPickTable(null)} />
    </div>
  );
}

function Row({ label, value, className, muted }: { label: string; value: string; className?: string; muted?: boolean }) {
  return (
    <div className={cn("flex justify-between", muted && "text-muted-foreground", className)}>
      <span>{label}</span><span className="tabular-nums">{value}</span>
    </div>
  );
}

/** A menu item tile: tap to add; the count already on the order pops on each tap. */
function ItemCard({ item, qty, currency, tone, onAdd }: { item: MenuItem; qty: number; currency: string; tone: ModuleKey; onAdd: () => void }) {
  const initials = item.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <motion.button type="button" data-module={tone} disabled={!item.available} onClick={onAdd}
      variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.22, ease: EASE } } }}
      className="group surface relative flex min-h-[6.5rem] flex-col items-start gap-2 p-3 text-left transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-lift active:scale-[0.96] disabled:pointer-events-none disabled:opacity-45">
      <span className="hover-hop flex size-9 items-center justify-center rounded-xl bg-mod-grad font-heading text-xs font-semibold text-white shadow-[0_6px_14px_-6px_var(--mod)]">{initials}</span>
      <span className="line-clamp-2 text-[0.8125rem] leading-snug font-medium">{item.name}</span>
      <span className="mt-auto text-xs text-muted-foreground tabular-nums">{item.available ? <>{currency} <span className="font-semibold text-foreground">{money(item.price)}</span></> : "Sold out"}</span>
      {qty > 0 && (
        <span key={qty} className="relmap-label-pop absolute top-2.5 right-2.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground shadow-soft tabular-nums">{qty}</span>
      )}
    </motion.button>
  );
}

/** One order line: quantity stepper, a kitchen note, and whether it went to the kitchen. Slides in and out. */
function LineRow({ order, lineId }: { order: Order; lineId: string }) {
  const pos = usePos();
  const l = order.lines.find((x) => x.id === lineId)!;
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState(l.note ?? "");
  const sentAll = l.sentQty >= l.qty;
  const animate = !motionOff();
  return (
    <motion.li layout={animate ? "position" : false}
      initial={animate ? { opacity: 0, x: 16 } : false} animate={{ opacity: 1, x: 0 }} exit={animate ? { opacity: 0, x: -16, transition: { duration: 0.15 } } : undefined}
      transition={{ duration: 0.22, ease: EASE }} className="px-4 py-2.5">
      <div className="flex items-start gap-3">
        <div className="flex h-8 shrink-0 items-center rounded-lg border bg-card">
          <button type="button" aria-label={`One less ${l.name}`} onClick={() => attempt(() => pos.changeQty(order.id, l.id, -1))} className="flex size-8 items-center justify-center text-muted-foreground hover:text-foreground">
            {l.qty === 1 && !l.sentQty ? <Trash2Icon className="size-3.5" /> : <MinusIcon className="size-3.5" />}
          </button>
          <span key={l.qty} className="animate-rise-in w-6 text-center text-sm font-semibold tabular-nums">{l.qty}</span>
          <button type="button" aria-label={`One more ${l.name}`} onClick={() => attempt(() => pos.changeQty(order.id, l.id, 1))} className="flex size-8 items-center justify-center text-muted-foreground hover:text-foreground"><PlusIcon className="size-3.5" /></button>
        </div>
        <div className="min-w-0 flex-1 pt-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm leading-tight font-medium">{l.name}</span>
            <span className="text-sm font-medium tabular-nums">{money(l.price * l.qty)}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="tabular-nums">{money(l.price)} each</span>
            {l.sentQty > 0 && <ObjectStatus className={TONE.done} icon={ChefHatIcon}>{sentAll ? "Sent" : `${l.sentQty} sent · ${l.qty - l.sentQty} new`}</ObjectStatus>}
            {l.note && !noting && <span className="rounded bg-warning/12 px-1.5 text-warning">“{l.note}”</span>}
            {!sentAll && !noting && (
              <button type="button" onClick={() => setNoting(true)} className="inline-flex items-center gap-1 hover:text-foreground"><StickyNoteIcon className="size-3" />{l.note ? "Edit note" : "Note"}</button>
            )}
          </div>
          {noting && (
            <form className="mt-1.5 flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (attempt(() => pos.setLineNote(order.id, l.id, note))) setNoting(false); }}>
              <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. no onions, extra spicy"
                className="h-7 min-w-0 flex-1 rounded-md border bg-card px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40" />
              <Button size="sm" type="submit">Save</Button>
            </form>
          )}
        </div>
      </div>
    </motion.li>
  );
}

/** Pick a table: to make the order dine-in, or to move it. Busy tables can't be picked. */
function TablePicker({ mode, order, onClose }: { mode: null | "move" | "dine-in"; order: Order; onClose: () => void }) {
  const s = usePosState();
  const pos = usePos();
  function pick(id: string) {
    const ok = attempt(() => (mode === "dine-in" ? pos.setOrderType(order.id, "dine-in", id) : pos.moveTable(order.id, id)));
    if (ok) { onClose(); toast.success(`Order #${order.number} is now on table ${s.tables.find((t) => t.id === id)?.name}`); }
  }
  return (
    <Dialog open={!!mode} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === "dine-in" ? "Seat this order at a table" : "Move to another table"}</DialogTitle>
          <DialogDescription>Free tables can be picked; busy ones show their order.</DialogDescription>
        </DialogHeader>
        {s.floors.map((f) => {
          const list = s.tables.filter((t) => t.floorId === f.id);
          if (!list.length) return null;
          return (
            <div key={f.id}>
              <div className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{f.name}</div>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                {list.map((t) => {
                  const other = openOrderOn(s, t.id);
                  const mine = other?.id === order.id;
                  const busy = !!other && !mine;
                  return (
                    <button key={t.id} type="button" disabled={busy || mine} onClick={() => pick(t.id)} data-module={busy ? "fin" : "sales"}
                      className={cn("flex h-16 flex-col items-center justify-center rounded-xl border text-sm font-semibold transition-[transform,background-color] active:scale-[0.96]",
                        mine ? "border-primary bg-primary/10 text-primary" : busy ? "bg-mod-grad text-white opacity-60" : "border-mod/40 bg-card hover:bg-mod/8")}>
                      {t.name}
                      <span className="text-[0.68rem] font-normal opacity-75">{mine ? "this order" : busy ? `#${other!.number}` : `${t.seats} seats`}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </DialogContent>
    </Dialog>
  );
}
