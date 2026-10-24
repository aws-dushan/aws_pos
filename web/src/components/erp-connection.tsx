"use client";

import { useState } from "react";
import { CheckCircle2Icon, DatabaseIcon, EyeIcon, EyeOffIcon, Loader2Icon, PlugZapIcon, ShieldAlertIcon, Trash2Icon, XCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { confirmDialog } from "@/components/confirm";
import { Field } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

type ErpInfo = {
  connector: "none" | "awsone" | "facts"; configured: boolean; summary: string | null; updatedAt: string | null; updatedBy: string | null;
  testedAt: string | null; testOk: boolean | null; testMessage: string | null;
};
type TestResult = { ok: boolean; message: string; server: string | null; database: string | null; login: string | null; version: string | null; tables: number | null; canWrite: boolean | null };

/**
 * The company's FACTS database connection (administrators). The string is write-only: once saved, only its summary (server,
 * database, login) comes back; it is stored encrypted on the server. "Test" checks a pasted string before saving it.
 */
export function ErpConnectionDialog({ company, onClose }: { company: { id: string; name: string } | null; onClose: () => void }) {
  const info = useApi<ErpInfo>(company ? `/companies/${company.id}/erp` : null);
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<"test" | "save" | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);

  function close() { setValue(""); setResult(null); setShow(false); onClose(); }

  async function test() {
    setBusy("test");
    try { setResult(await api<TestResult>(`/companies/${company!.id}/erp/test`, "POST", { connectionString: value.trim() || null })); info.reload(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  async function save() {
    setBusy("save");
    try {
      const r = await api<{ summary: string; test: TestResult }>(`/companies/${company!.id}/erp`, "PUT", { connectionString: value.trim() });
      setResult(r.test); setValue(""); info.reload();
      if (r.test.ok) toast.success("Connection saved"); else toast.warning("Saved, but it doesn't connect yet. See the test result.");
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  async function remove() {
    if (!(await confirmDialog({ title: "Remove the FACTS connection?", message: "Item and stock sync stop until a connection is set again.", confirmLabel: "Remove", tone: "danger" }))) return;
    try { await api(`/companies/${company!.id}/erp`, "DELETE"); setResult(null); info.reload(); toast.success("Connection removed"); } catch (e) { toast.error((e as Error).message); }
  }

  const d = info.data;
  return (
    <Dialog open={!!company} onOpenChange={(o) => !o && close()}>
      <DialogContent className="min-w-0 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><DatabaseIcon className="size-5 text-primary" /> FACTS connection · {company?.name}</DialogTitle>
          <DialogDescription>One POS reads items, prices and stock from FACTS, and posts returns as STV documents. Use a read-only database login.</DialogDescription>
        </DialogHeader>

        {d?.configured ? (
          <div className="rounded-xl border px-4 py-3">
            <div className="flex items-center gap-2">
              {d.testOk ? <CheckCircle2Icon className="size-4 text-success" /> : d.testOk === false ? <XCircleIcon className="size-4 text-danger" /> : <PlugZapIcon className="size-4 text-muted-foreground" />}
              <span className="min-w-0 font-mono text-sm break-all">{d.summary}</span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Set by {d.updatedBy} {d.updatedAt && timeAgo(d.updatedAt)}{d.testedAt ? ` · last tested ${timeAgo(d.testedAt)}` : ""}. The saved value is encrypted and isn&apos;t shown again.
            </div>
          </div>
        ) : d && <p className="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">No connection saved yet.</p>}

        <Field label={d?.configured ? "Replace with a new connection string" : "Connection string"} hint={<span className="break-all">e.g. Server=10.0.0.5;Database=FACTS;User Id=onepos_read;Password=…;TrustServerCertificate=True</span>}>
          <div className="relative">
            <Textarea rows={3} value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} autoComplete="off"
              className={cn("h-20 resize-none [field-sizing:fixed] overflow-y-auto pr-10 font-mono text-xs break-all", !show && value && "[-webkit-text-security:disc]")} placeholder="Paste it here" />
            <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide" : "Show"} className="absolute top-2 right-2 rounded-md p-1 text-muted-foreground hover:bg-muted">
              {show ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
            </button>
          </div>
        </Field>

        {result && (
          <div className={cn("rounded-xl px-4 py-3 text-sm", result.ok ? (result.canWrite ? "bg-warning/10" : "bg-success/10") : "bg-danger/10")}>
            <div className={cn("flex items-start gap-2 font-medium", result.ok ? (result.canWrite ? "text-warning" : "text-success") : "text-danger")}>
              {result.ok ? (result.canWrite ? <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" /> : <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" />) : <XCircleIcon className="mt-0.5 size-4 shrink-0" />}
              <span className="min-w-0 break-words">{result.message}</span>
            </div>
            {result.ok && (
              <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] [&_dd]:break-all gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                <dt>Database</dt><dd className="font-mono">{result.database}</dd>
                <dt>Login</dt><dd className="font-mono">{result.login}</dd>
                <dt>SQL Server</dt><dd className="font-mono">{result.version}</dd>
                <dt>Tables</dt><dd>{result.tables}</dd>
              </dl>
            )}
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          {d?.configured ? <Button variant="ghost" className="text-danger" onClick={() => void remove()}><Trash2Icon /> Remove</Button> : <span />}
          <div className="flex gap-2">
            <Button variant="outline" disabled={!!busy || (!value.trim() && !d?.configured)} onClick={() => void test()}>
              {busy === "test" ? <Loader2Icon className="animate-spin" /> : <PlugZapIcon />} Test{value.trim() ? "" : " saved"}
            </Button>
            <Button disabled={!!busy || !value.trim()} onClick={() => void save()}>{busy === "save" ? <Loader2Icon className="animate-spin" /> : null} Save</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
