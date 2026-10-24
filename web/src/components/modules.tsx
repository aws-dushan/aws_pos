"use client";

import { usePathname } from "next/navigation";
import { ArmchairIcon, PercentIcon, LayersIcon, BarChart3Icon, PackageIcon, CalendarClockIcon, CalendarDaysIcon, ContactRoundIcon, CookingPotIcon, GiftIcon, NotebookPenIcon, Building2Icon, ChefHatIcon, HomeIcon, LayoutGridIcon, MessageSquareWarningIcon, PrinterIcon, ReceiptTextIcon, ScrollTextIcon, ShieldCheckIcon, ShoppingBasketIcon, UsersRoundIcon, UtensilsCrossedIcon, BikeIcon, NewspaperIcon, CloudUploadIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/*
 * The screens of One POS and their accent colours. The colours are AWS One's module tokens
 * (--mod-fin …, globals.css): an element with data-module="sales" makes `bg-mod`, `text-mod`,
 * `bg-mod-grad` … use that colour, exactly as in AWS One.
 */

export type ModuleKey = "home" | "fin" | "sales" | "purch" | "inv" | "bp" | "bank" | "admin" | "appr";

type IconType = React.ComponentType<{ className?: string }>;

export type Screen = {
  href: string; label: string; icon: IconType; module: ModuleKey; hint: string; group: "Service" | "Back office" | "Administration";
  /** Shown only to administrators. */
  admin?: boolean;
  /** Shown only with this permission ("a|b": either). */
  perm?: string;
  /** Shown only where the branch has table service. */
  tableOnly?: boolean;
  /** Shown only where the branch runs a kitchen (off for a café or counter). */
  kitchenOnly?: boolean;
  /** Shown only where an administrator switched on vouchers or loyalty for the company. */
  rewardsOnly?: boolean;
  /** Shown only where the company is connected to FACTS. */
  factsOnly?: boolean;
};

/** The screens built so far, in menu order. Service screens (register, floor, kitchen…) join in phases 1–2. */
export const SCREENS: Screen[] = [
  { href: "/", label: "Dashboard", icon: HomeIcon, module: "home", hint: "Today's sales", group: "Service" },
  { href: "/floor", label: "Floor", icon: ArmchairIcon, module: "sales", hint: "Tables and who's seated", group: "Service", perm: "pos.sell", tableOnly: true },
  { href: "/reservations", label: "Reservations", icon: CalendarDaysIcon, module: "appr", hint: "Table bookings by day", group: "Service", perm: "pos.sell", tableOnly: true },
  { href: "/register", label: "Register", icon: ShoppingBasketIcon, module: "fin", hint: "Take orders and payments", group: "Service", perm: "pos.sell" },
  { href: "/kitchen", label: "Kitchen", icon: ChefHatIcon, module: "purch", hint: "Kitchen display", group: "Service", perm: "kitchen.view", kitchenOnly: true },
  { href: "/day", label: "Day & shifts", icon: CalendarClockIcon, module: "appr", hint: "Open and close the day, shifts, cash counts", group: "Service", perm: "day.shift|day.manage" },
  { href: "/approvals", label: "Approvals", icon: ShieldCheckIcon, module: "appr", hint: "Requests from the tills", group: "Service", perm: "day.manage|pos.refund" },
  { href: "/stock", label: "Stock", icon: PackageIcon, module: "inv", hint: "Wastage and deliveries", group: "Back office", perm: "pos.sell|kitchen.view|facts.post" },
  { href: "/ingredients", label: "Ingredients", icon: CookingPotIcon, module: "inv", hint: "Recipes, ingredient stock, food cost", group: "Back office", perm: "menu.manage|day.manage|kitchen.view" },
  { href: "/reports", label: "Reports", icon: BarChart3Icon, module: "bank", hint: "Sales by day, item, payment, cashier", group: "Back office", perm: "reports.view" },
  { href: "/customers", label: "Customers", icon: ContactRoundIcon, module: "bp", hint: "Regulars, visits and history", group: "Back office", perm: "pos.sell" },
  { href: "/vouchers", label: "Vouchers & loyalty", icon: GiftIcon, module: "sales", hint: "Gift vouchers, store credit, points", group: "Back office", perm: "day.manage|reports.view", rewardsOnly: true },
  { href: "/platforms", label: "Delivery platform report", icon: BikeIcon, module: "bank", hint: "Platform sales, commission and what they owe", group: "Back office", perm: "reports.view" },
  { href: "/paper", label: "Paper sales", icon: NotebookPenIcon, module: "bank", hint: "Outage pads and keying in slips", group: "Back office", perm: "day.manage" },
  { href: "/orders", label: "Orders", icon: ReceiptTextIcon, module: "bank", hint: "Today's orders, receipts, refunds", group: "Service", perm: "pos.sell" },
  { href: "/boms", label: "BOM (raw materials)", icon: LayersIcon, module: "inv", hint: "Raw materials of items made at the branch", group: "Back office", perm: "menu.manage|facts.post", factsOnly: true },
  { href: "/discounts", label: "Discounts", icon: PercentIcon, module: "sales", hint: "Promotions and cashier discounts", group: "Back office", perm: "menu.manage" },
  { href: "/menu", label: "Menu", icon: UtensilsCrossedIcon, module: "inv", hint: "Categories, items, options, prices", group: "Back office", perm: "menu.manage" },
  { href: "/tables", label: "Tables & floors", icon: LayoutGridIcon, module: "sales", hint: "Floor plan designer", group: "Back office", perm: "tables.manage", tableOnly: true },
  { href: "/admin/companies", label: "Companies & branches", icon: Building2Icon, module: "admin", hint: "Outlets, tax, ERP, table service", group: "Administration", perm: "branch.manage" },
  { href: "/devices", label: "Devices", icon: PrinterIcon, module: "admin", hint: "Printer, cash drawer, customer display", group: "Administration", perm: "branch.manage" },
  { href: "/branding", label: "Receipt & display", icon: ReceiptTextIcon, module: "admin", hint: "Logo, receipt header, customer display pictures", group: "Administration", perm: "branch.manage" },
  { href: "/admin/platforms", label: "Delivery platforms", icon: BikeIcon, module: "bank", hint: "Talabat, Deliveroo… and their commission", group: "Administration", perm: "branch.manage" },
  { href: "/admin/facts-posting", label: "FACTS posting", icon: CloudUploadIcon, module: "admin", hint: "Bills to FACTS, dry run, posting log", group: "Administration", perm: "facts.post|branch.manage" },
  { href: "/admin/alerts", label: "Daily summary & alerts", icon: NewspaperIcon, module: "appr", hint: "Day-close summary, exception alerts, email", group: "Administration", perm: "branch.manage" },
  { href: "/admin/users", label: "Users", icon: UsersRoundIcon, module: "bp", hint: "People, PINs, branches", group: "Administration", perm: "users.manage" },
  { href: "/admin/roles", label: "Roles", icon: ShieldCheckIcon, module: "appr", hint: "What each role may do", group: "Administration", perm: "users.manage" },
  { href: "/admin/audit", label: "Audit log", icon: ScrollTextIcon, module: "bank", hint: "Who did what, when", group: "Administration", perm: "audit.view" },
  { href: "/admin/feedback", label: "Problem reports", icon: MessageSquareWarningIcon, module: "admin", hint: "Report a problem inbox: status, assignee, answers", group: "Administration", admin: true },
];

/** The screen a path belongs to (longest prefix wins). */
export function screenOf(path: string): Screen {
  const p = path.split("?")[0];
  return [...SCREENS].sort((a, b) => b.href.length - a.href.length)
    .find((s) => (s.href === "/" ? p === "/" : p === s.href || p.startsWith(s.href + "/"))) ?? SCREENS[0];
}

export function useModule(): ModuleKey {
  return screenOf(usePathname()).module;
}

const SIZES = {
  xs: "size-5 rounded-md [&_svg]:size-3",
  sm: "size-7 rounded-lg [&_svg]:size-3.5",
  md: "size-9 rounded-xl [&_svg]:size-[1.15rem]",
  lg: "size-12 rounded-2xl [&_svg]:size-6",
};

/** A module's icon on a soft tile of its accent colour; `solid`: a gradient badge with a white icon. */
export function ModuleIcon({ module, icon: Icon, size = "md", solid, className }: {
  module: ModuleKey; icon: IconType; size?: keyof typeof SIZES; solid?: boolean; className?: string;
}) {
  return (
    <span
      data-module={module}
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        solid ? "bg-mod-grad text-white shadow-[0_4px_12px_-4px_var(--mod),inset_0_1px_0_oklch(1_0_0/0.25)]" : "bg-mod/12 text-mod ring-1 ring-mod/15 ring-inset",
        SIZES[size],
        className,
      )}
    >
      <Icon />
    </span>
  );
}
