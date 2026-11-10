"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DownloadIcon, RotateCcwIcon, SearchIcon, TagIcon, UploadIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtIn } from "@/lib/num";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { EmptyState, ErrorNote, LoadingRows, PageHeader, Pill, Segmented, TablePanel, TONE } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { downloadTemplate, readPrices, type XResult } from "./excel";

type Platform = { id: string; name: string; customer: string };
type Item = { id: string; code: string; name: string; category: string; outlet: number | null; platforms: Record<string, number> };
type PricesData = { branch: { code: string; priceType: string | null; platformLocation: string | null; factsUser: string | null }; platforms: Platform[]; items: Item[] };
type DocLine = { itemId: string; code: string; name: string; old: number | null; new: number };
type Doc = { id: string; kind: "outlet" | "platform"; platform: string | null; priceType: string | null; location: string | null; status: "posting" | "posted" | "failed";
  factsDocType: string | null; factsDoc: string | null; error: string | null; postedAt: string | null; lines: DocLine[] };
type PriceChange = { id: string; remark: string | null; factsUser: string; createdAt: string; by: string; docs: Doc[] };

const money = (n: number) => fmtIn(n, 2);
/** A cell: the item and the platform ("" = the outlet price). */
const key = (itemId: string, platformId: string) => `${itemId}|${platformId}`;
const parse = (s: string) => (/^\d+(\.\d{1,2})?$/.test(s.trim()) ? Number(s) : null);

/**
 * Prices: the selling prices (VAT included, as the till charges them) of the items enabled for selling here, at the outlet and on
 * each delivery platform. Changed prices are posted in FACTS straight away as the branch's FACTS user for price posting: outlet
 * prices as an outlet price import (OSMPI), platform prices as one customer price list (CPL50) per platform. Per header branch.
 */
