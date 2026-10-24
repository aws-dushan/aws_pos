import type { OrderType, PayMethod } from "@/lib/pos";

/*
 * Arabic for bilingual receipts and credit notes (REQ UX-05). English stays on the left of a line, Arabic on its right before
 * the amount; item names in Arabic go on their own line under the English name.
 */

export const AR = {
  taxInvoice: "فاتورة ضريبية",
  bill: "فاتورة · غير مدفوعة",
  creditNote: "إشعار دائن ضريبي",
  against: "مقابل الفاتورة الضريبية",
  trn: "الرقم الضريبي",
  tel: "هاتف",
  subtotal: "المبلغ الأساسي",
  beforeVat: "المبلغ قبل الضريبة",
  grandTotal: "المجموع الكلي",
  received: "المستلم",
  item: "الصنف",
  qty: "الكمية",
  lineTotal: "المجموع",
  discount: "الخصم",
  service: "رسوم الخدمة",
  vat: "ضريبة القيمة المضافة",
  total: "الإجمالي",
  paid: "مدفوع",
  refund: "مسترد",
  change: "الباقي",
  refundTotal: "إجمالي المبلغ المسترد",
  table: "طاولة",
} as const;

export const METHOD_AR: Record<PayMethod, string> = { cash: "نقداً", card: "بطاقة", other: "أخرى", voucher: "قسيمة", account: "حساب", points: "نقاط", platform: "منصة توصيل" };
export const TYPE_AR: Record<OrderType, string> = { dine_in: "محلي", takeaway: "سفري", delivery: "توصيل" };
