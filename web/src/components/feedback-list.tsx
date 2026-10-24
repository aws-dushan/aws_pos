"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MessageSquareWarningIcon } from "lucide-react";
import { useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorNote, LoadingRows, ObjectStatus, PageHeader, Pill, SearchField, Segmented, TablePanel } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { KIND_LABEL, openReportProblem, SEVERITY_LABEL, SEVERITY_TONE, STATUS_LABEL, STATUS_TONE } from "@/components/feedback";

export type FeedbackRow = {
  id: string; number: string; userId: string; userName: string | null; companyId: string | null; companyCode: string | null; companyName: string | null;
  branchId: string | null; branchCode: string | null; branchName: string | null; registerName: string | null;
  kind: string; severity: string; title: string; description: string; steps: string | null; pagePath: string | null; pageTitle: string | null;
  browser: string | null; screen: string | null; appVersion: string | null; clientErrors: string[];
  status: string; assigneeId: string | null; assigneeName: string | null; resolution: string | null; createdAt: string; updatedAt: string; closedAt: string | null;
  comments: number; files: number; hasScreenshot: boolean;
};

/** A date and time as the screens show it: "15 Oct 2026, 14:05". */
export const dateTime = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

type StatusFilter = "open" | "all" | "fixed" | "wont_fix";

/** The reports list: every report for an administrator (Administration › Problem reports), else the user's own (My problem reports). */
export function FeedbackList({ mine }: { mine?: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState<StatusFilter>(mine ? "all" : "open");
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => { const t = window.setTimeout(() => setTerm(q.trim()), 250); return () => window.clearTimeout(t); }, [q]);
  const params = new URLSearchParams();
  if (status !== "all") params.set("status", status);
  if (term) params.set("q", term);
  if (mine) params.set("mine", "true");
  const list = useApi<FeedbackRow[]>(`/feedback?${params}`);

  return (
    <div>
      <PageHeader title={mine ? "My problem reports" : "Problem reports"} icon={MessageSquareWarningIcon} module="admin" count={list.data?.length}
        description={mine ? "Problems, questions and ideas you reported, with their status and the answers." : "Reports from every screen: work them New → In progress → Fixed / Won't fix."}
        actions={<Button variant="outline" onClick={() => openReportProblem()}><MessageSquareWarningIcon /> Report a problem</Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchField value={q} onChange={(e) => setQ(e.target.value)} placeholder={mine ? "Number, title or text" : "Number, title, text, company, branch or reporter"} className="w-96 max-w-full" />
        <Segmented id="feedback-status" value={status} onChange={setStatus}
          options={[{ value: "open", label: "Open" }, { value: "fixed", label: "Fixed" }, { value: "wont_fix", label: "Won't fix" }, { value: "all", label: "All" }]} />
      </div>
      <ErrorNote message={list.error} />
      {list.loading && !list.data ? <LoadingRows /> : list.data?.length ? (
        <TablePanel>
          <Table>
            <TableHeader><TableRow>
              <TableHead className="pl-5">No.</TableHead><TableHead>Title</TableHead><TableHead>Status</TableHead><TableHead>Priority</TableHead>
              {!mine && <TableHead>Reported by</TableHead>}
              <TableHead>Where</TableHead><TableHead>Assigned to</TableHead><TableHead className="pr-5">Reported</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {list.data.map((r) => (
                <TableRow key={r.id} className="h-14 cursor-pointer" onClick={() => router.push(`/admin/feedback/${r.id}`)}>
                  <TableCell className="pl-5 font-mono text-xs font-medium">{r.number}</TableCell>
                  <TableCell className="max-w-96">
                    <span className="block [overflow-wrap:anywhere] font-medium">{r.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{KIND_LABEL[r.kind]}{r.pageTitle ? ` · ${r.pageTitle}` : ""}</span>
                  </TableCell>
                  <TableCell><ObjectStatus className={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</ObjectStatus></TableCell>
                  <TableCell><Pill className={SEVERITY_TONE[r.severity]}>{SEVERITY_LABEL[r.severity]}</Pill></TableCell>
                  {!mine && <TableCell>{r.userName}</TableCell>}
                  <TableCell className="font-mono text-xs text-muted-foreground" title={[r.companyName, r.branchName, r.registerName].filter(Boolean).join(" · ")}>
                    {[r.companyCode, r.branchCode].filter(Boolean).join(" · ") || "—"}
                  </TableCell>
                  <TableCell className={cn(!r.assigneeName && "text-muted-foreground")}>{r.assigneeName ?? "—"}</TableCell>
                  <TableCell className="pr-5 whitespace-nowrap text-muted-foreground tabular-nums">{dateTime(r.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TablePanel>
      ) : (
        <EmptyState icon={MessageSquareWarningIcon} title={term || status !== "all" ? "No report matches" : mine ? "You haven't reported anything yet" : "No reports yet"} module="admin">
          Use Report a problem (top bar, Alt R) on any screen.
        </EmptyState>
      )}
    </div>
  );
}
