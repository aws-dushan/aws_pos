"use client";

import { useState } from "react";
import { InboxIcon } from "lucide-react";
import { toast } from "sonner";
import { api, newKey } from "@/lib/api";
import { cn } from "@/lib/utils";
import { openDrawer } from "@/lib/device";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const REASONS = ["Change for a customer", "Check the float", "Wrong change given", "Put cash in"];

/**
 * No-sale (REQ HW-04): open the cash drawer without a sale. Needs pos.nosale and a reason; it's kept (who, till, shift, why)
 * and shows on the exceptions report and the day's Z report.
 */
export function NoSaleDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [was, setWas] = useState(open);
  if (open !== was) { setWas(open); if (open) setReason(""); }

  async function go() {
    setBusy(true);
    try {
      await api("/drawer/no-sale", "POST", { reason }, { key: newKey() });
      try {
        await openDrawer(newKey());
        toast.success("Drawer opened. Recorded as a no-sale.");
      } catch {
        toast.warning("Recorded, but no cash drawer answered on this till (Devices).");
      }
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>No sale: open the drawer</DialogTitle>
          <DialogDescription>It&apos;s recorded with your name and the reason, and shows on the exceptions report.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          {REASONS.map((r) => (
            <button key={r} type="button" onClick={() => setReason(r)} aria-pressed={reason === r}
              className={cn("h-11 rounded-xl border px-3.5 text-sm transition-[background-color,transform] active:scale-[0.97]", reason === r ? "border-primary bg-primary/10 font-medium text-primary" : "bg-card hover:bg-muted")}>{r}</button>
          ))}
        </div>
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Or type the reason"
          className="h-11 w-full rounded-xl border bg-card px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/40" />
        <DialogFooter>
          <Button variant="outline" className="h-11" onClick={onClose}>Cancel</Button>
          <Button className="h-11" disabled={busy || !reason.trim()} onClick={() => void go()}><InboxIcon /> Open drawer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
