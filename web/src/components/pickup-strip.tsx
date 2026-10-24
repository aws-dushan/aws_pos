"use client";

import { BellRingIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useLiveEvent } from "@/components/live";

type Row = { id: string; number: number | null; customerName: string | null; platformName: string | null };
type Board = { mode: "off" | "auto" | "cashier"; preparing: Row[]; ready: Row[] };

/**
 * Where the cashier makes the orders (the branch's order-ready screen is "cashier marks ready"): the waiting order numbers on
 * the register; one tap puts a number up as ready on the screen. Nothing to mark afterwards: ready numbers leave by themselves.
 */
export function PickupStrip({ className }: { className?: string }) {
  const board = useApi<Board>("/pickup");
  useLiveEvent(["order.changed", "pickup.changed", "kitchen.changed"], () => board.reload());
  const b = board.data;
  if (!b || b.mode !== "cashier" || !b.preparing.length) return null;

  async function ready(r: Row) {
    try {
      await api(`/orders/${r.id}/pickup`, "PUT", { state: "ready" });
      board.reload();
      toast.success(`#${r.number} is up on the order-ready screen.`, {
        action: { label: "Undo", onClick: () => void api(`/orders/${r.id}/pickup`, "PUT", { state: "preparing" }).then(() => board.reload()) },
      });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className={cn("flex items-center gap-2 overflow-x-auto rounded-xl border border-success/25 bg-success/5 px-2 py-1.5 scrollbar-thin", className)}>
      <span className="flex shrink-0 items-center gap-1.5 px-1.5 text-xs font-medium text-success"><BellRingIcon className="size-4" /> Tap when ready</span>
      {b.preparing.map((r) => (
        <button key={r.id} type="button" onClick={() => void ready(r)}
          className="flex h-10 shrink-0 items-center gap-1.5 rounded-lg border bg-card px-3 text-sm transition-[background-color,transform] hover:bg-success/10 active:scale-[0.96]">
          <span className="font-heading text-base font-semibold tabular-nums">#{r.number}</span>
          {(r.platformName ?? r.customerName) && <span className="max-w-24 truncate text-xs text-muted-foreground">{r.platformName ?? r.customerName?.split(/\s+/)[0]}</span>}
        </button>
      ))}
    </div>
  );
}
