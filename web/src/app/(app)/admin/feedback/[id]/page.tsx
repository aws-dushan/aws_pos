"use client";

import Link from "next/link";
import { use, useState } from "react";
import { toast } from "sonner";
import { ChevronLeftIcon, ExternalLinkIcon, FileIcon, MessageSquareWarningIcon, SendIcon } from "lucide-react";
import { api, useApi } from "@/lib/api";
import { withBase } from "@/lib/base-path";
import { useSession } from "@/components/session";
import { ErrorNote, Field, FieldGroup, LoadingRows, ObjectStatus, PageHeader, Pill, selectClass, TONE } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { KIND_LABEL, SEVERITY_LABEL, SEVERITY_TONE, STATUS_LABEL, STATUS_TONE } from "@/components/feedback";
import { dateTime, type FeedbackRow } from "@/components/feedback-list";

type Detail = {
  feedback: FeedbackRow;
  comments: { id: number; userId: string; userName: string | null; isAdmin: boolean; body: string; createdAt: string }[];
  files: { id: string; kind: string; fileName: string; contentType: string; sizeBytes: number; uploadedBy: string | null; uploadedAt: string }[];
  assignees: { id: string; name: string }[];
  canManage: boolean;
};

const size = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

/** A label and its value in a details block. */
function Fact({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-3 text-sm sm:col-span-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-xs [overflow-wrap:anywhere]" : "[overflow-wrap:anywhere]"}>{children}</span>
    </div>
  );
}

/** One report: what was sent, the screenshot and files, the conversation, and (administrators) status, assignee and priority. */
export default function FeedbackDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const detail = useApi<Detail>(`/feedback/${id}`);
  const d = detail.data;
  if (!d) return <div className="pt-4">{detail.error ? <ErrorNote message={detail.error} /> : <LoadingRows />}</div>;
  const f = d.feedback;
  const shot = d.files.find((x) => x.kind === "screenshot");
  const others = d.files.filter((x) => x.kind !== "screenshot");
  // A plain <img>/<a> address: it needs the installation's prefix on the servers.
  const fileUrl = (fid: string, download = false) => withBase(`/api/feedback/files/${fid}${download ? "?download=true" : ""}`);
  return (
    <div className="pb-6">
      <Link href={d.canManage ? "/admin/feedback" : "/admin/feedback?mine=true"} className="mt-4 -mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeftIcon className="size-4" /> {d.canManage ? "Problem reports" : "My problem reports"}
      </Link>
      <PageHeader title={f.title} icon={MessageSquareWarningIcon} module="admin"
        description={<span className="flex flex-wrap items-center gap-2">
          <Pill className={TONE.muted}>{f.number}</Pill>
          <ObjectStatus className={STATUS_TONE[f.status]}>{STATUS_LABEL[f.status]}</ObjectStatus>
          <Pill className={SEVERITY_TONE[f.severity]}>{SEVERITY_LABEL[f.severity]}</Pill>
          <span>{KIND_LABEL[f.kind]} reported by {f.userName ?? "—"} · {dateTime(f.createdAt)}</span>
        </span>} />
      <div className="grid gap-5 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <FieldGroup title="What happened" className="grid gap-4 p-5">
            <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="feedback-description">{f.description}</p>
            {f.steps && <div><div className="mb-1 text-xs text-muted-foreground">Steps to repeat it</div><p className="text-sm whitespace-pre-wrap">{f.steps}</p></div>}
            {f.resolution && <div className="rounded-lg border border-success/30 bg-success/8 p-3 text-sm"><div className="mb-0.5 text-xs font-medium text-success">Resolution</div>{f.resolution}</div>}
          </FieldGroup>
          {shot && (
            <FieldGroup title="Screenshot" className="p-5">
              <a href={fileUrl(shot.id)} target="_blank" rel="noreferrer" className="block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={fileUrl(shot.id)} alt="Screenshot sent with the report" className="w-full rounded-lg border" data-testid="feedback-screenshot" />
              </a>
            </FieldGroup>
          )}
          <Conversation d={d} onChange={detail.reload} />
        </div>
        <div className="space-y-6">
          {d.canManage && <Manage key={`${f.status}|${f.assigneeId}|${f.severity}|${f.resolution}`} d={d} onSaved={detail.reload} />}
          <FieldGroup title="Sent with the report" className="grid gap-2 p-5">
            <Fact label="Screen">{f.pagePath ? <Link className="inline-flex items-center gap-1 underline" href={f.pagePath}>{f.pageTitle ?? f.pagePath} <ExternalLinkIcon className="size-3" /></Link> : "—"}</Fact>
            <Fact label="Company">{f.companyCode ? `${f.companyCode} ${f.companyName}` : "—"}</Fact>
            <Fact label="Branch">{f.branchCode ? `${f.branchCode} ${f.branchName}` : "—"}</Fact>
            <Fact label="Till">{f.registerName ?? "—"}</Fact>
            <Fact label="Assigned to">{f.assigneeName ?? "Nobody yet"}</Fact>
            <Fact label="Browser"><span className="text-xs">{f.browser ?? "—"}</span></Fact>
            <Fact label="Screen size">{f.screen ?? "—"}</Fact>
            <Fact label="App version" mono>{f.appVersion ?? "—"}</Fact>
          </FieldGroup>
          <FieldGroup title="Errors in the browser" description="Refused or failed requests and script errors in the two hours before" className="p-5">
            {f.clientErrors.length ? (
              <ul className="space-y-1.5 font-mono text-xs [overflow-wrap:anywhere]">
                {f.clientErrors.map((e, i) => <li key={i} className="rounded-lg border p-2">{e}</li>)}
              </ul>
            ) : <p className="text-sm text-muted-foreground">None in the two hours before.</p>}
          </FieldGroup>
          <FieldGroup title="Files" className="p-5">
            {others.length === 0 ? <p className="text-sm text-muted-foreground">No files.</p> : (
              <ul className="space-y-1.5 text-sm">
                {others.map((x) => (
                  <li key={x.id} className="flex items-center gap-2">
                    <FileIcon className="size-3.5 text-muted-foreground" />
                    <a href={fileUrl(x.id, true)} className="min-w-0 flex-1 truncate underline">{x.fileName}</a>
                    <span className="text-xs text-muted-foreground">{size(x.sizeBytes)}</span>
                  </li>
                ))}
              </ul>
            )}
          </FieldGroup>
        </div>
      </div>
    </div>
  );
}

