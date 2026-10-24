"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  ArmchairIcon, BikeIcon, CombineIcon, LockIcon, MonitorIcon, SplitIcon, ChefHatIcon, ChevronLeftIcon, EllipsisIcon, HandPlatterIcon, Loader2Icon, MinusIcon, PlusIcon, ReceiptTextIcon,
  SearchIcon, ShoppingBagIcon, ShoppingBasketIcon, StickyNoteIcon, Trash2Icon, UsersRoundIcon, UtensilsCrossedIcon, XIcon, InboxIcon, ChevronUpIcon, PencilIcon, UserRoundIcon, PercentIcon, TagIcon } from "lucide-react";
import { toast } from "sonner";
import { api, newKey, useApi } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { shortcutTitle } from "@/lib/shortcuts";
import { DiscountDialog, PlatformOfferDialog } from "@/components/discount-dialog";
import { fmtIn } from "@/lib/num";
import { byWeight, fmtQty, imageUrl, orderNo, initials, noPrice, orderLabel, priceOf, withPlatformPrices, type FloorData, type Menu, type MenuItem, type ModifierGroup, type Order, type OrderDetail, type OrderLine, type OrderType, type ShortStock } from "@/lib/pos";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { EmptyState, ObjectStatus, PageHeader, Segmented, TONE } from "@/components/kit";
import { CountUp, EASE, motionOff, Stagger, StaggerItem } from "@/components/motion";
import { ModuleIcon, type ModuleKey } from "@/components/modules";
import { confirmDialog } from "@/components/confirm";
import { PaymentDialog, ReceiptDialog } from "@/components/pos-payment";
import { Button } from "@/components/ui/button";
import { Numpad } from "@/components/numpad";
import { openCustomerDisplay, sendToDisplay } from "@/lib/customer-display";
import { withBase } from "@/lib/base-path";
import { printNewTickets } from "@/lib/kitchen-print";
import { MyShiftCard } from "@/components/my-shift";
import { CustomerBox } from "@/components/customer";
import { PickupStrip } from "@/components/pickup-strip";
import { NoSaleDialog } from "@/components/no-sale";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const money = (n: number) => fmtIn(n, 2);

export default function RegisterPage() {
  return <Suspense fallback={null}><Register /></Suspense>;
}

/** The touch register (REQ REG-01 … REG-09): pick an order or start one; then menu on the left, the order on the right. */
function Register() {
  const params = useSearchParams();
  const orderId = params.get("order");
  return orderId ? <OrderScreen key={orderId} orderId={orderId} /> : <StartScreen />;
}

/* ------------------------------------------------------------------ start */

