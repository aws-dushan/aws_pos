"use client";

import { useState } from "react";
import { CloudUploadIcon, EyeIcon, RotateCcwIcon, SendIcon, SkipForwardIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtIn } from "@/lib/num";
import { useSession } from "@/components/session";
import { EmptyState, ErrorNote, Field, FieldGroup, LoadingRows, ObjectStatus, PageHeader, Segmented, Switch, TablePanel, TONE } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Branch = { id: string; code: string; name: string; location: string | null; postFrom: string | null; paymentModes: number; cardTypes: number; queue: Record<string, number> };
type Settings = { connector: string; posting: boolean; modesReadAt: string | null; modesReadOk: boolean | null; modesReadError: string | null; refunds: "none" | "sr50" | "psr51"; refundProc: string | null; invoiceProc: string; wastage: "finance" | "draft"; repacking: "off" | "draft" | "posted"; branches: Branch[] };
type Preview = { date: string; bills: number; total: number; vat: number; withProblems: number; items: { id: string; invoiceNo: string; total: number; vat: number; problems: string[]; xml: string }[] };
type LogRow = { id: string; kind: "invoice" | "refund" | "wastage" | "repacking" | "return" | "marketing" | "request"; docNo: string; businessDate: string; amount: number; status: string; attempts: number; lastError: string | null; factsDoc: string | null; createdAt: string; postedAt: string | null; batchNote: string | null };

const STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: "Waiting to send", tone: TONE.draft }, posted: { label: "Posted", tone: TONE.done }, failed: { label: "Failed", tone: TONE.danger },
  waiting: { label: "Waiting for FACTS", tone: TONE.warn }, skipped: { label: "Left out", tone: TONE.muted },
};
const iso = (d: Date) => d.toISOString().slice(0, 10);
const money = (n: number) => fmtIn(n, 2);

/**
 * FACTS posting (Administration): each paid bill goes to FACTS as a POS51 document, the way the outlet POS does today. Off until
 * an administrator switches it on and a branch has a start date (the day the old POS stops posting there). The dry run shows a
 * day's bills as they would be sent; the log shows what was sent, what failed and why.
 */
