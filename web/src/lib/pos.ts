import { withBase } from "@/lib/base-path";

/** Shapes of the POS API (src/OnePos.Api/Pos) and small helpers shared by the register, orders and dashboard screens. */

export type OrderType = "dine_in" | "takeaway" | "delivery";
export type OrderStatus = "open" | "paid" | "void" | "refunded" | "merged";
export type PayMethod = "cash" | "card" | "other" | "voucher" | "account" | "points" | "platform";
export type Tone = "fin" | "sales" | "purch" | "inv" | "bp" | "bank" | "appr" | "admin";

export type MenuCategory = { id: string; name: string; nameAr: string | null; tone: Tone; sort: number; isActive: boolean };
export type MenuItem = {
  id: string; categoryId: string; name: string; nameAr: string | null; description: string | null; price: number; station: "kitchen" | "bar" | "none";
  erpItemCode: string | null; sort: number; isActive: boolean; groupIds: string[]; isSold: boolean; branchPrice: number | null; soldOut: boolean;
  /** Its recipe needs more of an ingredient than the branch has (only where the branch warns or blocks). */
  short?: boolean;
  hasImage: boolean; imageAt: string | null; isCombo: boolean;
  /** From FACTS: name and unit there, not reviewed yet, gone from FACTS, waiting for a price, stock at this branch's location. */
  erpName: string | null; erpUnit: string | null; qtyDecimals: number; erpNew: boolean; erpRemoved: boolean; needsPrice: boolean; erpStock: number | null; erpStockAt: string | null;
  /** This branch takes the price from its FACTS price type: branchPrice is FACTS' price (null = none there) and can't be changed here. */
  erpPriced: boolean;
  /** FACTS stock at its last read less what this branch sold since; null when the item has no FACTS stock. */
  stockLeft: number | null;
};

/** "#7", or "New" for an order that has no item yet (it's numbered when the first item is added). */
export const orderNo = (o: { number: number | null }) => (o.number ? `#${o.number}` : "New");

/** A quantity as people write it: 2, 1.5, 0.35 (up to 3 decimals, no trailing zeros). */
export const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3))));

/** Sold by weight or volume (FACTS unit with decimals): the till asks for the amount when it's tapped. */
const WEIGHT_UNITS = ["KG", "GM", "100GM", "LTR", "ML"];
export const byWeight = (i: MenuItem) => i.qtyDecimals > 0 && WEIGHT_UNITS.includes((i.erpUnit ?? "").toUpperCase());

/** No price yet (a FACTS item before a manager sets one): it can't be sold. */
export const noPrice = (i: MenuItem) => (i.needsPrice || i.erpPriced) && i.branchPrice === null;
export type ModifierOption = { id: string; groupId: string; name: string; price: number; sort: number; isActive: boolean; itemId: string | null };
export type ModifierGroup = { id: string; name: string; minSelect: number; maxSelect: number; options: ModifierOption[] };
export type ShortStock = "allow" | "warn" | "block";
export type Menu = { categories: MenuCategory[]; items: MenuItem[]; groups: ModifierGroup[]; shortStock?: ShortStock;
  /** Delivery platforms linked to a FACTS customer: their price per item here (FACTS items without one can't be sold on them). */
  platformPrices?: { platformId: string; prices: Record<string, number> }[] };

/** The menu as a platform's bill sees it: FACTS items at the platform's FACTS prices (none there = no price); others unchanged. */
export function withPlatformPrices(menu: Menu | undefined, platformId: string | null): Menu | undefined {
  const p = menu && platformId ? menu.platformPrices?.find((x) => x.platformId === platformId) : undefined;
  if (!menu || !p) return menu;
  return { ...menu, items: menu.items.map((i) => (i.erpItemCode ? { ...i, branchPrice: p.prices[i.id] ?? null, erpPriced: true } : i)) };
}