export default function PricesPage() {
  const { branch } = useSession();
  const data = useApi<PricesData>("/prices");
  const reloadData = data.reload;
  const history = useApi<PriceChange[]>("/prices/changes");
  // After a post the till's prices are read back from FACTS in the background: the posted prices stay on the screen until they arrive.
  const [updating, setUpdating] = useState(false);
  const updatingRef = useRef(false);
  const clearOnLoad = useRef(false);
  useLiveEvent(["menu.changed"], () => { if (updatingRef.current) clearOnLoad.current = true; data.reload(); });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<"all" | "missing" | "changed">("all");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [posting, setPosting] = useState(false);
  const [tab, setTab] = useState<"prices" | "history">("prices");
  const fileRef = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<{ file: string; result: XResult } | null>(null);
  const [excelBusy, setExcelBusy] = useState(false);
  useEffect(() => {
    if (!clearOnLoad.current || data.loading) return;
    clearOnLoad.current = false; updatingRef.current = false;
    setEdits({}); setUpdating(false);
  }, [data.loading, data.data]);
  useEffect(() => {
    if (!updating) return;
    const t = setTimeout(() => { clearOnLoad.current = true; reloadData(); }, 90_000);
    return () => clearTimeout(t);
  }, [updating, reloadData]);
  const d = data.data;
  const platforms = useMemo(() => d?.platforms ?? [], [d]);

  const current = (i: Item, pid: string) => (pid === "" ? i.outlet : i.platforms[pid] ?? null);
  // The changes: cells typed in with a valid price different from what FACTS has now.
  const changes = useMemo(() => {
    if (!d) return [];
    const out: { item: Item; platformId: string; old: number | null; price: number }[] = [];
    for (const i of d.items)
      for (const pid of ["", ...d.platforms.map((p) => p.id)]) {
        const s = edits[key(i.id, pid)];
        if (s === undefined) continue;
        const v = parse(s);
        if (v !== null && v > 0 && v !== current(i, pid)) out.push({ item: i, platformId: pid, old: current(i, pid), price: v });
      }
    return out;
  }, [d, edits]);
  const invalid = Object.values(edits).filter((s) => s.trim() !== "" && (parse(s) === null || parse(s) === 0)).length;
  const changedItems = new Set(changes.map((c) => c.item.id));
  const missing = (i: Item) => platforms.some((p) => i.platforms[p.id] === undefined && !edits[key(i.id, p.id)]);
  const cats = [...new Set((d?.items ?? []).map((i) => i.category))];
  const shown = (d?.items ?? []).filter((i) =>
    (!cat || i.category === cat) && (!q.trim() || `${i.code} ${i.name}`.toLowerCase().includes(q.trim().toLowerCase()))
    && (filter === "all" || (filter === "missing" ? missing(i) : changedItems.has(i.id))));
  const missingCount = (d?.items ?? []).filter(missing).length;

  // What posting makes in FACTS: one outlet import and one price list per platform with changes.
  const docs = useMemo(() => {
    const out: { label: string; n: number }[] = [];
    const outlet = changes.filter((c) => c.platformId === "").length;
    if (outlet) out.push({ label: `Outlet prices · OSMPI · ${d?.branch.priceType ?? ""}`, n: outlet });
    for (const p of platforms) {
      const n = changes.filter((c) => c.platformId === p.id).length;
      if (n) out.push({ label: `${p.name} · CPL50 · ${d?.branch.platformLocation ?? ""}`, n });
    }
    return out;
  }, [changes, platforms, d]);

  const blockers = [
    !d?.branch.factsUser && "This branch has no FACTS user for price posting (Companies & branches → the branch → Price posting).",
    !d?.branch.priceType && "This branch has no FACTS price type, so outlet prices can't be posted.",
    platforms.length > 0 && !d?.branch.platformLocation && "This branch has no platform price location, so platform prices can't be posted.",
  ].filter(Boolean) as string[];

  return (
    <div className="pb-24">
      <PageHeader title="Prices" icon={TagIcon} module="sales" count={d?.items.length}
        description={`Selling prices at ${branch?.name ?? "this branch"}, VAT included, exactly as the till charges them. Only items enabled for selling here. Posting puts them in FACTS straight away; the till has them within a minute.`} />
      <ErrorNote message={data.error} />
      {d && blockers.length > 0 && (
        <div className="mb-4 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-warning">{blockers.map((b) => <div key={b}>{b}</div>)}</div>
      )}
      <Segmented id="price-tab" value={tab} onChange={setTab} className="mb-4"
        options={[{ value: "prices", label: "Prices" }, { value: "history", label: `History${history.data?.length ? ` ${history.data.length}` : ""}` }]} />
      {tab === "history" ? (
        <History data={history.data} error={history.error} onRetried={() => { history.reload(); data.reload(); }} />
      ) : data.loading && !d ? <LoadingRows rows={6} /> : d && (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <Segmented id="price-filter" value={filter} onChange={setFilter} size="sm"
              options={[{ value: "all", label: `All ${d.items.length}` }, { value: "missing", label: `Missing on a platform ${missingCount}` }, { value: "changed", label: `Changed ${changedItems.size}` }]} />
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input id="price-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search code or name" className="h-9 w-56 pl-9" />
              </div>
              <select id="price-cat" value={cat} onChange={(e) => setCat(e.target.value)} className="h-9 rounded-xl border border-input bg-card px-3 text-sm dark:bg-input/30">
                <option value="">All categories</option>
                {cats.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <Button variant="outline" className="h-9" disabled={excelBusy || shown.length === 0} title="An Excel file with today's prices of the items listed"
                onClick={async () => {
                  setExcelBusy(true);
                  try { await downloadTemplate({ code: d.branch.code, name: branch?.name ?? d.branch.code, priceType: d.branch.priceType }, platforms, shown); }
                  catch (e) { toast.error((e as Error).message); } finally { setExcelBusy(false); }
                }}><DownloadIcon className="size-4" /> Download template</Button>
              <Button variant="outline" className="h-9" disabled={excelBusy} onClick={() => fileRef.current?.click()}><UploadIcon className="size-4" /> Upload Excel</Button>
              <input ref={fileRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0]; e.target.value = "";
                  if (!f) return;
                  setExcelBusy(true);
                  try { setUpload({ file: f.name, result: await readPrices(f, d.branch.code, platforms, d.items) }); }
                  catch (err) { toast.error((err as Error).message); } finally { setExcelBusy(false); }
                }} />
            </div>
          </div>
          {shown.length === 0 ? (
            <EmptyState icon={TagIcon} title={filter === "missing" ? "Every item has a price on every platform" : filter === "changed" ? "No changes yet" : "No items"} module="sales">
              {filter === "all" && !q && !cat ? "No FACTS items are enabled for selling at this branch." : "Change the filter or search."}
            </EmptyState>
          ) : (
            // Scrolls inside its own box: the page stays put and the column headings (and the item) stay in view.
            <TablePanel className={cn(changes.length > 0 || invalid > 0 ? "max-h-[calc(100dvh-21rem)]" : "max-h-[calc(100dvh-17rem)]", "min-h-64 overflow-auto [&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10 [&_tbody_td:nth-child(2)]:sticky [&_tbody_td:nth-child(2)]:left-0 [&_tbody_td:nth-child(2)]:z-[1] [&_tbody_td:nth-child(2)]:bg-card [&_thead_th:nth-child(2)]:left-0 [&_thead_th:nth-child(2)]:z-20")}>
              <Table bare>
                <TableHeader><TableRow>
                  <TableHead className="pl-5">Code</TableHead><TableHead>Item</TableHead>
                  <TableHead className="text-right">Outlet <span className="block text-[0.7rem] font-normal text-muted-foreground">{d.branch.priceType ?? "no price type"}</span></TableHead>
                  {platforms.map((p) => <TableHead key={p.id} className="text-right">{p.name}</TableHead>)}
                </TableRow></TableHeader>
                <TableBody>
                  {shown.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell className="pl-5 font-mono text-xs text-muted-foreground">{i.code}</TableCell>
                      <TableCell className="min-w-48"><span className="font-medium">{i.name}</span> <span className="text-xs text-muted-foreground">{i.category}</span></TableCell>
                      {["", ...platforms.map((p) => p.id)].map((pid) => {
                        const now = current(i, pid), s = edits[key(i.id, pid)];
                        const v = s === undefined ? null : parse(s);
                        const changed = v !== null && v > 0 && v !== now, bad = s !== undefined && s.trim() !== "" && (v === null || v === 0);
                        return (
                          <TableCell key={pid} className="py-1.5 text-right">
                            <Input value={s ?? (now === null ? "" : now.toFixed(2))} placeholder="—" inputMode="decimal" aria-label={`${i.name} ${pid ? platforms.find((p) => p.id === pid)?.name : "outlet"} price`}
                              onChange={(e) => setEdits({ ...edits, [key(i.id, pid)]: e.target.value.replace(/[^\d.]/g, "") })}
                              className={cn("ml-auto h-8 w-24 text-right tabular-nums", now === null && s === undefined && "bg-warning/10 placeholder:text-warning",
                                changed && "border-primary bg-primary/8 font-semibold text-primary", bad && "border-danger text-danger")} />
                            {changed && now !== null && <div className="mt-0.5 text-[0.7rem] text-muted-foreground line-through tabular-nums">{money(now)}</div>}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TablePanel>
          )}
          <p className="mt-2 text-xs text-muted-foreground">An empty cell (—) has no price: the item can&apos;t be sold there. Type a price to change it; the prices are the selling prices with VAT.</p>
        </>
      )}

      {(changes.length > 0 || invalid > 0) && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 px-4 py-3 shadow-lg backdrop-blur" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
            <span className="text-sm"><b>{changes.length} change{changes.length === 1 ? "" : "s"}</b>{invalid > 0 && <span className="text-danger"> · {invalid} not a price (use e.g. 7.50)</span>}</span>
            <div className="flex gap-2">
              <Button variant="outline" disabled={updating} onClick={() => setEdits({})}><RotateCcwIcon className="size-4" /> Undo all</Button>
              <Button disabled={updating || changes.length === 0 || invalid > 0 || blockers.length > 0} onClick={() => setPosting(true)}>{updating ? "Updating the till…" : "Post to FACTS…"}</Button>
            </div>
          </div>
        </div>
      )}
      <UploadDialog upload={upload} onClose={() => setUpload(null)} onApply={(r) => {
        setEdits((prev) => ({ ...prev, ...Object.fromEntries(r.changes.map((c) => [key(c.itemId, c.platformId), c.price.toFixed(2)])) }));
        setFilter("changed"); setQ(""); setCat(""); setUpload(null);
        toast.success(`${r.changes.length} price${r.changes.length === 1 ? "" : "s"} put on the screen. Check them, then Post to FACTS.`);
      }} />
      <PostDialog open={posting} docs={docs} factsUser={d?.branch.factsUser ?? ""} onClose={() => setPosting(false)}
        onPost={async (remark) => {
          const r = await api<{ posted: number; failed: number }>("/prices/post", "POST",
            { remark, changes: changes.map((c) => ({ itemId: c.item.id, platformId: c.platformId || null, price: c.price })) });
          setPosting(false);
          if (r.failed === 0) toast.success(`Posted in FACTS (${r.posted} document${r.posted === 1 ? "" : "s"}). The till gets the new prices in a few seconds.`);
          else toast.error(`${r.failed} document${r.failed === 1 ? "" : "s"} refused by FACTS: see History. ${r.posted ? `${r.posted} posted.` : ""}`);
          if (r.posted > 0) { updatingRef.current = true; setUpdating(true); }
          history.reload();
        }} />
    </div>
  );
}

/** What an uploaded file holds: the changes found, what was the same, and every row or cell left out (with why). */
function UploadDialog({ upload, onClose, onApply }: { upload: { file: string; result: XResult } | null; onClose: () => void; onApply: (r: XResult) => void }) {
  const r = upload?.result;
  return (
    <Dialog open={!!upload} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Read “{upload?.file}”</DialogTitle>
          <DialogDescription>Nothing is posted yet: the changes go on the screen, highlighted, and you post them as usual.</DialogDescription>
        </DialogHeader>
        {r && (
          <div className="grid gap-2 text-sm">
            <div className={cn("rounded-lg border px-3 py-2", r.changes.length ? "border-primary/40 bg-primary/5" : "")}>
              <b>{r.changes.length} price change{r.changes.length === 1 ? "" : "s"}</b>
              {r.perColumn.length > 0 && <span className="text-muted-foreground"> ({r.perColumn.map((c) => `${c.n} ${c.label}`).join(" · ")})</span>}
            </div>
            <div className="px-3 text-muted-foreground">{r.unchanged} price{r.unchanged === 1 ? "" : "s"} the same as now, left as they are</div>
            {r.skipped.length > 0 && (
              <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
                <div className="mb-1 font-medium text-warning">{r.skipped.length} left out</div>
                <div className="grid max-h-48 gap-0.5 overflow-auto text-xs">
                  {r.skipped.map((x, i) => (
                    <div key={i}>{x.row ? <span className="text-muted-foreground">Row {x.row} </span> : null}{x.code && <span className="font-mono">{x.code} </span>}{x.why}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!r?.changes.length} onClick={() => r && onApply(r)}>Put on the screen</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PostDialog({ open, docs, factsUser, onClose, onPost }: {
  open: boolean; docs: { label: string; n: number }[]; factsUser: string; onClose: () => void; onPost: (remark: string | null) => Promise<void>;
}) {
  const [remark, setRemark] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Post to FACTS</DialogTitle>
          <DialogDescription>Saved and posted in FACTS as <b>{factsUser}</b>, valid from today. If FACTS refuses a document, nothing of it stays in FACTS.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          {docs.map((x) => (
            <div key={x.label} className="flex justify-between gap-3 rounded-lg border px-3 py-2 text-sm"><span>{x.label}</span><span className="text-muted-foreground">{x.n} item{x.n === 1 ? "" : "s"}</span></div>
          ))}
        </div>
        <Input id="price-remark" value={remark} maxLength={100} onChange={(e) => setRemark(e.target.value)} placeholder="Remark (optional), e.g. Donut prices November" className="h-11" />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={async () => {
            setBusy(true);
            try { await onPost(remark.trim() || null); setRemark(""); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
          }}>{busy ? "Posting…" : "Post to FACTS"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The branch's price changes, newest first: each FACTS document, posted or refused (with why, and Post again). */
function History({ data, error, onRetried }: { data: PriceChange[] | null | undefined; error: string | null | undefined; onRetried: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (error) return <ErrorNote message={error} />;
  if (!data) return <LoadingRows rows={4} />;
  if (!data.length) return <EmptyState icon={TagIcon} title="No price changes yet" module="sales">Prices posted from this page show here for everyone with this branch selected.</EmptyState>;
  return (
    <section>
      <div className="grid gap-2">
        {data.map((c) => (
          <div key={c.id} className="rounded-xl border bg-card p-3">
            <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 text-left" onClick={() => setOpen(open === c.id ? null : c.id)}>
              <span className="text-sm"><b>{new Date(c.createdAt).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</b> · {c.by}{c.remark ? ` · ${c.remark}` : ""}</span>
              <span className="text-xs text-muted-foreground">as {c.factsUser} · {((n) => `${n} price${n === 1 ? "" : "s"}`)(c.docs.reduce((n, d) => n + d.lines.length, 0))}</span>
            </button>
            <div className="mt-2 grid gap-1.5">
              {c.docs.map((d) => (
                <div key={d.id} className="rounded-lg border px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>{d.kind === "outlet" ? `Outlet · ${d.priceType}` : `${d.platform} · ${d.location}`}{d.factsDoc && <span className="font-mono text-xs text-muted-foreground"> · {d.factsDocType} {d.factsDoc}</span>} · {d.lines.length} item{d.lines.length === 1 ? "" : "s"}</span>
                    {d.status === "posted" ? <Pill className={TONE.done} dot>Posted</Pill> : d.status === "failed" ? <Pill className={TONE.danger} dot>Refused</Pill> : <Pill className={TONE.draft}>Posting</Pill>}
                  </div>
                  {d.status !== "posted" && (
                    <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-danger">
                      <span>{d.error ?? "Not posted yet: it was cut off. Post it again."}</span>
                      <Button size="sm" variant="outline" className="h-7" disabled={busy === d.id} onClick={async () => {
                        setBusy(d.id);
                        try {
                          const r = await api<{ posted: number }>(`/prices/docs/${d.id}/retry`, "POST");
                          if (r.posted) toast.success("Posted in FACTS."); else toast.error("FACTS refused it again.");
                          onRetried();
                        } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
                      }}>Post again</Button>
                    </div>
                  )}
                  {open === c.id && (
                    <div className="mt-2 grid gap-0.5 text-xs">
                      {d.lines.map((l) => (
                        <div key={l.itemId} className="flex justify-between gap-3"><span><span className="font-mono text-muted-foreground">{l.code}</span> {l.name}</span>
                          <span className="tabular-nums">{l.old === null ? "—" : money(l.old)} → <b>{money(l.new)}</b></span></div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