function StartScreen() {
  const router = useRouter();
  const { branch, can } = useSession();
  const [noSale, setNoSale] = useState(false);
  const open = useApi<{ orders: Order[] }>("/orders?status=open");
  useLiveEvent(["order.changed"], () => open.reload());
  const [starting, setStarting] = useState<OrderType | null>(null);

  async function start(type: OrderType) {
    setStarting(type);
    try {
      const d = await api<OrderDetail>("/orders", "POST", { type });
      router.push(`/register?order=${d.order.id}`);
    } catch (e) {
      const msg = (e as Error).message;
      // No shift (or no register picked): one tap to the Dashboard, where the float count opens.
      toast.error(msg, /open your shift|pick the register/i.test(msg) ? { action: { label: "Open shift", onClick: () => router.push("/") } } : undefined);
      setStarting(null);
    }
  }

  const starts: { type: OrderType; label: string; hint: string; icon: React.ComponentType<{ className?: string }>; module: ModuleKey }[] = [
    ...(branch?.tableService ? [{ type: "dine_in" as const, label: "Dine-in", hint: "Seat a table on the floor", icon: ArmchairIcon, module: "sales" as const }] : []),
    { type: "takeaway", label: "Takeaway", hint: "Counter order", icon: ShoppingBagIcon, module: "fin" },
    { type: "delivery", label: "Delivery", hint: "Name, phone, address", icon: BikeIcon, module: "bank" },
  ];

  return (
    <div className="mx-auto max-w-[1180px] pb-6">
      <PageHeader title="Register" icon={ShoppingBasketIcon} module="fin" description="Start an order, or tap an open one to carry on."
        actions={<>
          {can("pos.nosale") && <Button variant="outline" className="h-11" onClick={() => setNoSale(true)}><InboxIcon /> No sale</Button>}
          <Button variant="outline" className="h-11" onClick={() => void openCustomerDisplay(withBase("/display"))}><MonitorIcon /> Customer display</Button>
        </>} />
      <NoSaleDialog open={noSale} onClose={() => setNoSale(false)} />
      <MyShiftCard autoOpen hideWhenOpen className="mb-4" />
      <PickupStrip className="mb-4" />
      <Stagger className={cn("grid gap-4", starts.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
        {starts.map((s) => (
          <StaggerItem key={s.type}>
            <button type="button" data-module={s.module} disabled={!!starting} data-shortcut={s.type === "takeaway" ? "new" : undefined}
              title={s.type === "takeaway" ? shortcutTitle("new", "New takeaway order") : undefined}
              onClick={() => (s.type === "dine_in" ? router.push("/floor") : void start(s.type))}
              className="group surface card-lift flex min-h-28 w-full items-center gap-4 p-5 text-left transition-transform active:scale-[0.98] disabled:opacity-60">
              <ModuleIcon module={s.module} icon={s.icon} size="lg" solid className="hover-hop" />
              <span className="flex-1">
                <span className="block font-heading text-lg font-semibold">{s.label}</span>
                <span className="block text-sm text-muted-foreground">{s.hint}</span>
              </span>
              {starting === s.type && <Loader2Icon className="size-5 animate-spin text-muted-foreground" />}
            </button>
          </StaggerItem>
        ))}
      </Stagger>

      <h2 className="mt-8 mb-3 flex items-center gap-2 font-heading text-[0.95rem] font-semibold">
        Open orders <span className="rounded-full bg-muted px-2 text-xs text-muted-foreground tabular-nums">{open.data?.orders.length ?? 0}</span>
      </h2>
      {open.data?.orders.length ? (
        <Stagger className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
          {open.data.orders.map((o) => (
            <StaggerItem key={o.id}>
              <button type="button" onClick={() => router.push(`/register?order=${o.id}`)}
                className="surface card-lift flex min-h-20 w-full items-center gap-3 p-4 text-left active:scale-[0.98]">
                <ModuleIcon module={o.orderType === "dine_in" ? "sales" : o.orderType === "delivery" ? "bank" : "fin"}
                  icon={o.orderType === "dine_in" ? ArmchairIcon : o.orderType === "delivery" ? BikeIcon : ShoppingBagIcon} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{orderLabel(o)} <span className="font-mono text-xs text-muted-foreground">{orderNo(o)}</span></div>
                  <div className="text-xs text-muted-foreground">{o.items} item{o.items === 1 ? "" : "s"} · {timeAgo(o.openedAt)}{o.registerName ? ` · ${o.registerName}` : ""}</div>
                </div>
                <span className="font-heading font-semibold tabular-nums">{money(o.total)}</span>
              </button>
            </StaggerItem>
          ))}
        </Stagger>
      ) : <p className="surface px-5 py-8 text-center text-sm text-muted-foreground">No open orders. Start one above.</p>}

    </div>
  );
}

/* ------------------------------------------------------------------ order */

/** The order on screen (module level, so React's development double mount doesn't count as leaving it). */
let onScreen: string | null = null;

function OrderScreen({ orderId }: { orderId: string }) {
  const router = useRouter();
  const { company, branch, can } = useSession();
  const [noSale, setNoSale] = useState(false);
  // The order's details (customer, table, platform, address) fold to one line, so the order lines get the room.
  const [detailsOpen, setDetailsOpen] = useState<boolean | null>(null);
  const [selLine, setSelLine] = useState<string | null>(null);
  // The Discount window: the whole bill (line null) or one item; the platform offer window.
  const [discountFor, setDiscountFor] = useState<{ line: OrderLine | null } | null>(null);
  const [offerOpen, setOfferOpen] = useState(false);
  const cur = company?.currency ?? "AED";
  const menuApi = useApi<Menu>("/pos/menu");
  const platforms = useApi<{ id: string; name: string; isActive: boolean }[]>("/platforms");
  const loaded = useApi<OrderDetail>(`/orders/${orderId}`);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const d = detail ?? loaded.data ?? null;
  // A FACTS-linked delivery platform's bill: the menu shows (and sells at) that platform's FACTS prices.
  const platformId = d?.order.orderType === "delivery" ? d.order.platformId ?? null : null;
  const menuData = useMemo(() => withPlatformPrices(menuApi.data, platformId), [menuApi.data, platformId]);
  const menu = { ...menuApi, data: menuData };
  const [cat, setCat] = useState("all");
  const [q, setQ] = useState("");
  const [picking, setPicking] = useState<MenuItem | null>(null);
  const [weighing, setWeighing] = useState<MenuItem | null>(null);
  const [paying, setPaying] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [lockedBy, setLockedBy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "tables" | "merge" | "split">(null);
  const search = useRef<HTMLInputElement>(null);

  // One device edits an open order at a time (REQ TBL-08): take the lock on open, keep it every 30 s, let it go on leaving.
  useEffect(() => {
    let stop = false;
    const take = () => api(`/orders/${orderId}/lock`, "POST", {}).then(() => { if (!stop) setLockedBy(null); })
      .catch((e: Error) => { if (!stop && /open on/i.test(e.message)) setLockedBy(e.message); });
    void take();
    const t = window.setInterval(() => void take(), 30000);
    return () => { stop = true; window.clearInterval(t); };
  }, [orderId]);
  const latest = useRef<OrderDetail | null>(null);
  useEffect(() => { latest.current = d; });

  // The customer display and pole display follow the order as it builds up (REQ HW-05).
  useEffect(() => {
    if (!d || d.order.status !== "open") return;
    sendToDisplay({
      kind: "order", currency: cur, number: d.order.number, discount: d.order.discountTotal, vat: d.order.vat, total: d.order.total, due: d.order.due,
      lines: d.lines.filter((l) => !l.isVoid).map((l) => ({ id: l.id, qty: l.qty, name: l.name, nameAr: l.nameAr, extras: l.modifiers.map((m) => m.name).join(", "), amount: l.lineTotal || l.unitPrice * l.qty })),
    });
  }, [d, cur]);
  useEffect(() => () => sendToDisplay({ kind: "idle" }), []);

  // Leaving an order nothing was added to removes it, so it doesn't sit in Open orders (the server sweeps any left behind too).
  useEffect(() => {
    onScreen = orderId;
    return () => {
      onScreen = null;
      window.setTimeout(() => {
        if (onScreen === orderId) return;
        const last = latest.current;
        if (last && last.order.status === "open" && last.lines.length === 0 && last.payments.length === 0)
          void api(`/orders/${orderId}`, "DELETE").catch(() => {});
        else void api(`/orders/${orderId}/lock`, "DELETE").catch(() => {});
      }, 80);
    };
  }, [orderId]);

  // Another till (or the waiter's tablet) changed this order: re-read it. The menu changed (sold out): re-read the menu.
  useLiveEvent(["order.changed"], (e) => { if ((e.data as { id?: string })?.id === orderId && !pending) void api<OrderDetail>(`/orders/${orderId}`).then(setDetail).catch(() => {}); });
  useLiveEvent(["menu.changed", "stock.changed"], () => menu.reload());
  // Where short ingredients warn or block, a sale elsewhere can run an item short: re-read the flags.
  // Stock left changes with every paid order (and the 5-minute FACTS read): keep the tiles current, but refresh at most every
  // 5 seconds however busy the branch's tills are (each tap of every till announces an order change).
  const menuRefresh = useRef<number | null>(null);
  useLiveEvent(["order.changed", "stock.changed"], () => {
    if (menuRefresh.current !== null) return;
    menuRefresh.current = window.setTimeout(() => { menuRefresh.current = null; menu.reload(); }, 5000);
  });
  useEffect(() => () => { if (menuRefresh.current !== null) window.clearTimeout(menuRefresh.current); }, []);
  useLiveEvent(["kitchen.changed"], (e) => { if ((e.data as { orderId?: string })?.orderId === orderId) void api<OrderDetail>(`/orders/${orderId}`).then(setDetail).catch(() => {}); });

  /** Sends a change; the answer is the whole order. Taps are counted while waiting, so the screen shows a working state. */
  const run = useCallback(async (path: string, method: "POST" | "PUT" | "DELETE", body?: unknown) => {
    setPending((n) => n + 1);
    try {
      const next = await api<OrderDetail>(path, method, body, { key: newKey() });
      setDetail(next);
      return next;
    } catch (e) {
      const msg = (e as Error).message;
      if (/is open on/i.test(msg)) setLockedBy(msg); else toast.error(msg);
      return null;
    } finally {
      setPending((n) => n - 1);
    }
  }, []);

  async function takeOver() {
    try {
      await api(`/orders/${orderId}/lock`, "POST", { takeOver: true });
      setLockedBy(null);
      setDetail(await api<OrderDetail>(`/orders/${orderId}`));
      toast.success("You have this order now.");
    } catch (e) { toast.error((e as Error).message); }
  }

  const items = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (menu.data?.items ?? []).filter((i) => (cat === "all" || i.categoryId === cat) && (!term || i.name.toLowerCase().includes(term)));
  }, [menu.data, cat, q]);

  if (loaded.error && !d) return <EmptyState icon={ReceiptTextIcon} title="Order not found" module="fin" action={<Button onClick={() => router.push("/register")}>Back to the register</Button>}>{loaded.error}</EmptyState>;
  if (!d) return <div className="grid gap-4 py-3 md:h-[calc(100dvh-3.5rem)] md:grid-cols-[minmax(0,1fr)_320px] lg:grid-cols-[minmax(0,1fr)_420px]"><div className="rounded-2xl skeleton-shimmer" /><div className="rounded-2xl skeleton-shimmer" /></div>;

  const o = d.order;
  // Closed, or open on another till: look but don't touch.
  const closed = o.status !== "open" || !!lockedBy;
  const active = d.lines.filter((l) => !l.isVoid);
  const unsent = active.reduce((n, l) => n + l.qty - l.sentQty, 0);
  // Open while something needed is missing (a platform's order number; phone and address for our own delivery) or nothing is on the order yet.
  const needsDetails = o.orderType === "delivery" && (o.platformId ? !o.platformRef : !(o.customerPhone && o.deliveryAddress));
  const showDetails = needsDetails || (detailsOpen ?? d.lines.length === 0);
  const detailsSummary = [
    o.orderType === "dine_in" ? (o.tableIds.length ? `Table ${o.tableNames}` : o.tableLabel ? `Table ${o.tableLabel}` : null) : null,
    o.orderType === "dine_in" && o.guests ? `${o.guests} guest${o.guests === 1 ? "" : "s"}` : null,
    o.platformName ? `${o.platformName} #${o.platformRef ?? "?"}` : null,
    o.customerName, o.customerPhone, o.orderType === "delivery" && !o.platformId ? o.deliveryAddress : null,
  ].filter(Boolean).join(" · ");
  // In the order the menu sets on the item (e.g. Size before Extras).
  const groupsOf = (i: MenuItem) => i.groupIds.map((id) => menu.data?.groups.find((g) => g.id === id)).filter((g): g is ModifierGroup => !!g);
  const qtyOf = (id: string) => active.filter((l) => l.itemId === id).reduce((n, l) => n + l.qty, 0);
  const tone = (i: MenuItem) => menu.data?.categories.find((c) => c.id === i.categoryId)?.tone ?? "fin";

  function tapItem(i: MenuItem) {
    if (closed) return;
    if (i.soldOut) return toast.error(`${i.name} is sold out today.`);
    if (i.short && menu.data?.shortStock === "block") return toast.error(`Not enough ingredients for ${i.name}. Receive them on the Ingredients screen.`);
    if (i.short) toast.warning(`${i.name}: the ingredients on hand don't cover it.`);
    // Its FACTS stock: no more than is left (block), or a warning (warn).
    const rule = menu.data?.shortStock ?? "allow";
    if (i.stockLeft !== null && rule !== "allow" && qtyOf(i.id) + 1 > i.stockLeft) {
      const left = Math.max(0, i.stockLeft);
      const msg = left <= 0 ? `${i.name} has no stock left.` : `Only ${fmtQty(left)} × ${i.name} left in stock.`;
      if (rule === "block") return toast.error(msg);
      toast.warning(msg);
    }
    if (groupsOf(i).length) setPicking(i);
    else if (byWeight(i)) setWeighing(i);   // sold by weight: the amount first (numpad; a scale later)
    else void run(`/orders/${o.id}/lines`, "POST", { itemId: i.id });
  }
  const decimalsOf = (itemId: string | null) => menu.data?.items.find((x) => x.id === itemId)?.qtyDecimals ?? 0;
  const unitOf = (itemId: string | null) => menu.data?.items.find((x) => x.id === itemId)?.erpUnit ?? null;

  async function voidOrder() {
    const sent = active.some((l) => l.sentQty > 0);
    if (!(await confirmDialog({ title: `Void order ${orderNo(o)}?`, message: sent ? "Items already went to the kitchen; your role needs the right to void them." : "Nothing went to the kitchen yet.", confirmLabel: "Void order", tone: "danger" }))) return;
    const r = await run(`/orders/${o.id}/void`, "POST", { reason: sent ? "Voided at the register" : "Cancelled before sending" });
    if (r) { toast.success(`Order ${orderNo(o)} voided.`); router.push("/register"); }
  }

  const types: { value: OrderType; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    ...(branch?.tableService ? [{ value: "dine_in" as const, label: "Dine-in", icon: ArmchairIcon }] : []),
    { value: "takeaway", label: "Takeaway", icon: ShoppingBagIcon },
    { value: "delivery", label: "Delivery", icon: BikeIcon },
  ];

  return (
    <div className="grid gap-3 py-3 md:h-[calc(100dvh-3.5rem)] md:grid-cols-[minmax(0,1fr)_320px] lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
      {/* Menu */}
      <section className="flex min-h-0 flex-col gap-3" aria-label="Menu">
        <div className="flex items-center gap-2">
          <Button variant="outline" className="size-12 shrink-0 rounded-xl" aria-label="Back to the register" onClick={() => router.push("/register")}><ChevronLeftIcon className="size-5" /></Button>
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the menu" type="search" data-list-search=""
              className="h-12 w-full rounded-xl border bg-card pr-10 pl-10 text-[0.95rem] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 dark:bg-input/30" />
            {q && <button type="button" aria-label="Clear search" onClick={() => setQ("")} className="absolute top-1/2 right-2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"><XIcon className="size-4" /></button>}
          </div>
        </div>
        <PickupStrip />
        <NoSaleDialog open={noSale} onClose={() => setNoSale(false)} />
        <div role="tablist" aria-label="Categories" className="scrollbar-thin -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {[{ id: "all", name: "All", tone: "home" as const }, ...(menu.data?.categories ?? [])].map((c) => {
            const on = cat === c.id;
            return (
              <button key={c.id} type="button" role="tab" aria-selected={on} data-module={c.tone} onClick={() => setCat(c.id)}
                className={cn("relative flex h-12 shrink-0 items-center gap-2 rounded-xl px-4 text-sm font-medium transition-[color,transform] active:scale-[0.97]",
                  on ? "text-white" : "border bg-card text-muted-foreground")}>
                {on && <motion.span layoutId="cat-pill" className="absolute inset-0 rounded-xl bg-mod-grad shadow-[0_6px_14px_-6px_var(--mod)]" transition={{ type: "spring", stiffness: 420, damping: 30 }} />}
                {!on && c.id !== "all" && <span className="relative size-2 rounded-full bg-mod" />}
                <span className="relative">{c.name}</span>
              </button>
            );
          })}
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto pr-1 pb-2">
          {menu.loading && !menu.data ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">{Array.from({ length: 12 }, (_, i) => <div key={i} className="h-40 rounded-2xl skeleton-shimmer" />)}</div>
          ) : items.length ? (
            <motion.div key={cat + q} className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
              initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: 0.02 } } }}>
              {items.map((i) => <ItemTile key={i.id} item={i} shortRule={menu.data?.shortStock ?? "allow"} image={imageUrl(company?.id, i)} qty={qtyOf(i.id)} currency={cur} tone={tone(i)} hasOptions={groupsOf(i).length > 0} disabled={closed} onTap={() => tapItem(i)} />)}
            </motion.div>
          ) : (
            <EmptyState compact icon={UtensilsCrossedIcon} title={menu.data?.items.length ? "Nothing matches" : "The menu is empty"} module="inv">
              {menu.data?.items.length ? "Try another word or category." : "A manager adds items under Menu."}
            </EmptyState>
          )}
        </div>
      </section>

      {/* Order */}
      <section data-module="fin" className="surface flex min-h-[30rem] flex-col overflow-hidden md:min-h-0" aria-label="Order">
        {/* At most half the panel: the bill lines and Pay always stay on the till screen; the details scroll inside. */}
        <div className="scrollbar-thin max-h-[50%] shrink-0 space-y-2.5 overflow-y-auto border-b px-4 pt-3 pb-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate font-heading text-lg font-semibold">{orderLabel(o)}</h2>
              <span className="font-mono text-sm text-muted-foreground">{o.number ? `#${o.number}` : "New order"}</span>
              {o.status === "paid" ? <ObjectStatus className={TONE.done}>Paid</ObjectStatus> : o.status === "void" ? <ObjectStatus className={TONE.struck}>Void</ObjectStatus>
                : o.status === "refunded" ? <ObjectStatus className={TONE.violet}>Refunded</ObjectStatus> : <ObjectStatus className={TONE.open}>Open</ObjectStatus>}
              {pending > 0 && <Loader2Icon className="size-4 animate-spin text-muted-foreground" />}
            </div>
            {!closed && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" className="size-11" aria-label="More"><EllipsisIcon /></Button>} />
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem className="h-11" onClick={() => router.push("/register")}><PlusIcon className="size-4" /> Park &amp; start another</DropdownMenuItem>
                  <DropdownMenuItem className="h-11" onClick={() => void openCustomerDisplay(withBase("/display"))}><MonitorIcon className="size-4" /> Open customer display</DropdownMenuItem>
                  {can("pos.nosale") && <DropdownMenuItem className="h-11" onClick={() => setNoSale(true)}><InboxIcon className="size-4" /> No sale (open drawer)</DropdownMenuItem>}
                  {o.orderType === "dine_in" && branch?.tableService && <>
                    <DropdownMenuItem className="h-11" onClick={() => setDialog("tables")}><ArmchairIcon className="size-4" /> Move or join tables</DropdownMenuItem>
                    <DropdownMenuItem className="h-11" onClick={() => setDialog("merge")}><CombineIcon className="size-4" /> Merge another table&apos;s order</DropdownMenuItem>
                  </>}
                  <DropdownMenuItem className="h-11" disabled={active.reduce((n, l) => n + l.qty, 0) < 2 || o.paid > 0} onClick={() => setDialog("split")}><SplitIcon className="size-4" /> Split bill</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="h-11 text-danger" onClick={voidOrder}><Trash2Icon className="size-4" /> Void order</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          {branch?.kitchenEnabled && d.tickets.some((t) => !t.isCancel) && <KitchenProgress tickets={d.tickets} />}
          {lockedBy && o.status === "open" && (
            <div className="animate-rise-in flex items-center gap-3 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm text-warning">
              <LockIcon className="size-4 shrink-0" /><span className="flex-1">{lockedBy}</span>
              <Button className="h-10" onClick={takeOver}>Take over</Button>
            </div>
          )}
          {!closed && (
            <>
              <Segmented id="order-type" size="sm" value={o.orderType} className="w-full" options={types} onChange={(v) => { setDetailsOpen(null); void run(`/orders/${o.id}`, "PUT", { type: v }); if (v === "dine_in" && branch?.tableService && !o.tableIds.length) setDialog("tables"); }} />
              {showDetails ? (
                <div className="space-y-2">
                  <OrderDetailsFields order={o} currency={cur} platforms={(platforms.data ?? []).filter((p) => p.isActive)} onAttach={(customerId) => void run(`/orders/${o.id}/customer`, "POST", { customerId })} onSave={(patch) => void run(`/orders/${o.id}`, "PUT", patch)} onTables={() => setDialog("tables")} />
                  {!needsDetails && d.lines.length > 0 && (
                    <button type="button" onClick={() => setDetailsOpen(false)} className="flex w-full items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                      <ChevronUpIcon className="size-3.5" /> Hide details
                    </button>
                  )}
                </div>
              ) : (
                <button type="button" onClick={() => setDetailsOpen(true)}
                  className="flex h-10 w-full min-w-0 items-center gap-2 rounded-xl border bg-card px-3 text-left text-sm transition-colors hover:bg-muted">
                  <UserRoundIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{detailsSummary || <span className="text-muted-foreground">Add a customer (optional)</span>}</span>
                  <PencilIcon className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              )}
            </>
          )}
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
          {d.lines.length ? (
            <ul className="divide-y">
              <AnimatePresence initial={false}>
                {d.lines.map((l) => <LineRow key={l.id} line={l} closed={closed} canVoid={can("pos.void")} decimals={decimalsOf(l.itemId)} unit={unitOf(l.itemId)}
                  selected={selLine === l.id} onSelect={() => setSelLine(selLine === l.id ? null : l.id)}
                  onDiscount={can("pos.discount") ? () => setDiscountFor({ line: l }) : undefined}
                  onQty={(qty) => void run(`/orders/${o.id}/lines/${l.id}`, "PUT", { qty })}
                  onNote={(note) => void run(`/orders/${o.id}/lines/${l.id}`, "PUT", { note })}
                  onRemove={(reason) => void run(`/orders/${o.id}/lines/${l.id}${reason ? `?reason=${encodeURIComponent(reason)}` : ""}`, "DELETE")} />)}
              </AnimatePresence>
            </ul>
          ) : <EmptyState compact icon={HandPlatterIcon} title="Nothing on the order yet" module="fin">Tap items on the left to add them.</EmptyState>}
        </div>

        <div className="space-y-2 border-t bg-muted/40 px-4 py-3">
          <div className="space-y-0.5 text-sm">
            <div className="flex items-center justify-between gap-2 text-muted-foreground">
              <span>Subtotal <span className="tabular-nums text-foreground">{money(o.subtotal)}</span> · VAT{o.pricesIncludeVat ? " incl." : ""} <span className="tabular-nums">{money(o.vat)}</span></span>
              {!closed && (
                <span className="flex gap-1.5">
                  {o.platformId && (
                    <button type="button" onClick={() => setOfferOpen(true)}
                      className="inline-flex h-8 items-center gap-1 rounded-lg border bg-card px-2.5 text-xs font-medium transition-colors hover:bg-muted">
                      <TagIcon className="size-3.5" /> {o.platformName} offer
                    </button>
                  )}
                  {can("pos.discount") && (
                    <button type="button" onClick={() => setDiscountFor({ line: null })}
                      className={cn("inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 text-xs font-medium transition-colors",
                        o.discountPct > 0 || o.discountAmount > 0 ? "border-primary bg-primary/10 text-primary" : "bg-card hover:bg-muted")}>
                      <PercentIcon className="size-3.5" /> Discount
                    </button>
                  )}
                </span>
              )}
            </div>
            {o.discountTotal > 0 && <Row label={billDiscountLabel(o)} value={`−${money(o.discountTotal)}`} className="text-success" />}
            {o.platformFunded > 0 && <Row label={`${o.platformName} offer (${o.platformName} pays)`} value={money(o.platformFunded)} className="text-muted-foreground" />}
            {o.serviceCharge > 0 && <Row label={`Service charge ${o.servicePct}%`} value={money(o.serviceCharge)} />}
            {o.paid > 0 && <Row label="Paid" value={`−${money(o.paid)}`} className="text-success" />}
            {o.refunded > 0 && <Row label="Refunded" value={money(o.refunded)} className="text-violet-600" />}
            <div className="flex items-baseline justify-between border-t pt-1.5">
              <span className="font-heading font-semibold">{o.paid > 0 && !closed ? "Left to pay" : "Total"}</span>
              <span className="font-heading text-[1.7rem] font-semibold tracking-tight"><span className="mr-1 text-xs font-medium text-muted-foreground">{cur}</span><CountUp value={closed ? o.total : o.due} format={money} duration={0.35} /></span>
            </div>
          </div>
          {closed ? (
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" className="h-11" onClick={() => setReceipt(o.id)}><ReceiptTextIcon /> Receipt</Button>
              <Button className="h-11" data-shortcut="new" title={shortcutTitle("new", "New order")} onClick={() => router.push("/register")}><PlusIcon /> New order</Button>
            </div>
          ) : (
            <div className={cn("grid gap-2", [branch?.kitchenEnabled, o.orderType === "dine_in"].filter(Boolean).length === 2 ? "grid-cols-[1fr_1fr_1.6fr]"
              : [branch?.kitchenEnabled, o.orderType === "dine_in"].some(Boolean) ? "grid-cols-[1fr_1.6fr]" : "grid-cols-1")}>
              {branch?.kitchenEnabled && <Button variant="outline" className="h-12 px-2" disabled={!unsent} data-shortcut="send" title={shortcutTitle("send")} onClick={() => void run(`/orders/${o.id}/send`, "POST").then((r) => { if (r) { toast.success(`${unsent} item${unsent === 1 ? "" : "s"} sent`, { icon: <ChefHatIcon className="size-4" /> }); void printNewTickets(r); } })}>
                <ChefHatIcon /> Send{unsent ? ` (${unsent})` : ""}
              </Button>}
              {o.orderType === "dine_in" && <Button variant="outline" className="h-12 px-2" disabled={!active.length} data-shortcut="bill" title={shortcutTitle("bill")} onClick={() => void run(`/orders/${o.id}/bill`, "POST").then((r) => r && setReceipt(o.id))}>
                <ReceiptTextIcon /> {o.billPrintedAt ? "Bill again" : "Bill"}
              </Button>}
              <Button className="h-12 px-2 text-base" disabled={!active.length || pending > 0} data-shortcut="pay" title={shortcutTitle("pay")} onClick={() => setPaying(true)}>
                Pay {cur} {money(o.due)}
              </Button>
            </div>
          )}
        </div>
      </section>

      {picking && menu.data && (
        <ModifierDialog item={picking} groups={groupsOf(picking)} currency={cur} onClose={() => setPicking(null)}
          onAdd={(optionIds, qty, note) => { const it = picking; setPicking(null); void run(`/orders/${o.id}/lines`, "POST", { itemId: it.id, optionIds, qty, note }); }} />
      )}
      {weighing && <QtyDialog title={weighing.name} unit={weighing.erpUnit} decimals={weighing.qtyDecimals} initial="" onClose={() => setWeighing(null)}
        onDone={(qty) => { const it = weighing; setWeighing(null); void run(`/orders/${o.id}/lines`, "POST", { itemId: it.id, qty }); }} />}
      <DiscountDialog open={!!discountFor} line={discountFor?.line ? d.lines.find((x) => x.id === discountFor.line!.id) ?? null : null} detail={d} currency={cur}
        onClose={() => setDiscountFor(null)} apply={(path, body) => run(path, "POST", body)} />
      {o.platformId && <PlatformOfferDialog open={offerOpen} detail={d} currency={cur} onClose={() => setOfferOpen(false)} apply={(path, body) => run(path, "POST", body)} />}
      <PaymentDialog detail={d} currency={cur} open={paying} onOpenChange={setPaying} onChanged={setDetail}
        onPaid={(next, printed, change) => {
          setPaying(false);
          void printNewTickets(next);
          sendToDisplay({ kind: "paid", currency: cur, total: next.order.total, change: next.payments.reduce((t, p) => t + p.changeGiven, 0) });
          if (!printed) { setReceipt(next.order.id); return; }   // no receipt printer here: the preview, to print from the browser
          // Printed: straight to a new order (a table goes back to the floor); the change stays on screen a while.
          const paidId = next.order.id;
          toast.success(change > 0 ? `Paid. Give ${cur} ${money(change)} change.` : `Order #${next.order.number} paid.`, {
            duration: change > 0 ? 10_000 : 4_000, action: { label: "Receipt", onClick: () => router.push(`/orders?receipt=${paidId}`) },
          });
          router.push(next.order.orderType === "dine_in" && branch?.tableService ? "/floor" : "/register");
        }} />
      {dialog === "tables" && <TablesDialog order={o} onClose={() => setDialog(null)}
        onPick={(tableIds) => { setDialog(null); void run(`/orders/${o.id}/tables`, "PUT", { tableIds }); }} />}
      {dialog === "merge" && <MergeDialog order={o} onClose={() => setDialog(null)}
        onPick={(fromOrderId) => { setDialog(null); void run(`/orders/${o.id}/merge`, "POST", { fromOrderId }).then((r) => r && toast.success("Orders merged.")); }} />}
      {dialog === "split" && <SplitDialog detail={d} currency={cur} tableService={!!branch?.tableService} onClose={() => setDialog(null)}
        onDone={(created) => { setDialog(null); void api<OrderDetail>(`/orders/${o.id}`).then(setDetail); toast.success(`New bill #${created.order.number} made.`, { action: { label: "Open it", onClick: () => router.push(`/register?order=${created.order.id}`) } }); }} />}
      <ReceiptDialog orderId={receipt} onClose={() => setReceipt(null)}
        primary={closed || o.status !== "open" ? { label: "New order", onClick: () => { setReceipt(null); router.push("/register"); } } : undefined} />
    </div>
  );
}

