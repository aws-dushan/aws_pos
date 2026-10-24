"use client";

import { MonitorSmartphoneIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { FieldGroup, ObjectStatus, TONE } from "@/components/kit";
import { Button } from "@/components/ui/button";

type Row = {
  id: string; registerName: string | null; machine: string | null; userName: string | null; serviceVersion: string | null; receiptPrinter: string | null;
  printerState: string | null; lastPrintAt: string | null; lastError: string | null; lastSeen: string; online: boolean;
};

/** The printer's state as a coloured tag: ready green, a problem red, no word from the spooler grey. */
function PrinterTag({ state }: { state: string | null }) {
  if (!state) return <ObjectStatus className={TONE.muted}>—</ObjectStatus>;
  const tone = state === "ready" ? TONE.done : state === "unknown" ? TONE.muted : TONE.danger;
  return <ObjectStatus className={tone}>{state[0].toUpperCase() + state.slice(1)}</ObjectStatus>;
}

/**
 * Every PC of this branch running One POS (REQ HW-08): online (seen in the last 2 minutes) or when last seen, its Device Service,
 * receipt printer and the printer's state, last print and last error. Each PC reports itself once a minute.
 */
export function BranchDevices() {
  const list = useApi<Row[]>("/devices");
  const rows = list.data ?? [];
  const problems = rows.filter((r) => r.online && (!r.serviceVersion || (r.printerState && !["ready", "unknown"].includes(r.printerState)) || r.lastError)).length;

  async function forget(r: Row) {
    try { await api(`/devices/${r.id}`, "DELETE"); list.reload(); toast.success("Removed from the list. It comes back if it reports again."); }
    catch (e) { toast.error((e as Error).message); }
  }

  return (
    <FieldGroup title="This branch's PCs" className="p-0"
      description={`Each PC running One POS reports every minute.${problems ? ` ${problems} need${problems === 1 ? "s" : ""} a look.` : ""}`}
      actions={<Button variant="outline" className="h-10" onClick={() => list.reload()}>Refresh</Button>}>
      {!list.data ? <div className="h-24 skeleton-shimmer" /> : rows.length ? (
        <div className="divide-y">
          {rows.map((r) => (
            <div key={r.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-5 py-3 md:grid-cols-[auto_minmax(0,1.2fr)_minmax(0,1fr)_9rem_auto]">
              <span className={cn("size-2.5 shrink-0 rounded-full", r.online ? "bg-success" : "bg-muted-foreground/40")} aria-label={r.online ? "Online" : "Offline"} />
              <div className="min-w-0">
                {/* The PC first (its Windows name, from the Device Service); the till it was signed in to is only a detail. */}
                <div className="font-medium">{r.machine ?? <span className="text-muted-foreground">Unnamed PC (no Device Service)</span>}</div>
                <div className="text-xs text-muted-foreground">
                  {r.online ? "Online" : `Last seen ${timeAgo(r.lastSeen)}`} · {r.registerName ? `signed in to ${r.registerName}` : "back office"}{r.userName ? ` · ${r.userName}` : ""}
                </div>
              </div>
              <div className="min-w-0 text-sm max-md:col-start-2">
                {r.serviceVersion ? <span>Device Service {r.serviceVersion}</span> : <span className="text-warning">No Device Service</span>}
                {r.receiptPrinter && <div className="truncate text-xs text-muted-foreground" title={r.receiptPrinter}>{r.receiptPrinter}</div>}
              </div>
              <div className="flex flex-col items-start gap-0.5 max-md:col-start-2">
                {r.serviceVersion && r.receiptPrinter ? <PrinterTag state={r.printerState} /> : r.serviceVersion ? <ObjectStatus className={TONE.warn}>No printer chosen</ObjectStatus> : null}
                {r.lastPrintAt && <span className="text-xs text-muted-foreground">Printed {timeAgo(r.lastPrintAt)}</span>}
              </div>
              <div className="flex justify-end max-md:col-start-3 max-md:row-start-1">
                {!r.online && <Button variant="ghost" size="icon" aria-label="Remove from the list" onClick={() => void forget(r)}><Trash2Icon /></Button>}
              </div>
              {r.lastError && <div className="col-span-full truncate pl-6 text-xs text-danger" title={r.lastError}>Last error: {r.lastError}</div>}
            </div>
          ))}
        </div>
      ) : (
        <p className="flex items-center gap-2 px-5 py-6 text-sm text-muted-foreground"><MonitorSmartphoneIcon className="size-4" /> No PC has reported yet. Each one shows here once One POS is open on it.</p>
      )}
    </FieldGroup>
  );
}
