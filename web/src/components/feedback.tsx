"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ImageIcon, MessageSquareWarningIcon, PaperclipIcon, XIcon } from "lucide-react";
import { api, apiUpload, API_ERROR_EVENT } from "@/lib/api";
import { stripBase } from "@/lib/base-path";
import { cn } from "@/lib/utils";
import { useSession } from "@/components/session";
import { ErrorNote, Field, selectClass, TONE } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/*
 * "Report a problem" (as AWS One; API Platform/Feedback.cs). Opened from anywhere: the top bar button, Alt R (lib/shortcuts.ts)
 * or the user menu. Before the dialog opens, the screen is captured in the browser (html-to-image: no outside service), so the
 * screenshot shows what the user saw. The report carries the screen, company, branch, till, browser, screen size and the errors
 * the browser met in the last two hours by itself; the server adds the user and the app version.
 */

export const STATUS_LABEL: Record<string, string> = { new: "New", in_progress: "In progress", fixed: "Fixed", wont_fix: "Won't fix" };
export const STATUS_TONE: Record<string, string> = { new: TONE.open, in_progress: TONE.draft, fixed: TONE.done, wont_fix: TONE.muted };
export const SEVERITY_LABEL: Record<string, string> = { blocker: "Blocker", major: "Major", normal: "Normal", minor: "Minor" };
export const SEVERITY_TONE: Record<string, string> = { blocker: TONE.danger, major: TONE.warn, normal: TONE.muted, minor: TONE.muted };
export const KIND_LABEL: Record<string, string> = { problem: "Problem", question: "Question", idea: "Idea" };

const EVENT = "onepos:report-problem";

/** Opens the dialog (from any code). */
export function openReportProblem() {
  window.dispatchEvent(new CustomEvent(EVENT));
}

// The errors this browser met (refused or failed requests, script errors), newest first; sent with a report (the last two hours).
const recent: { at: number; text: string }[] = [];
const time = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
function remember(text: string) {
  recent.unshift({ at: Date.now(), text: text.slice(0, 500) });
  recent.length = Math.min(recent.length, 20);
}
function recentErrors() {
  const since = Date.now() - 2 * 3600_000;
  return recent.filter((e) => e.at >= since).slice(0, 10).map((e) => `${time(e.at)} · ${e.text}`);
}

/** What the screen tells about itself: path, title, browser and size. */
function pageContext() {
  const heading = document.querySelector("main h1")?.textContent?.trim() || document.title;
  return {
    pagePath: stripBase(window.location.pathname) + window.location.search, pageTitle: heading.slice(0, 300),
    browser: navigator.userAgent, screen: `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x`,
    errors: recentErrors(),
  };
}