/** The bill's discount line: its name (a listed discount, a platform's offer), its % or "Discounts" when items have their own. */
function billDiscountLabel(o: OrderDetail["order"]): string {
  // A customer's pre-approved discount: its reason and whose (e.g. "Complimentary · Ahmed").
  if (o.discountSource === "customer") return `${o.discountName ?? "Pre-approved"} · ${o.discountNote ?? ""} ${o.discountPct}%`.trim();
  if (o.discountName) return o.discountName;
  if (o.discountPct > 0) return `Discount ${o.discountPct}%`;
  return "Discounts";
}

function Row({ label, value, className, muted }: { label: string; value: string; className?: string; muted?: boolean }) {
  return <div className={cn("flex justify-between", muted && "text-muted-foreground", className)}><span>{label}</span><span className="tabular-nums">{value}</span></div>;
}

/** Customer / table fields under the order type; saved when the field loses focus. */
function OrderDetailsFields({ order: o, currency, platforms, onAttach, onSave, onTables }: {
  order: Order; currency: string; platforms: { id: string; name: string }[]; onAttach: (customerId: string | null) => void; onSave: (patch: Record<string, unknown>) => void; onTables: () => void;
}) {
  // What's being typed in the name / phone (or dine-in customer) field: matching customers show under it to attach.
  const [typed, setTyped] = useState("");
  const field = "h-11 w-full min-w-0 rounded-xl border border-input bg-card px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 dark:bg-input/30";
  const blur = (k: string, v: string, old: string | null) => { if ((v || null) !== old) onSave({ [k]: v }); };
  if (o.orderType === "dine_in")
    return (
      <div className="space-y-2">
      <div className="grid grid-cols-[1fr_auto] gap-2">
        {o.tableIds.length ? (
          <button type="button" onClick={onTables} className="flex h-11 min-w-0 items-center gap-2 rounded-xl border bg-card px-3 text-left text-sm transition-colors hover:bg-muted">
            <ArmchairIcon className="size-4 shrink-0 text-mod-sales" /><span className="truncate font-medium">{o.tableIds.length > 1 ? "Tables" : "Table"} {o.tableNames}</span>
            <span className="ml-auto text-xs text-muted-foreground">change</span>
          </button>
        ) : (
          <button type="button" onClick={onTables} className="flex h-11 min-w-0 items-center gap-2 rounded-xl border border-primary/40 bg-primary/5 px-3 text-left text-sm font-medium text-primary transition-colors hover:bg-primary/10">
            <ArmchairIcon className="size-4 shrink-0" /><span className="truncate">{o.tableLabel ? `Table ${o.tableLabel} · pick on the floor` : "Pick a table"}</span>
          </button>
        )}
        <div className="flex h-11 items-center rounded-xl border bg-card">
          <button type="button" aria-label="Fewer guests" className="flex size-11 items-center justify-center text-muted-foreground" onClick={() => onSave({ guests: Math.max(1, (o.guests ?? 1) - 1) })}><MinusIcon className="size-4" /></button>
          <span className="flex min-w-12 items-center justify-center gap-1 text-sm font-medium tabular-nums"><UsersRoundIcon className="size-3.5 text-muted-foreground" />{o.guests ?? "–"}</span>
          <button type="button" aria-label="More guests" className="flex size-11 items-center justify-center text-muted-foreground" onClick={() => onSave({ guests: (o.guests ?? 0) + 1 })}><PlusIcon className="size-4" /></button>
        </div>
      </div>
      {!o.customerId && <input placeholder="Customer (optional): name or phone" className={field} onChange={(e) => setTyped(e.target.value)} />}
      <CustomerBox order={o} typed={typed} currency={currency} onAttach={onAttach} />
      </div>
    );
  const platformOrder = o.orderType === "delivery" && !!o.platformId;
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {o.orderType === "delivery" && platforms.length > 0 && (
        // One row that scrolls sideways: many platforms never push the bill and Pay off the till screen.
        <div className="scrollbar-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 sm:col-span-2">
          {[{ id: "", name: "Own delivery" }, ...platforms].map((p) => {
            const on = (o.platformId ?? "") === p.id;
            return (
              <button key={p.id || "own"} type="button" aria-pressed={on} disabled={o.paid > 0}
                onClick={() => !on && onSave({ platformId: p.id || "00000000-0000-0000-0000-000000000000" })}
                className={cn("h-9 shrink-0 rounded-lg border px-3 text-sm whitespace-nowrap transition-[background-color,transform] active:scale-[0.97] disabled:opacity-60",
                  on ? "border-primary bg-primary/10 font-medium text-primary" : "bg-card hover:bg-muted")}>{p.name}</button>
            );
          })}
        </div>
      )}
      {platformOrder && (
        <input key={`r${o.version}`} defaultValue={o.platformRef ?? ""} placeholder={`${o.platformName} order number (needed)`} className={cn(field, "font-medium uppercase sm:col-span-2")}
          onBlur={(e) => blur("platformRef", e.target.value.trim().toUpperCase(), o.platformRef)} autoFocus={!o.platformRef} />
      )}
      <input key={`n${o.version}`} defaultValue={o.customerName ?? ""} placeholder={o.orderType === "delivery" && !platformOrder ? "Customer name" : "Customer name (optional)"} className={field}
        onChange={(e) => setTyped(e.target.value)} onBlur={(e) => blur("customerName", e.target.value, o.customerName)} />
      <input key={`p${o.version}`} defaultValue={o.customerPhone ?? ""} placeholder={o.orderType === "delivery" && !platformOrder ? "Phone (needed)" : "Phone (optional)"} inputMode="tel" className={field}
        onChange={(e) => setTyped(e.target.value)} onBlur={(e) => blur("customerPhone", e.target.value, o.customerPhone)} />
      <div className="sm:col-span-2 empty:hidden"><CustomerBox order={o} typed={typed} currency={currency} onAttach={onAttach} /></div>
      {o.orderType === "delivery" && !platformOrder && (
        <input key={`a${o.version}`} defaultValue={o.deliveryAddress ?? ""} placeholder="Delivery address (needed)" className={cn(field, "sm:col-span-2")} onBlur={(e) => blur("deliveryAddress", e.target.value, o.deliveryAddress)} />
      )}
    </div>
  );
}