export default function FactsPostingPage() {
  const { me, company, branch } = useSession();
  const admin = me.user.isAdmin;
  const cur = company?.currency ?? "AED";
  const s = useApi<Settings>("/erp/posting");
  const [day, setDay] = useState(iso(new Date()));
  const preview = useApi<Preview>(`/erp/posting/preview?date=${day}`);
  const [status, setStatus] = useState<"all" | "failed" | "pending" | "posted">("all");
  const log = useApi<LogRow[]>(`/erp/posting/log${status === "all" ? "" : `?status=${status}`}`);
  const [xml, setXml] = useState<{ title: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [proc, setProc] = useState<string | null>(null);
  const d = s.data;
  const procValue = proc ?? d?.refundProc ?? "";
  // This branch's queue: what waits and what failed (push now / re-push failed).
  const queue = d?.branches.find((b) => b.id === branch?.id)?.queue ?? {};
  const waiting = queue.pending ?? 0, failed = queue.failed ?? 0;
  const push = (withFailed: boolean) => run(withFailed ? "repush" : "push", () => api<{ failed: number; sent: number }>("/erp/posting/push", "POST", { failed: withFailed }),
    withFailed ? "Failed bills re-pushed: they go to FACTS now." : "Sent to FACTS now.");

  async function run(name: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(name);
    try { await fn(); toast.success(ok); s.reload(); log.reload(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  const saveCompany = (patch: Partial<{ posting: boolean; refunds: string; refundProc: string | null; invoiceProc: string; wastage: string; repacking: string }>) =>
    run("company", () => api("/erp/posting/company", "PUT", { posting: d!.posting, refunds: d!.refunds, refundProc: procValue || null, invoiceProc: d!.invoiceProc, wastage: d!.wastage, repacking: d!.repacking, ...patch }), "Saved.");

  return (
    <div className="max-w-5xl space-y-5">
      <PageHeader title="FACTS posting" icon={CloudUploadIcon} module="admin"
        description="Each paid bill goes to FACTS as a POS51 document, the same way the outlet POS posts today. Wastage isn't posted: finance posts it in FACTS." />
      <ErrorNote message={s.error} />
      {!d ? <LoadingRows rows={4} /> : d.connector !== "facts" ? (
        <EmptyState icon={CloudUploadIcon} title="This company isn't linked to FACTS" module="admin">Its ERP connection is set under Companies &amp; branches.</EmptyState>
      ) : <>
        <FieldGroup title="Posting" className="space-y-4 p-5"
          actions={<Switch size="lg" on={d.posting} disabled={!admin || !!busy} onChange={(v) => void saveCompany({ posting: v })} label="Post to FACTS" />}>
          <p className="text-sm text-muted-foreground">
            {d.posting ? "On: bills of branches with a start date are sent to FACTS within a minute of being paid." : "Off: nothing is sent. Bills of branches with a start date wait in the queue until posting is on."}
            {!admin && " Only administrators change this."}
          </p>
          <div className="space-y-2">
            <span className="block text-[0.8rem] font-medium text-foreground/80">Batches</span>
            <Segmented id="invoice-proc" value={d.invoiceProc} onChange={(v) => admin && void saveCompany({ invoiceProc: v })} className="w-full max-w-xl"
              options={[{ value: "usp_FQAPI_PWA_POS_SaveInvoice", label: "Finance assigns (batch update)" }, { value: "usp_ONEPOS_SaveInvoice", label: "FIFO batch with each bill" }]} />
            <p className="text-xs text-muted-foreground">
              {d.invoiceProc === "usp_ONEPOS_SaveInvoice"
                ? "Each bill line gets the oldest batch at the location with enough stock, as the bill is saved in FACTS (procedure usp_ONEPOS_SaveInvoice). A line no batch covers is named in the log, for the batch update."
                : "Bills go in without batches, as from the outlet POS; finance assigns them with the batch update (BUDTE)."}
            </p>
          </div>
          <div className="space-y-2">
            <span className="block text-[0.8rem] font-medium text-foreground/80">Wastage</span>
            <Segmented id="wastage-mode" value={d.wastage} onChange={(v) => admin && void saveCompany({ wastage: v })} className="w-full max-w-xl"
              options={[{ value: "finance", label: "Finance enters in FACTS" }, { value: "draft", label: "Draft transfer from One POS" }]} />
            <p className="text-xs text-muted-foreground">
              {d.wastage === "draft"
                ? "Each branch's day of wastage goes to FACTS at the day's close (night) as one draft STV50 to its wastage location (procedure usp_ONEPOS_SaveWastageTransfer), not posted: finance gives the batches and posts it there. Needs the branch's wastage location."
                : "Finance enters the wastage in FACTS as today; One POS matches their transfers to the branch's wastage by itself."}
            </p>
          </div>
          <div className="space-y-2">
            <span className="block text-[0.8rem] font-medium text-foreground/80">BOM items (repacking)</span>
            <Segmented id="repacking-mode" value={d.repacking} onChange={(v) => admin && void saveCompany({ repacking: v })} className="w-full max-w-xl"
              options={[{ value: "off", label: "Off" }, { value: "draft", label: "Draft per day" }, { value: "posted", label: "Posted per bill" }]} />
            <p className="text-xs text-muted-foreground">
              {d.repacking === "posted"
                ? "Each paid bill's made-to-order items (those with a BOM under BOMs) go to FACTS as one RPO50, just before the bill: the items sold in, their raw materials out, each raw material from its oldest batch with stock (FIFO) at its batch cost, posted by FACTS' own approval (procedure usp_ONEPOS_PostRepacking). If a raw material hasn't enough stock in its batches, that RPO50 stays a draft for finance."
                : d.repacking === "draft"
                ? "Each branch's day of made-to-order items (those with a BOM under BOMs) goes to FACTS at the day's close as one draft RPO50: the items sold in, their raw materials out (procedure usp_ONEPOS_SaveRepacking), not posted: finance gives the batches and posts it there."
                : "Nothing is sent for BOM items; finance makes repacking vouchers in FACTS by hand."}
            </p>
          </div>
          <div className="space-y-2">
            <span className="block text-[0.8rem] font-medium text-foreground/80">Refunds (credit notes)</span>
            <Segmented id="refunds" value={d.refunds} onChange={(v) => admin && void saveCompany({ refunds: v })} className="w-full max-w-2xl flex-wrap"
              options={[{ value: "none", label: "Not posted (finance enters them)" }, { value: "psr51", label: "Returned bills as PSR51" }, { value: "sr50", label: "Post as SR50" }]} />
            {d.refunds === "psr51" && (
              <p className="text-sm text-muted-foreground">A bill returned at the till (Return on Orders: the whole bill) goes to FACTS as a posted PSR51, a copy of its POS51: the same lines and batches back on stock, each payment refunded the way it was paid (procedure usp_ONEPOS_PostReturn). It waits until the bill&apos;s POS51 is posted. Other refunds are entered by finance.</p>
            )}
            {d.refunds === "sr50" && (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="FACTS procedure that saves SR50" hint="From the FACTS developer. Until it's set, credit notes wait in the queue.">
                  <Input value={procValue} disabled={!admin} onChange={(e) => setProc(e.target.value)} placeholder="usp_FQAPI_PWA_POS_SaveCreditNote" className="w-80" />
                </Field>
                {admin && <Button variant="outline" className="h-10" disabled={!!busy} onClick={() => void saveCompany({})}>Save</Button>}
              </div>
            )}
          </div>
        </FieldGroup>

        <FieldGroup title="Branches" className="p-0" description="A branch posts its bills from its start date on: the day the old POS stops posting there (both must never post the same day).">
          <div className="divide-y">
            {d.branches.map((b) => (
              <div key={b.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                <div className="min-w-48 flex-1">
                  <div className="font-medium">{b.code} · {b.name}</div>
                  <div className="text-xs text-muted-foreground">{b.location ? `FACTS location ${b.location} · ${b.cardTypes} card type${b.cardTypes === 1 ? "" : "s"}, ${b.paymentModes} payment methods` : "No FACTS location (set under Companies & branches)"}</div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(b.queue).map(([k, n]) => <ObjectStatus key={k} className={STATUS[k]?.tone ?? TONE.muted}>{STATUS[k]?.label ?? k}: {n}</ObjectStatus>)}
                </div>
                {b.location && (
                  <label className="flex items-center gap-2 text-sm">Posts from
                    <Input type="date" className="h-10 w-40" value={b.postFrom ?? ""} disabled={!admin || !!busy}
                      onChange={(e) => void run("branch", () => api(`/erp/posting/branch/${b.id}`, "PUT", { postFrom: e.target.value || null }), e.target.value ? `${b.code} posts from ${e.target.value}.` : `${b.code} doesn't post.`)} />
                  </label>
                )}
              </div>
            ))}
          </div>
          <p className={cn("border-t px-5 py-3 text-xs", d.modesReadOk === false ? "text-danger" : "text-muted-foreground")}>
            Card types and payment methods are read from FACTS by themselves: every hour, and as soon as a branch&apos;s FACTS location is set.
            {d.modesReadAt ? ` Last read ${new Date(d.modesReadAt).toLocaleString("en-GB")}${d.modesReadOk === false ? `: failed (${d.modesReadError ?? "error"}).` : "."}` : " Not read yet."}
          </p>
        </FieldGroup>

        <FieldGroup title={`Dry run · ${branch?.name ?? ""}`} className="space-y-3 p-5" description="A day's paid bills as they would go to FACTS. Nothing is sent. Compare with what the old POS posted for the same day.">
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-xs font-medium text-muted-foreground">Business day<Input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="h-10 w-40" /></label>
            {preview.data && <span className="text-sm">{preview.data.bills} bills · {cur} {money(preview.data.total)} · VAT {money(preview.data.vat)}
              {preview.data.withProblems > 0 && <span className="text-danger"> · {preview.data.withProblems} can&apos;t be posted</span>}</span>}
          </div>
          <ErrorNote message={preview.error} />
          {preview.data?.items.length ? (
            <TablePanel>
              <Table>
                <TableHeader><TableRow><TableHead className="pl-5">Invoice</TableHead><TableHead className="text-right">Total</TableHead><TableHead>Problems</TableHead><TableHead className="pr-5" /></TableRow></TableHeader>
                <TableBody>
                  {preview.data.items.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell className="pl-5 font-medium">{b.invoiceNo}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(b.total)}</TableCell>
                      <TableCell className={cn("text-sm", b.problems.length ? "text-danger" : "text-success")}>{b.problems.length ? b.problems.join(" ") : "Ready"}</TableCell>
                      <TableCell className="pr-5 text-right"><Button variant="ghost" size="sm" onClick={() => setXml({ title: b.invoiceNo, text: b.xml })}><EyeIcon /> XML</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TablePanel>
          ) : preview.data && <p className="text-sm text-muted-foreground">No paid bills on this day.</p>}
        </FieldGroup>

        <FieldGroup title={`Posting log · ${branch?.name ?? ""}`} className="space-y-3 p-5"
          actions={<Segmented id="log-status" size="sm" value={status} onChange={setStatus} options={[{ value: "all", label: "All" }, { value: "failed", label: "Failed" }, { value: "pending", label: "Waiting" }, { value: "posted", label: "Posted" }]} />}>
          <div className="flex flex-wrap items-center gap-2">
            <Button className="h-10" disabled={!d.posting || !waiting || !!busy} onClick={() => void push(false)}><SendIcon /> Push now{waiting ? ` (${waiting})` : ""}</Button>
            <Button variant="outline" className="h-10" disabled={!d.posting || !failed || !!busy} onClick={() => void push(true)}><RotateCcwIcon /> Re-push failed{failed ? ` (${failed})` : ""}</Button>
            <span className="text-xs text-muted-foreground">{!d.posting ? "Posting is off: nothing can be pushed." : "Bills go by themselves within a minute; push sends them now. Re-push rebuilds failed bills (e.g. after an item code is fixed) and sends them again."}</span>
          </div>
          {log.data?.length ? (
            <TablePanel>
              <Table>
                <TableHeader><TableRow>
                  <TableHead className="pl-5">Document</TableHead><TableHead>Day</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead><TableHead className="pr-5" />
                </TableRow></TableHeader>
                <TableBody>
                  {log.data.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="pl-5"><span className="font-medium">{r.kind === "refund" ? d.refunds === "psr51" ? "PSR51" : "SR50" : r.kind === "wastage" ? "Wastage" : r.kind === "repacking" ? "Repacking" : r.kind === "return" ? "Return" : r.kind === "marketing" ? "Marketing" : r.kind === "request" ? "Request" : "POS51"} {r.docNo}{r.kind === "marketing" && r.factsDoc ? ` → posted MCV50 ${r.factsDoc}` : ""}{r.kind === "return" && r.factsDoc ? ` → posted STV50 ${r.factsDoc}` : ""}{r.kind === "request" && r.factsDoc ? ` → posted STR50 ${r.factsDoc}` : ""}{r.kind === "wastage" && r.factsDoc ? ` → ${r.batchNote ? "posted" : "draft"} STV50 ${r.factsDoc}` : r.kind === "repacking" && r.factsDoc ? ` → ${r.batchNote && !r.batchNote.includes("not posted") ? "posted" : "draft"} RPO50 ${r.factsDoc}` : ""}{r.kind === "refund" && d.refunds === "psr51" && r.factsDoc ? " → posted" : ""}</span>
                        {r.lastError && r.status !== "posted" && <div className="max-w-md truncate text-xs text-danger" title={r.lastError}>{r.lastError}</div>}
                        {r.batchNote && <div className={cn("max-w-md truncate text-xs", r.batchNote.includes("No batch") || r.batchNote.includes("not given") || r.batchNote.includes("not posted") ? "text-warning" : "text-muted-foreground")} title={r.batchNote}>{r.batchNote}</div>}</TableCell>
                      <TableCell className="text-muted-foreground">{r.businessDate}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(r.amount)}</TableCell>
                      <TableCell><ObjectStatus className={STATUS[r.status]?.tone ?? TONE.muted}>{STATUS[r.status]?.label ?? r.status}{r.attempts > 1 && r.status !== "posted" ? ` · ${r.attempts} tries` : ""}</ObjectStatus></TableCell>
                      <TableCell className="pr-5 text-right whitespace-nowrap">
                        <Button variant="ghost" size="sm" onClick={() => void api<{ xml: string }>(`/erp/posting/${r.id}/xml`).then((x) => setXml({ title: `${r.kind === "refund" ? d.refunds === "psr51" ? "PSR51" : "SR50" : "POS51"} ${r.docNo}`, text: x.xml }), (e: Error) => toast.error(e.message))}><EyeIcon /> XML</Button>
                        {r.status === "failed" && <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => void run("retry", () => api(`/erp/posting/${r.id}/retry`, "POST"), "Re-pushed.")}><RotateCcwIcon /> Re-push</Button>}
                        {(r.status === "failed" || r.status === "waiting" || (r.status === "pending" && r.attempts > 0)) && <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => { if (window.confirm("Leave this out of the posting? Finance then enters it in FACTS by hand.")) void run("skip", () => api(`/erp/posting/${r.id}/skip`, "POST"), "Left out."); }}><SkipForwardIcon /> Leave out</Button>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TablePanel>
          ) : log.data && <p className="text-sm text-muted-foreground">Nothing in the queue{status === "all" ? " yet. Bills appear here once the branch has a start date." : "."}</p>}
        </FieldGroup>
      </>}

      <Dialog open={!!xml} onOpenChange={(o) => { if (!o) setXml(null); }}>
        <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-3xl">
          <DialogHeader><DialogTitle>{xml?.title}</DialogTitle></DialogHeader>
          <pre className="max-h-[70vh] overflow-auto rounded-xl bg-muted p-3 text-xs whitespace-pre-wrap">{xml ? pretty(xml.text) : ""}</pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The XML indented for reading. */
function pretty(x: string) {
  let depth = 0;
  return x.replace(/></g, ">\n<").split("\n").map((line) => {
    if (line.startsWith("</")) depth = Math.max(0, depth - 1);
    const out = "  ".repeat(depth) + line;
    if (/^<[^/!?][^>]*[^/]>$/.test(line) && !line.includes("</")) depth++;
    return out;
  }).join("\n");
}