/** The visible part of the screen as a PNG (null when the browser can't draw it). */
async function capture(): Promise<Blob | null> {
  try {
    const { toBlob } = await import("html-to-image");
    return await toBlob(document.body, {
      pixelRatio: 1, cacheBust: false, width: window.innerWidth, height: window.innerHeight,
      backgroundColor: getComputedStyle(document.body).backgroundColor || undefined,
      style: { transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)`, transformOrigin: "top left" },
      filter: (el) => !(el instanceof HTMLElement && (el.dataset.feedbackIgnore !== undefined || el.hasAttribute("data-sonner-toaster"))),
    });
  } catch {
    return null;
  }
}

/** Mounted once in the shell: keeps the recent errors, listens for openReportProblem() and shows the dialog. */
export function ReportProblemHost() {
  const [state, setState] = useState<{ shot: Blob | null; preview: string | null; ctx: ReturnType<typeof pageContext> } | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    const onApi = (e: Event) => {
      const d = (e as CustomEvent<{ method: string; path: string; status: number; message: string }>).detail;
      if (d.status !== 401) remember(`${d.status || "No connection"} ${d.method} ${d.path} · ${d.message}`);
    };
    const onError = (e: ErrorEvent) => remember(`Script error · ${e.message}${e.filename ? ` (${stripBase(new URL(e.filename, window.location.href).pathname)}:${e.lineno})` : ""}`);
    const onRejection = (e: PromiseRejectionEvent) => {
      // An API refusal is already remembered by onApi.
      if (e.reason && typeof e.reason === "object" && "status" in e.reason) return;
      remember(`Unhandled · ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`);
    };
    const onOpen = async () => {
      if (busy.current) return;
      busy.current = true;
      const ctx = pageContext();
      const t = toast.loading("Taking a screenshot of the screen…");
      const shot = await capture();
      toast.dismiss(t);
      // The thumbnail's object URL lives as long as the dialog (revoked when it closes).
      setState({ shot, preview: shot ? URL.createObjectURL(shot) : null, ctx });
      busy.current = false;
    };
    window.addEventListener(API_ERROR_EVENT, onApi);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener(EVENT, onOpen);
    return () => {
      window.removeEventListener(API_ERROR_EVENT, onApi);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener(EVENT, onOpen);
    };
  }, []);
  if (!state) return null;
  return <ReportProblemDialog {...state} onClose={() => { if (state.preview) URL.revokeObjectURL(state.preview); setState(null); }} />;
}

function ReportProblemDialog({ shot, preview, ctx, onClose }: {
  shot: Blob | null; preview: string | null; ctx: ReturnType<typeof pageContext>; onClose: () => void;
}) {
  const { company, branch, me } = useSession();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState("");
  const [kind, setKind] = useState("problem");
  const [severity, setSeverity] = useState("normal");
  const [withShot, setWithShot] = useState(!!shot);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function send() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api<{ id: string; number: string }>("/feedback", "POST", { title, description, steps: steps || null, kind, severity, ...ctx });
      const failed: string[] = [];
      if (withShot && shot) await apiUpload(`/feedback/${r.id}/files?kind=screenshot`, shot, "screenshot.png").catch(() => failed.push("the screenshot"));
      for (const file of files) await apiUpload(`/feedback/${r.id}/files`, file, file.name).catch((e: Error) => failed.push(`${file.name} (${e.message})`));
      toast.success(<span>Thank you — <Link className="underline" href={`/admin/feedback/${r.id}`}>{r.number}</Link> was sent. Its status shows under My problem reports.</span>);
      if (failed.length) toast.error(`Not attached: ${failed.join(", ")}. Open ${r.number} to add them again.`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-testid="report-problem" data-feedback-ignore="">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><MessageSquareWarningIcon className="size-4 text-primary" /> Report a problem</DialogTitle>
          <DialogDescription>Tell us what happened. The screen, the company and branch and your browser are added for you.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <Field label="Title" span>
            <Input autoFocus value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. The bill shows the wrong VAT" aria-label="Title" />
          </Field>
          <Field label="What happened, and what did you expect?" span>
            <Textarea rows={4} value={description} maxLength={8000} onChange={(e) => setDescription(e.target.value)} aria-label="What happened" />
          </Field>
          <Field label="Steps to repeat it (optional)" span>
            <Textarea rows={3} value={steps} maxLength={8000} onChange={(e) => setSteps(e.target.value)} placeholder={"1. Open …\n2. Tap …"} aria-label="Steps to repeat it" />
          </Field>
          <Field label="Type">
            <select className={selectClass} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Type">
              {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Priority" hint="Blocker: you can't go on working.">
            <select className={selectClass} value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Priority">
              {Object.entries(SEVERITY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Files (optional)" hint="Photos, PDF, Excel, Word or text, up to 10 MB each." span>
            <span className="flex h-8 cursor-pointer items-center gap-2 rounded-lg border px-2.5 text-sm text-muted-foreground hover:bg-muted">
              <PaperclipIcon className="size-3.5" /> Attach files…
              <input type="file" multiple className="sr-only" aria-label="Attach files" accept=".png,.jpg,.jpeg,.webp,.pdf,.xlsx,.docx,.csv,.txt,.log"
                onChange={(e) => { setFiles((f) => [...f, ...Array.from(e.target.files ?? [])]); e.target.value = ""; }} />
            </span>
          </Field>
          {files.length > 0 && (
            <ul className="space-y-1 text-sm sm:col-span-2">
              {files.map((f, i) => (
                <li key={i} className="flex items-center gap-2"><PaperclipIcon className="size-3.5 text-muted-foreground" /><span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <button type="button" aria-label={`Remove ${f.name}`} className="rounded p-0.5 text-muted-foreground hover:bg-muted" onClick={() => setFiles((x) => x.filter((_, j) => j !== i))}><XIcon className="size-3.5" /></button>
                </li>
              ))}
            </ul>
          )}
          <div className="sm:col-span-2">
            {preview ? (
              <label className="flex items-start gap-3 rounded-lg border p-2.5">
                <Checkbox checked={withShot} onCheckedChange={(v) => setWithShot(v === true)} aria-label="Include the screenshot" />
                <span className="min-w-0 flex-1 text-sm">
                  <span className="font-medium">Include a screenshot of the screen</span>
                  <span className="block text-xs text-muted-foreground">Taken just now, before this box opened. Untick it if the screen shows something private.</span>
                </span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={preview} alt="Screenshot of the screen" className={cn("h-20 w-32 shrink-0 rounded border object-cover object-top", !withShot && "opacity-40")} data-testid="report-screenshot" />
              </label>
            ) : (
              <p className="flex items-center gap-2 text-xs text-muted-foreground"><ImageIcon className="size-3.5" /> The browser couldn&apos;t take a screenshot of this screen; attach one as a file if it helps.</p>
            )}
          </div>
          <details className="text-xs text-muted-foreground sm:col-span-2">
            <summary className="cursor-pointer select-none">Sent with your report</summary>
            <dl className="mt-2 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
              <dt>Screen</dt><dd className="[overflow-wrap:anywhere]">{ctx.pageTitle} · {ctx.pagePath}</dd>
              <dt>Company</dt><dd>{company ? `${company.code} ${company.name}${branch ? ` · ${branch.code} ${branch.name}` : ""}` : "—"}</dd>
              {me.till?.registerName && <><dt>Till</dt><dd>{me.till.registerName}</dd></>}
              <dt>You</dt><dd>{me.user.displayName}</dd>
              <dt>Browser</dt><dd className="[overflow-wrap:anywhere]">{ctx.browser}</dd>
              <dt>Screen size</dt><dd>{ctx.screen}</dd>
              <dt>Recent errors</dt><dd className="[overflow-wrap:anywhere]">{ctx.errors.length ? ctx.errors.map((x, i) => <span key={i} className="block">{x}</span>) : "None in the last two hours"}</dd>
            </dl>
          </details>
          <div className="sm:col-span-2"><ErrorNote message={error} /></div>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving || title.trim().length < 3 || !description.trim()} data-testid="report-send">{saving ? "Sending…" : "Send report"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