/** A menu tile: photo (or the category colour with initials), name, price; tap to add (or choose options). The count on the order pops on each tap. */
function ItemTile({ item, shortRule, image, qty, currency, tone, hasOptions, disabled, onTap }: {
  item: MenuItem; shortRule: ShortStock; image: string | null; qty: number; currency: string; tone: string; hasOptions: boolean; disabled: boolean; onTap: () => void;
}) {
  return (
    <motion.button type="button" data-module={tone} onClick={onTap} disabled={disabled || noPrice(item)}
      variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.22, ease: EASE } } }}
      className={cn("group surface relative flex flex-col overflow-hidden text-left transition-[transform,box-shadow] duration-150 active:scale-[0.96] disabled:pointer-events-none",
        (item.soldOut || noPrice(item) || (item.short && shortRule === "block") || (shortRule === "block" && item.stockLeft !== null && item.stockLeft - qty <= 0)) && "opacity-45")}>
      <span className="relative block h-14 w-full overflow-hidden bg-mod-grad [@media(min-height:700px)]:h-24">
        {image
          // eslint-disable-next-line @next/next/no-img-element -- a small same-origin photo; next/image adds nothing here
          ? <img src={image} alt="" loading="lazy" draggable={false} className="size-full object-cover transition-transform duration-300 group-active:scale-105" />
          : <span className="flex size-full items-center justify-center font-heading text-xl font-semibold text-white/90 [@media(min-height:700px)]:text-2xl">{initials(item.name)}</span>}
        {item.soldOut && <span className="absolute inset-x-0 bottom-0 bg-danger/90 py-1 text-center text-xs font-semibold text-white">Sold out today</span>}
        {item.short && !item.soldOut && (
          <span className={cn("absolute inset-x-0 bottom-0 py-1 text-center text-xs font-semibold text-white", shortRule === "block" ? "bg-danger/90" : "bg-warning/90")}>
            {shortRule === "block" ? "Out of ingredients" : "Ingredients low"}
          </span>
        )}
        {hasOptions && !item.soldOut && <span className="absolute top-2 left-2 rounded-md bg-black/45 px-1.5 py-0.5 text-[0.65rem] font-medium text-white">{item.isCombo ? "Combo" : "Options"}</span>}
      </span>
      <span className="flex flex-1 flex-col gap-1 p-2.5 [@media(min-height:700px)]:p-3">
        {/* The whole name shows: smaller letters, up to 4 lines, the longest names (e.g. "EB OUTLET - BAKED CROISSANT ALMOND 90GM") smaller still. */}
        <span title={item.name} className={cn("line-clamp-4 leading-tight font-medium wrap-break-word", item.name.length > 30 ? "text-[0.72rem]" : "text-[0.8rem]")}>{item.name}</span>
        <span className="mt-auto flex items-baseline justify-between gap-2 text-xs text-muted-foreground tabular-nums">
          {noPrice(item) ? <span className="font-medium text-warning">No price yet</span> : <span>{currency} <span className="text-[0.9rem] font-semibold text-foreground">{fmtIn(priceOf(item), 2)}</span></span>}
          {item.stockLeft !== null && <span className={cn(item.stockLeft <= 0 && "font-medium text-danger")}>{item.stockLeft <= 0 ? "No stock" : `${fmtIn(item.stockLeft, item.stockLeft % 1 ? 2 : 0)} left`}</span>}
        </span>
      </span>
      {qty > 0 && <span key={qty} className="relmap-label-pop absolute top-2 right-2 flex h-7 min-w-7 items-center justify-center rounded-full bg-primary px-2 text-xs font-semibold text-primary-foreground shadow-soft ring-2 ring-white tabular-nums">{fmtQty(qty)}</span>}
    </motion.button>
  );
}

