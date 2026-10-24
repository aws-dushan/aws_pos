"use client";

import { useState } from "react";
import { LayersIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { useSession } from "@/components/session";
import { EmptyState, ErrorNote, LoadingRows, PageHeader, Pill, SearchField, Segmented, TablePanel, TONE } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Line = { itemType: string; itemCode: string; itemName: string; unit: string; qty: number };
type Version = { id: string; validFrom: string; validTo: string | null; note: string | null; locked: boolean; lines: Line[] };
type Row = { itemType: string; itemCode: string; itemName: string; unit: string; menuItems: string[];
  bom: { id: string; factsDoc: string | null; syncedAt: string | null; endedFrom: string | null; currentVersionId: string | null; versions: Version[] } | null };

const day = (d: string) => new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const qty = (n: number) => n.toLocaleString("en-GB", { maximumFractionDigits: 6 });
const keyOf = (r: { itemType: string; itemCode: string }) => `${r.itemType}:${r.itemCode}`;

/**
 * BOM: the raw and packing materials of items made at the outlet (a cappuccino: coffee beans, milk, a cup). They come from FACTS —
 * the outlet bills of materials (BOMO50) — with the regular sync; finance changes them in FACTS. An item with a BOM sells without
 * stock of its own, and each day's use goes to FACTS as a draft repacking voucher (RPO50) for finance to post.
 */
export default function BomsPage() {
  const { can } = useSession();
  const list = useApi<{ today: string; items: Row[]; lastSync: { at: string | null; ok: boolean | null; message: string | null } }>("/boms");
  const [q, setQ] = useState("");
  const [view, setView] = useState<"all" | "with" | "without">("with");
  const [open, setOpen] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const today = list.data?.today ?? new Date().toISOString().slice(0, 10);
  const rows = (list.data?.items ?? []).filter((r) => (view === "all" || (view === "with") === !!r.bom)
    && (!q || `${r.itemCode} ${r.itemName} ${r.menuItems.join(" ")}`.toLowerCase().includes(q.toLowerCase())));
  const sel = list.data?.items.find((r) => keyOf(r) === open) ?? null;
  const withBom = (list.data?.items ?? []).filter((r) => r.bom).length;
  const last = list.data?.lastSync;

  async function sync() {
    setSyncing(true);
    try {
      const r = await api<{ boms: number; made: number; changed: number; ended: number }>("/erp/sync/boms", "POST");
      toast.success(`BOMs read from FACTS: ${r.boms}${r.made ? `, ${r.made} new` : ""}${r.changed ? `, ${r.changed} changed` : ""}${r.ended ? `, ${r.ended} no longer active` : ""}.`);
      list.reload();
    } catch (e) { toast.error((e as Error).message); } finally { setSyncing(false); }
  }

  return (
    <div className="mx-auto max-w-[1180px] pb-6">
      <PageHeader title="BOM · raw materials" icon={LayersIcon} count={withBom || null}
        description="From FACTS (outlet BOMs, BOMO50). An item with a BOM sells without stock of its own; each day's raw and packing materials go to FACTS as a draft repacking voucher. To change a BOM, change it in FACTS."
        actions={(can("menu.manage") || can("facts.post")) && (
          <Button variant="outline" className="h-11" disabled={syncing} onClick={() => void sync()}>
            {syncing ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />} Sync from FACTS
          </Button>
        )} />
      {last?.at && (
        <p className={cn("-mt-2 mb-3 text-xs", last.ok === false ? "text-danger" : "text-muted-foreground")}>
          {last.ok === false ? `Last read from FACTS failed ${timeAgo(last.at)}: ${last.message}` : `Read from FACTS ${timeAgo(last.at)} (every few minutes).`}
        </p>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchField placeholder="Search item, menu name or FACTS code" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm flex-1" />
        <Segmented id="bom-view" value={view} onChange={setView} options={[{ value: "with", label: "With BOM" }, { value: "without", label: "No BOM" }, { value: "all", label: "All items" }]} />
      </div>
      {list.error ? <ErrorNote message={list.error} /> : list.loading && !list.data ? <LoadingRows /> : rows.length === 0 ? (
        <EmptyState icon={LayersIcon} title={q ? "Nothing matches" : view === "with" ? "No BOMs from FACTS yet" : "Nothing here"} module="inv">
          {q ? "No item matches." : view === "with" ? "Press Sync from FACTS, or wait for the next sync. BOMs are the outlet bills of materials (BOMO50) in FACTS." : "No items."}
        </EmptyState>
      ) : (
        <TablePanel>
          <Table>
            <TableHeader><TableRow><TableHead>Item</TableHead><TableHead>Raw and packing materials (for 1)</TableHead><TableHead>From</TableHead></TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => {
                const cur = r.bom?.versions.find((v) => v.id === r.bom!.currentVersionId);
                const name = r.menuItems[0] ?? r.itemName;
                return (
                  <TableRow key={keyOf(r)} onClick={() => r.bom && setOpen(keyOf(r))} className={cn(r.bom && "cursor-pointer")}>
                    <TableCell className="whitespace-normal">
                      <div className="font-medium">{name}</div>
                      <div className="text-xs text-muted-foreground">FACTS <span className="font-mono">{r.itemCode}</span>{r.itemName !== name ? ` · ${r.itemName}` : ""}{!r.menuItems.length && r.bom ? " · not on the menu" : ""}</div>
                    </TableCell>
                    <TableCell className="whitespace-normal text-sm">
                      {!r.bom ? <span className="text-muted-foreground">No BOM in FACTS</span>
                        : r.bom.endedFrom && r.bom.endedFrom <= today ? <Pill className={TONE.muted} dot>Not active in FACTS since {day(r.bom.endedFrom)} · sells from stock</Pill>
                        : cur ? cur.lines.map((l) => `${l.itemName.toLowerCase()} ${qty(l.qty)} ${l.unit}`).join(" · ")
                        : <Pill className={TONE.open} dot>From {day(r.bom.versions[r.bom.versions.length - 1].validFrom)}</Pill>}
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap text-muted-foreground">{r.bom?.factsDoc ?? (r.bom ? "One POS" : "")}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TablePanel>
      )}
      {sel?.bom && (
        <Dialog open onOpenChange={(o) => { if (!o) setOpen(null); }}>
          <DialogContent className="max-h-[calc(100dvh-1rem)] sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>BOM · {sel.menuItems[0] ?? sel.itemName}</DialogTitle>
              <DialogDescription>For 1 {sel.unit} of FACTS {sel.itemCode} {sel.itemName}{sel.bom.factsDoc ? `, from ${sel.bom.factsDoc}` : ""}. Change it in FACTS; One POS reads it every few minutes.</DialogDescription>
            </DialogHeader>
            {sel.bom.versions.map((v) => (
              <div key={v.id} className={cn("overflow-hidden rounded-2xl border bg-card", v.id === sel.bom!.currentVersionId && "ring-2 ring-primary/40")}>
                <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2.5 text-sm">
                  <span className="font-medium">From {day(v.validFrom)}{v.validTo ? ` to ${day(v.validTo)}` : ""}</span>
                  {v.id === sel.bom!.currentVersionId && <Pill className={TONE.done} dot>In use</Pill>}
                  {v.validFrom > today && <Pill className={TONE.open} dot>Starts later</Pill>}
                  {v.locked && <Pill className={TONE.muted}>Sent to FACTS</Pill>}
                  {v.note && <span className="text-xs text-muted-foreground">{v.note}</span>}
                </div>
                <table className="w-full text-sm">
                  <tbody>
                    {v.lines.map((l) => (
                      <tr key={l.itemCode} className="border-b last:border-0">
                        <td className="px-4 py-2">{l.itemName} <span className="font-mono text-xs text-muted-foreground">{l.itemCode}</span></td>
                        <td className="px-4 py-2 text-right tabular-nums">{qty(l.qty)} <span className="text-muted-foreground">{l.unit}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            <DialogFooter><Button variant="outline" className="h-11" onClick={() => setOpen(null)}>Close</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