function Conversation({ d, onChange }: { d: Detail; onChange: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send() {
    setBusy(true); setError(null);
    try { await api(`/feedback/${d.feedback.id}/comments`, "POST", { body: text }); setText(""); onChange(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <FieldGroup title={`Comments (${d.comments.length})`} className="space-y-3 p-5">
      {d.comments.length === 0 && <p className="text-sm text-muted-foreground">No comments yet.</p>}
      {d.comments.map((c) => (
        <div key={c.id} className={c.isAdmin ? "rounded-lg border bg-muted/40 p-3" : "rounded-lg border p-3"}>
          <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{c.userName}{c.isAdmin ? " · administrator" : ""}</span>
            <span>{dateTime(c.createdAt)}</span>
          </div>
          <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{c.body}</p>
        </div>
      ))}
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a comment…" aria-label="Comment" />
        <ErrorNote message={error} />
        <div className="flex justify-end"><Button type="submit" disabled={busy || !text.trim()}><SendIcon /> {busy ? "Sending…" : "Comment"}</Button></div>
      </form>
    </FieldGroup>
  );
}

function Manage({ d, onSaved }: { d: Detail; onSaved: () => void }) {
  const { me } = useSession();
  const f = d.feedback;
  const [status, setStatus] = useState(f.status);
  const [assignee, setAssignee] = useState(f.assigneeId ?? "");
  const [severity, setSeverity] = useState(f.severity);
  const [resolution, setResolution] = useState(f.resolution ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = status !== f.status || assignee !== (f.assigneeId ?? "") || severity !== f.severity || resolution !== (f.resolution ?? "");
  async function save() {
    setBusy(true); setError(null);
    try {
      await api(`/feedback/${f.id}`, "PUT", { status, assigneeId: assignee || null, severity, resolution: resolution.trim() || null });
      toast.success(status !== f.status ? `${f.number} is now ${STATUS_LABEL[status].toLowerCase()}` : `${f.number} saved`);
      onSaved();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <FieldGroup title="Work on it" className="grid gap-3 p-5 sm:grid-cols-2"
      actions={!f.assigneeId && <Button variant="outline" size="sm" onClick={() => setAssignee(me.user.id)}>Take it</Button>}>
      <Field label="Status">
        <select className={selectClass} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      <Field label="Priority">
        <select className={selectClass} value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Priority">
          {Object.entries(SEVERITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      <Field label="Assigned to" span>
        <select className={selectClass} value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assigned to">
          <option value="">Nobody</option>
          {d.assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </Field>
      <Field label="Resolution (the reporter sees it)" span hint="Needed when the status becomes Fixed or Won't fix.">
        <Textarea rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} aria-label="Resolution" />
      </Field>
      <div className="space-y-2 sm:col-span-2">
        <ErrorNote message={error} />
        <div className="flex justify-end"><Button disabled={busy || !dirty} onClick={() => void save()} data-testid="feedback-save">{busy ? "Saving…" : "Save"}</Button></div>
      </div>
    </FieldGroup>
  );
}