/** One order line: big steppers, a kitchen note, remove / void. Slides in and out. */
function LineRow({ line: l, closed, canVoid, decimals, unit, selected, onSelect, onDiscount, onQty, onNote, onRemove }: {
  line: OrderLine; closed: boolean; canVoid: boolean; decimals: number; unit: string | null; selected: boolean; onSelect: () => void;
  onDiscount?: () => void; onQty: (q: number) => void; onNote: (n: string) => void; onRemove: (reason?: string) => void;
}) {
  const [typing, setTyping] = useState(false);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState(l.note ?? "");
  const animate = !motionOff();
  const sent = l.sentQty > 0;
  const editable = !closed && !l.isVoid;
  async function remove() {
    if (!sent) return onRemove();
    if (!canVoid) return toast.error("This went to the kitchen. Ask a supervisor to void it.");
    if (await confirmDialog({ title: `Void ${fmtQty(l.qty)} × ${l.name}?`, message: "It already went to the kitchen.", confirmLabel: "Void", tone: "danger" })) onRemove("Voided at the register");
  }
  // One slim row (quantity, name, options, price); the selected row opens its controls under it.
  const extras = [l.modifiers.map((m) => m.name + (m.price ? ` +${money(m.price)}` : "")).join(", "), l.note ? `“${l.note}”` : ""].filter(Boolean).join(" · ");
  return (
    <motion.li layout={animate ? "position" : false} initial={animate ? { opacity: 0, x: 16 } : false} animate={{ opacity: 1, x: 0 }}
      exit={animate ? { opacity: 0, x: -16, transition: { duration: 0.15 } } : undefined} transition={{ duration: 0.22, ease: EASE }}
      className={cn("transition-colors", selected && "bg-primary/[0.06]", l.isVoid && "opacity-50")}>
      <button type="button" onClick={editable ? onSelect : undefined} aria-expanded={editable ? selected : undefined}
        className={cn("flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left", editable && "cursor-pointer")}>
        <span key={l.qty} className={cn("animate-rise-in min-w-8 shrink-0 rounded-md py-0.5 text-center font-heading text-sm font-semibold tabular-nums", selected ? "bg-primary text-primary-foreground" : "bg-muted")}>{fmtQty(l.qty)}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={cn("truncate leading-tight font-medium", l.isVoid && "line-through")}>{l.name}</span>
            <span className="shrink-0 font-medium tabular-nums">{money(l.lineTotal || l.unitPrice * l.qty)}</span>
          </span>
          {/* The item's own discount (a promotion, an item discount); a share of the bill discount shows only on the bill's line. */}
          {l.discount > 0 && l.discType && !l.isVoid && (
            <span className="mt-0.5 flex items-center justify-between gap-2 text-xs text-success">
              <span className="truncate">{l.discName ?? "Discount"}{l.discNote ? ` · ${l.discNote}` : ""}</span>
              <span className="shrink-0 tabular-nums">−{money(l.discount)}</span>
            </span>
          )}
          {(extras || sent || l.isVoid) && (
            <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              {l.isVoid ? <span className="text-danger">Void</span> : sent && <ChefHatIcon className={cn("size-3 shrink-0", l.sentQty >= l.qty ? "text-success" : "text-warning")} aria-label={l.sentQty >= l.qty ? "Sent" : "Partly sent"} />}
              <span className={cn("truncate", l.note && "text-warning")}>{extras}</span>
            </span>
          )}
        </span>
      </button>
      {selected && editable && (
        <div className="animate-rise-in flex flex-wrap items-center gap-2 px-4 pb-2.5">
          <div className="flex h-11 items-center rounded-xl border bg-card">
            <button type="button" aria-label={`One less ${l.name}`} onClick={() => (l.qty <= 1 ? void remove() : onQty(Number((l.qty - 1).toFixed(3))))} className="flex size-11 items-center justify-center text-muted-foreground active:scale-90">
              {l.qty <= 1 ? <Trash2Icon className="size-4" /> : <MinusIcon className="size-4" />}
            </button>
            {decimals > 0
              ? <button type="button" aria-label={`Quantity of ${l.name}`} onClick={() => setTyping(true)} className="min-w-10 rounded-md px-1 text-center font-heading font-semibold tabular-nums underline decoration-dotted underline-offset-4">{fmtQty(l.qty)}</button>
              : <span className="w-8 text-center font-heading font-semibold tabular-nums">{l.qty}</span>}
            <button type="button" aria-label={`One more ${l.name}`} onClick={() => onQty(Number((l.qty + 1).toFixed(3)))} className="flex size-11 items-center justify-center text-muted-foreground active:scale-90"><PlusIcon className="size-4" /></button>
          </div>
          {!sent && !noting && <Button type="button" variant="outline" className="h-11" onClick={() => setNoting(true)}><StickyNoteIcon /> {l.note ? "Edit note" : "Note"}</Button>}
          {onDiscount && <Button type="button" variant="outline" className="h-11" onClick={onDiscount}><PercentIcon /> Discount</Button>}
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">{money(l.unitPrice)} each{sent ? ` · ${l.sentQty >= l.qty ? "sent" : `${fmtQty(l.sentQty)} sent`}` : ""}</span>
          <Button type="button" variant="ghost" size="icon" className="size-11 text-danger" aria-label={sent ? `Void ${l.name}` : `Remove ${l.name}`} onClick={() => void remove()}><Trash2Icon /></Button>
          {noting && (
            <form className="flex w-full gap-2" onSubmit={(e) => { e.preventDefault(); onNote(note); setNoting(false); }}>
              <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. no onions, extra spicy"
                className="h-11 min-w-0 flex-1 rounded-xl border bg-card px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/40" />
              <Button type="submit" className="h-11">Save</Button>
            </form>
          )}
        </div>
      )}
      {typing && <QtyDialog title={l.name} unit={unit} decimals={decimals} initial={fmtQty(l.qty)} min={l.sentQty} onClose={() => setTyping(false)} onDone={(q) => { setTyping(false); onQty(q); }} />}
    </motion.li>
  );
}

