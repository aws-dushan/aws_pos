import { fmtIn, roundTo } from "@/lib/num";
import type { Order, Settings } from "@/prototype/types";

export type Totals = {
  items: number;
  subtotal: number;
  discount: number;
  service: number;
  /** Net of VAT. */
  net: number;
  vat: number;
  total: number;
  paid: number;
  due: number;
};

/**
 * The bill of an order. Prices are VAT-inclusive or exclusive per Settings; the service charge
 * (dine-in only) is charged on the discounted amount and is itself subject to VAT (UAE rule).
 */
export function orderTotals(order: Order, s: Settings): Totals {
  const r2 = (n: number) => roundTo(n, 2);
  const subtotal = r2(order.lines.reduce((t, l) => t + l.price * l.qty, 0));
  const discount = r2(subtotal * (order.discountPct || 0) / 100);
  const afterDiscount = subtotal - discount;
  const service = order.type === "dine-in" ? r2(afterDiscount * s.serviceChargeRate / 100) : 0;
  const gross = afterDiscount + service;
  const rate = s.vatRate / 100;
  const vat = r2(s.vatInclusive ? gross - gross / (1 + rate) : gross * rate);
  const total = r2(s.vatInclusive ? gross : gross + vat);
  const paid = r2(order.payments.reduce((t, p) => t + p.amount, 0));
  return {
    items: order.lines.reduce((t, l) => t + l.qty, 0),
    subtotal, discount, service, vat, total, paid,
    net: r2(total - vat),
    due: r2(Math.max(0, total - paid)),
  };
}

/** Money with two decimals and thousands separators ("1,234.50"). */
export const money = (n: number) => fmtIn(n, 2);