export type Order = {
  id: string; branchId: string; registerId: string | null; businessDate: string; number: number | null; orderType: OrderType; tableLabel: string | null;
  guests: number | null; customerId: string | null;
  /** A delivery platform's order (Talabat, Deliveroo…): the platform and its order number. */
  platformId: string | null; platformRef: string | null; platformName: string | null; platformCommission: number | null;
  customerName: string | null; customerPhone: string | null; deliveryAddress: string | null; note: string | null;
  /** The bill discount: % or AED, named when picked from the list or a platform's offer; who/why in the note. */
  discountAmount: number; discountSource: "cashier" | "typed" | "platform" | "customer" | null; discountName: string | null; discountNote: string | null;
  /** A platform's offer the platform pays: noted only (not a discount for us). */
  platformFunded: number;
  status: OrderStatus; discountPct: number; subtotal: number; discountTotal: number; serviceCharge: number; vat: number; total: number; paid: number;
  refunded: number; vatRate: number; pricesIncludeVat: boolean; servicePct: number; openedAt: string; closedAt: string | null; voidReason: string | null;
  version: number; registerName: string | null; openedByName: string | null; items: number; due: number;
  tableIds: string[]; tableNames: string | null; lockedBy: string | null; billPrintedAt: string | null; readyAt: string | null; collectedAt: string | null; splitFrom: string | null; invoiceNo: string | null;
};
export type OrderLine = {
  id: string; itemId: string | null; name: string; nameAr: string | null; unitPrice: number; qty: number; modifiers: { groupId: string; optionId: string; group: string; name: string; price: number }[];
  note: string | null; station: string; sentQty: number; lineTotal: number; vat: number; isVoid: boolean; voidReason: string | null; returnedQty: number;
  /** The discount the line got (the bigger of its own and its share of the bill discount). */
  discount: number;
  /** Its own discount: a promotion (automatic), a listed or typed item discount. */
  discSource: "promotion" | "cashier" | "typed" | null; discName: string | null; discType: "pct" | "amount" | "price" | null; discValue: number | null; discNote: string | null;
};
export type Payment = {
  id: string; kind: "payment" | "refund"; method: PayMethod; amount: number; tendered: number | null; changeGiven: number; reference: string | null;
  reason: string | null; at: string; takenByName: string | null;
  /** The FACTS card type of a card payment (e.g. "ERBQS VISA CARD"). */
  cardType?: string | null;
};
/** A FACTS card type's name without the outlet's location code: "ERBQS VISA CARD" → "VISA CARD". */
export const cardLabel = (cardType: string | null | undefined) => (cardType ? cardType.replace(/^\S+\s+/, "") : null);
export type TicketStatus = "new" | "preparing" | "ready" | "served";
export type KitchenTicket = {
  id: string; orderId: string; orderNumber: number; label: string; orderType: OrderType; station: "kitchen" | "bar"; isCancel: boolean; status: TicketStatus;
  createdAt: string; startedAt: string | null; readyAt: string | null; servedAt: string | null; printedAt: string | null; sentByName: string | null;
  lines: { qty: number; name: string; extras: string | null; note: string | null }[];
};
export type CreditNote = {
  id: string; number: string; businessDate: string; kind: "items" | "amount"; reason: string; method: PayMethod; total: number; vat: number; createdAt: string;
  createdByName: string | null; voucherCode: string | null; lines: { name: string; nameAr: string | null; qty: number; amount: number; vat: number; restock: boolean }[];
};
export type OrderDetail = { order: Order; lines: OrderLine[]; payments: Payment[]; tickets: KitchenTicket[]; creditNotes: CreditNote[] };

export const TYPE_LABEL: Record<OrderType, string> = { dine_in: "Dine-in", takeaway: "Takeaway", delivery: "Delivery" };
export const METHOD_LABEL: Record<PayMethod, string> = { cash: "Cash", card: "Card", other: "Other", voucher: "Voucher", account: "Account", points: "Points", platform: "Platform" };

/** The address of an item's photo (null when it has none). The version in it changes with each upload, so it is never stale. */
export const imageUrl = (companyId: string | undefined, i: MenuItem) =>
  i.hasImage && companyId ? withBase(`/api/menu/images/${companyId}/${i.id}?v=${encodeURIComponent(i.imageAt ?? "")}`) : null;

/** An item's own price here; a combo has none (it costs the prices on its choices). */
export const priceOf = (i: MenuItem) => (i.isCombo ? 0 : i.branchPrice ?? i.price);

/** The least an item costs with its required choices: a combo's "from" price. */
export const leastPrice = (i: MenuItem, groups: ModifierGroup[]) => priceOf(i) + groups.reduce((t, g) =>
  t + g.options.filter((o) => o.isActive).map((o) => o.price).sort((a, b) => a - b).slice(0, g.minSelect).reduce((s, p) => s + p, 0), 0);

/** How an order is named on screen: its table, its customer, or its type. */
export function orderLabel(o: Order) {
  if (o.orderType === "dine_in") return o.tableLabel ? `Table ${o.tableLabel}` : "Dine-in";
  if (o.platformName) return `${o.platformName}${o.platformRef ? ` #${o.platformRef}` : ""}`;
  return o.customerName || TYPE_LABEL[o.orderType];
}

/** Short initials of an item for its tile ("Mixed grill" → "MG"). */
export const initials = (s: string) => s.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

/** The live floor (API /floor). */
export type FloorTable = {
  id: string; floorId: string; name: string; seats: number; shape: "round" | "square" | "rect"; x: number; y: number; w: number; h: number; reserved: boolean;
  orderId: string | null; orderNumber: number | null; guests: number | null; total: number | null; openedAt: string | null; billPrintedAt: string | null;
  lockLabel: string | null; items: number | null; state: "free" | "seated" | "bill" | "reserved";
  /** The next booking within two hours (REQ TBL-07). */
  bookingId: string | null; bookingName: string | null; bookingAt: string | null; bookingGuests: number | null;
};
export type FloorData = { cols: number; rows: number; floors: { id: string; name: string; sort: number }[]; tables: FloorTable[] };