/** Choosing an item's options (REQ REG-02): each group as big chips, required ones marked, quantity, note, live price. */
function ModifierDialog({ item, groups, currency, onClose, onAdd }: {
  item: MenuItem; groups: ModifierGroup[]; currency: string; onClose: () => void; onAdd: (optionIds: string[], qty: number, note: string) => void;
}) {
  const [chosen, setChosen] = useState<string[]>(() => groups.filter((g) => g.minSelect === 1 && g.maxSelect === 1 && g.options.length).map((g) => g.options[0].id));
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState("");
  const toggle = (g: ModifierGroup, id: string) => setChosen((c) => {
    const inGroup = c.filter((x) => g.options.some((o) => o.id === x));
    if (c.includes(id)) return g.minSelect === 1 && g.maxSelect === 1 ? c : c.filter((x) => x !== id);
    if (g.maxSelect === 1) return [...c.filter((x) => !inGroup.includes(x)), id];
    if (inGroup.length >= g.maxSelect) { toast.error(`At most ${g.maxSelect} for ${g.name}.`); return c; }
    return [...c, id];
  });
  const missing = groups.filter((g) => chosen.filter((x) => g.options.some((o) => o.id === x)).length < g.minSelect);
  const unit = priceOf(item) + groups.flatMap((g) => g.options).filter((o) => chosen.includes(o.id)).reduce((t, o) => t + o.price, 0);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{item.name}</DialogTitle>
          <DialogDescription>{item.description ?? "Choose the options."}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] space-y-5 overflow-y-auto pr-1">
          {groups.map((g) => (
            <div key={g.id}>
              <div className="mb-2 flex items-baseline gap-2">
                <span className="font-medium">{g.name}</span>
                <span className={cn("text-xs", g.minSelect ? "font-medium text-danger" : "text-muted-foreground")}>
                  {g.minSelect ? (g.maxSelect === 1 ? "Required" : `Choose ${g.minSelect}–${g.maxSelect}`) : g.maxSelect === 1 ? "Optional" : `Up to ${g.maxSelect}`}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {g.options.map((o) => {
                  const on = chosen.includes(o.id);
                  return (
                    <button key={o.id} type="button" onClick={() => toggle(g, o.id)} aria-pressed={on}
                      className={cn("flex min-h-14 flex-col items-start justify-center rounded-xl border px-3 py-2 text-left transition-[background-color,transform] active:scale-[0.97]",
                        on ? "border-primary bg-primary/10 ring-1 ring-primary" : "bg-card hover:bg-muted")}>
                      <span className="text-sm font-medium">{o.name}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">{o.price ? `+${fmtIn(o.price, 2)}` : "Included"}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Kitchen note (optional)"
            className="h-12 w-full rounded-xl border bg-card px-3.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40" />
        </div>
        <DialogFooter className="items-center">
          <div className="mr-auto flex h-12 items-center rounded-xl border bg-card">
            <button type="button" aria-label="One less" className="flex size-12 items-center justify-center text-muted-foreground" onClick={() => setQty((q) => Math.max(1, q - 1))}><MinusIcon className="size-4" /></button>
            <span className="w-8 text-center font-heading text-lg font-semibold tabular-nums">{qty}</span>
            <button type="button" aria-label="One more" className="flex size-12 items-center justify-center text-muted-foreground" onClick={() => setQty((q) => Math.min(99, q + 1))}><PlusIcon className="size-4" /></button>
          </div>
          <Button variant="outline" className="h-12" onClick={onClose}>Cancel</Button>
          <Button className="h-12 min-w-44" disabled={missing.length > 0} onClick={() => onAdd(chosen, qty, note)}>
            {missing.length ? `Choose ${missing[0].name.toLowerCase()}` : <>Add · {currency} {fmtIn(unit * qty, 2)}</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


/** Move the order, or join tables to it (REQ TBL-06): tap tables; the first chosen is the main one. Busy tables can't be picked. */
function TablesDialog({ order, onClose, onPick }: { order: Order; onClose: () => void; onPick: (tableIds: string[]) => void }) {
  const floor = useApi<FloorData>("/floor");
  const [chosen, setChosen] = useState<string[]>(order.tableIds);
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{order.tableIds.length ? `Tables for ${orderNo(order)}` : "Pick a table"}</DialogTitle>
          <DialogDescription>{order.tableIds.length ? "Tap one table to move, more to join them. The first one tapped is the main table." : "Tap the table to seat this order. Tap more to join them."}</DialogDescription>
        </DialogHeader>
        {floor.data?.floors.map((f) => {
          const list = floor.data!.tables.filter((t) => t.floorId === f.id);
          if (!list.length) return null;
          return (
            <div key={f.id}>
              <div className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{f.name}</div>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                {list.map((t) => {
                  const mine = t.orderId === order.id;
                  const busy = !!t.orderId && !mine;
                  const on = chosen.includes(t.id);
                  return (
                    <button key={t.id} type="button" disabled={busy} onClick={() => toggle(t.id)} aria-pressed={on}
                      className={cn("relative flex h-16 flex-col items-center justify-center rounded-xl border text-sm font-semibold transition-[transform,background-color] active:scale-[0.96]",
                        on ? "border-primary bg-primary text-primary-foreground" : busy ? "bg-muted text-muted-foreground opacity-60" : "bg-card hover:bg-muted")}>
                      {t.name}
                      <span className="text-[0.68rem] font-normal opacity-80">{busy ? `#${t.orderNumber}` : `${t.seats} seats`}</span>
                      {on && chosen[0] === t.id && chosen.length > 1 && <span className="absolute top-1 right-1 rounded bg-white/25 px-1 text-[0.6rem]">main</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        <DialogFooter>
          <Button variant="outline" className="h-12" onClick={onClose}>Cancel</Button>
          <Button className="h-12" disabled={!chosen.length} onClick={() => onPick(chosen)}>{chosen.length > 1 ? `Join ${chosen.length} tables` : order.tableIds.length ? "Move here" : "Seat here"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Merge another open dine-in order into this one (REQ TBL-06): its items, tables and guests come over. */
function MergeDialog({ order, onClose, onPick }: { order: Order; onClose: () => void; onPick: (orderId: string) => void }) {
  const open = useApi<{ orders: Order[] }>("/orders?status=open");
  const list = (open.data?.orders ?? []).filter((x) => x.id !== order.id && x.orderType === "dine_in" && x.paid === 0);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Merge into {orderNo(order)}</DialogTitle>
          <DialogDescription>Choose the order to bring over. Its tables join this one.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {list.map((x) => (
            <button key={x.id} type="button" onClick={() => onPick(x.id)} className="flex h-14 items-center gap-3 rounded-xl border bg-card px-4 text-left transition-[background-color,transform] hover:bg-muted active:scale-[0.98]">
              <ArmchairIcon className="size-5 text-mod-sales" />
              <span className="flex-1 font-medium">{orderLabel(x)} <span className="font-mono text-xs text-muted-foreground">{orderNo(x)}</span></span>
              <span className="tabular-nums">{fmtIn(x.total, 2)}</span>
            </button>
          ))}
          {open.data && !list.length && <p className="text-sm text-muted-foreground">No other open table orders without payments.</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Split bill by item (REQ PAY-02): choose quantities for a new bill — paid separately, or moved to another table. */
function SplitDialog({ detail, currency, tableService, onClose, onDone }: {
  detail: OrderDetail; currency: string; tableService: boolean; onClose: () => void; onDone: (created: OrderDetail) => void;
}) {
  const lines = detail.lines.filter((l) => !l.isVoid);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const floor = useApi<FloorData>(tableService && detail.order.orderType === "dine_in" ? "/floor" : null);
  const [tableId, setTableId] = useState<string>("");
  const moving = lines.reduce((n, l) => n + (qty[l.id] ?? 0), 0);
  const amount = lines.reduce((t, l) => t + (qty[l.id] ?? 0) * l.unitPrice, 0);
  const all = lines.reduce((n, l) => n + l.qty, 0);
  async function go() {
    setBusy(true);
    try {
      const r = await api<{ source: OrderDetail; created: OrderDetail }>(`/orders/${detail.order.id}/split`, "POST", {
        lines: Object.entries(qty).filter(([, n]) => n > 0).map(([lineId, n]) => ({ lineId, qty: n })), tableId: tableId || null,
      }, { key: newKey() });
      onDone(r.created);
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Split bill · {orderNo(detail.order)}</DialogTitle>
          <DialogDescription>Tap + for what goes on the new bill. Everything else stays here.</DialogDescription>
        </DialogHeader>
        <div className="divide-y rounded-xl border">
          {lines.map((l) => {
            const n = qty[l.id] ?? 0;
            return (
              <div key={l.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{fmtQty(l.qty)} × {l.name}</div>
                  <div className="text-xs text-muted-foreground tabular-nums">{fmtIn(l.unitPrice, 2)} each</div>
                </div>
                <div className="flex h-11 items-center rounded-xl border bg-card">
                  <button type="button" aria-label="Fewer" className="flex size-11 items-center justify-center text-muted-foreground" onClick={() => setQty({ ...qty, [l.id]: Math.max(0, Number((n - 1).toFixed(3))) })}><MinusIcon className="size-4" /></button>
                  <span className={cn("w-7 text-center font-heading font-semibold tabular-nums", n > 0 && "text-primary")}>{n}</span>
                  <button type="button" aria-label="More" className="flex size-11 items-center justify-center text-muted-foreground" onClick={() => setQty({ ...qty, [l.id]: Math.min(l.qty, Number((n + 1).toFixed(3))) })}><PlusIcon className="size-4" /></button>
                </div>
              </div>
            );
          })}
        </div>
        {floor.data && (
          <label className="space-y-1.5">
            <span className="text-[0.8rem] font-medium text-foreground/80">New bill goes to</span>
            <select value={tableId} onChange={(e) => setTableId(e.target.value)} className="h-12 w-full rounded-xl border bg-card px-3 text-sm dark:bg-input/30">
              <option value="">A separate bill for this table</option>
              {floor.data.tables.filter((t) => !t.orderId).map((t) => <option key={t.id} value={t.id}>Table {t.name} (free)</option>)}
            </select>
          </label>
        )}
        <DialogFooter>
          <Button variant="outline" className="h-12" onClick={onClose}>Cancel</Button>
          <Button className="h-12 min-w-44" disabled={busy || !moving || moving >= all} onClick={go}>
            {moving >= all && moving > 0 ? "Leave something here" : `New bill · ${moving} item${moving === 1 ? "" : "s"} · ${currency} ${fmtIn(amount, 2)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Where the order is in the kitchen (REQ KIT-04): how many tickets are new, being prepared, ready to serve. */
function KitchenProgress({ tickets }: { tickets: OrderDetail["tickets"] }) {
  const live = tickets.filter((t) => !t.isCancel);
  const count = (s: string) => live.filter((t) => t.status === s).length;
  const chips: { key: string; label: string; cls: string }[] = [
    { key: "new", label: "sent", cls: "bg-mod-bank/12 text-mod-bank" },
    { key: "preparing", label: "preparing", cls: "bg-warning/12 text-warning" },
    { key: "ready", label: "ready to serve", cls: "bg-success/12 text-success animate-pulse" },
    { key: "served", label: "served", cls: "bg-muted text-muted-foreground" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <ChefHatIcon className="size-3.5 text-muted-foreground" />
      {chips.filter((c) => count(c.key)).map((c) => (
        <span key={c.key} className={cn("rounded-full px-2 py-0.5 font-medium", c.cls)}>{count(c.key)} {c.label}</span>
      ))}
    </div>
  );
}

/** A quantity typed on the numpad: a weight (0.350 kg) or part of an item (half a cake), up to the unit's decimals. */
function QtyDialog({ title, unit, decimals, initial, min = 0, onClose, onDone }: {
  title: string; unit: string | null; decimals: number; initial: string; min?: number; onClose: () => void; onDone: (qty: number) => void;
}) {
  const [v, setV] = useState(initial);
  const q = Number(v || 0);
  const ok = q > 0 && q <= 9999 && q >= min;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{unit ? `How much, in ${unit.toLowerCase()}?` : "How many?"}{min > 0 ? ` At least ${fmtQty(min)} (already sent).` : ""}</DialogDescription>
        </DialogHeader>
        <div className="rounded-xl border bg-muted/50 px-4 py-3 text-right font-heading text-3xl font-semibold tabular-nums">
          {v || "0"}{unit && <span className="ml-1.5 text-sm font-medium text-muted-foreground">{unit.toLowerCase()}</span>}
        </div>
        <Numpad value={v} onChange={setV} decimals={decimals} max={8} size="lg" onEnter={() => { if (ok) onDone(q); }} />
        <DialogFooter>
          <Button variant="outline" className="h-12" onClick={onClose}>Cancel</Button>
          <Button className="h-12 min-w-32" disabled={!ok} onClick={() => onDone(q)}>{initial ? "Change" : "Add"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
