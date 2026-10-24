"use client";

import { Fragment, useState } from "react";
import { ChevronRightIcon, ScrollTextIcon } from "lucide-react";
import { useApi } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { EmptyState, ErrorNote, LoadingRows, PageHeader, Pill, Segmented, TablePanel, TONE } from "@/components/kit";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Row = { id: number; at: string; userName: string | null; companyCode: string | null; branchCode: string | null; entity: string; entityId: string | null; action: string; data: string };
type Data = { label: string; changes: { field: string; before: unknown; after: unknown }[]; note?: string | null };

const ACTION_TONE: Record<string, string> = { created: TONE.done, added: TONE.done, changed: TONE.open, removed: TONE.danger, signed_in: TONE.muted, password_changed: TONE.violet };
const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : typeof v === "boolean" ? (v ? "Yes" : "No") : Array.isArray(v) ? v.join(", ") : String(v));

/** Who did what, when (REQ USR-07). An administrator sees every company; others their own company. */
export default function AuditPage() {
  const { company, me } = useSession();
  const [scope, setScope] = useState<"company" | "all">("company");
  const [open, setOpen] = useState<number | null>(null);
  const path = me.user.isAdmin && scope === "all" ? "/audit?limit=300" : company ? `/audit?limit=300&companyId=${company.id}` : null;
  const log = useApi<Row[]>(path);
  useLiveEvent(["*"], () => log.reload());

  return (
    <div>
      <PageHeader title="Audit log" icon={ScrollTextIcon} module="bank" count={log.data?.length}
        description="Every sign-in and change, newest first. Tap a row for the details."
        actions={me.user.isAdmin && <Segmented id="audit-scope" value={scope} onChange={setScope} options={[{ value: "company", label: company?.code ?? "This company" }, { value: "all", label: "All companies" }]} />} />
      <ErrorNote message={log.error} />
      {log.loading && !log.data ? <LoadingRows /> : log.data?.length ? (
        <TablePanel>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8 pl-4" />
                <TableHead>When</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>What</TableHead>
                <TableHead>Where</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {log.data.map((r) => {
                const d = JSON.parse(r.data) as Data;
                const expanded = open === r.id;
                return (
                  <Fragment key={r.id}>
                    <TableRow className="h-12 cursor-pointer" onClick={() => setOpen(expanded ? null : r.id)}>
                      <TableCell className="pl-4"><ChevronRightIcon className={cn("size-3.5 text-muted-foreground transition-transform duration-200", expanded && "rotate-90")} /></TableCell>
                      <TableCell className="whitespace-nowrap" title={new Date(r.at).toLocaleString("en-GB")}>{timeAgo(r.at) ?? new Date(r.at).toLocaleDateString("en-GB")}</TableCell>
                      <TableCell>{r.userName ?? "System"}</TableCell>
                      <TableCell><span className="mr-2">{d.label}</span><Pill className={ACTION_TONE[r.action]}>{r.action.replace("_", " ")}</Pill></TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{[r.companyCode, r.branchCode].filter(Boolean).join(" · ") || "Platform"}</TableCell>
                    </TableRow>
                    {expanded && (
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TableCell />
                        <TableCell colSpan={4} className="animate-tab-in py-3">
                          {d.changes.length ? (
                            <div className="grid gap-1 text-sm">
                              {d.changes.map((c) => (
                                <div key={c.field} className="grid grid-cols-[10rem_1fr] gap-3">
                                  <span className="text-muted-foreground">{c.field}</span>
                                  <span><span className="text-muted-foreground line-through decoration-muted-foreground/40">{show(c.before)}</span> → <span className="font-medium">{show(c.after)}</span></span>
                                </div>
                              ))}
                            </div>
                          ) : <span className="text-sm text-muted-foreground">No field changes recorded.</span>}
                          {d.note && <p className="mt-2 text-sm">Note: {d.note}</p>}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </TablePanel>
      ) : <EmptyState icon={ScrollTextIcon} title="Nothing recorded yet" module="bank">Sign-ins and changes appear here as they happen.</EmptyState>}
    </div>
  );
}
