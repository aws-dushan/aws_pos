/*
 * One POS data model. Kept deliberately close to how AWS One stores documents, so an order can later
 * post to AWS One as a sales invoice (lines, VAT, payments) without reshaping.
 */

export type OrderType = "dine-in" | "takeaway" | "delivery";
export type TableShape = "round" | "square" | "rect";
export type Station = "kitchen" | "bar";
export type PayMethod = "cash" | "card" | "other";

export type Settings = {
  restaurantName: string;
  outletCode: string;
  currency: string;
  /** VAT rate in percent (UAE: 5). */
  vatRate: number;
  /** Menu prices already include VAT (the UAE norm for restaurants). */
  vatInclusive: boolean;
  /** Service charge in percent, dine-in only; 0 = off. */
  serviceChargeRate: number;
  /**
   * Table service. On: dine-in orders sit on tables of a floor plan (Floor screen, table configuration,
   * guests, transfers). Off: quick service — every order is takeaway or delivery and gets a ticket number.
   */
  tableService: boolean;
  /** With table service: ask for the number of guests when a table is opened. */
  askGuests: boolean;
  /** Without table service: the order type a new order starts as. */
  defaultQuickType: Exclude<OrderType, "dine-in">;
  cashierName: string;
};

export type Floor = { id: string; name: string };

/** A table on a floor plan. x / y / w / h are grid cells of the floor canvas (see FLOOR_GRID). */
export type Table = {
  id: string;
  floorId: string;
  name: string;
  seats: number;
  shape: TableShape;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Held for a reservation (shown on the floor; can still be opened). */
  reserved?: boolean;
};

export type Category = { id: string; name: string; tone: Tone };
export type Tone = "fin" | "sales" | "purch" | "inv" | "bp" | "bank" | "appr" | "admin";

export type MenuItem = {
  id: string;
  categoryId: string;
  name: string;
  price: number;
  description?: string;
  station: Station;
  available: boolean;
};

export type OrderLine = {
  id: string;
  itemId: string;
  name: string;
  price: number;
  qty: number;
  note?: string;
  /** How many of qty have gone to the kitchen already. */
  sentQty: number;
  station: Station;
};

export type Payment = { id: string; method: PayMethod; amount: number; tendered?: number; at: string };

export type OrderStatus = "open" | "paid" | "void";

export type Order = {
  id: string;
  number: number;
  type: OrderType;
  tableId?: string;
  guests?: number;
  customerName?: string;
  lines: OrderLine[];
  discountPct: number;
  status: OrderStatus;
  billRequested?: boolean;
  createdAt: string;
  paidAt?: string;
  payments: Payment[];
  cashier: string;
};

export type TicketStatus = "new" | "preparing" | "ready" | "served";

/** A kitchen/bar ticket (KOT): the lines sent in one "Send" from the register. */
export type Ticket = {
  id: string;
  orderId: string;
  orderNumber: number;
  label: string;
  type: OrderType;
  station: Station;
  lines: { name: string; qty: number; note?: string }[];
  createdAt: string;
  status: TicketStatus;
};

export type PosState = {
  version: 1;
  settings: Settings;
  floors: Floor[];
  tables: Table[];
  categories: Category[];
  items: MenuItem[];
  orders: Order[];
  tickets: Ticket[];
  nextOrderNumber: number;
};
