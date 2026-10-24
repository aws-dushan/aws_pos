"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { AlertTriangleIcon, HelpCircleIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PopIn } from "@/components/motion";

/*
 * The app's one "are you sure?" box, instead of the browser's confirm(). Promise based, so any code
 * can ask:   if (!(await confirmDialog({ title: "Delete the role?", tone: "danger" }))) return;
 * Enter confirms, Esc cancels. A danger box has a red confirm button and starts with focus on Cancel.
 * <ConfirmHost /> is mounted once in the root layout. (Copied from AWS One.)
 */

export type ConfirmOptions = {
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "default";
  /** Ask for a reason too (a required text box); promptReason() resolves with it. */
  reason?: { label: string; placeholder?: string };
};

type Request = ConfirmOptions & { id: number; resolve: (ok: boolean, text?: string) => void };

let show: ((r: Request) => void) | null = null;
const waiting: Request[] = [];
let nextId = 1;

/** Asks the user for a reason (e.g. to post into a filed tax period); resolves with the reason, or null when cancelled. */
export function promptReason(options: ConfirmOptions & { reason: { label: string; placeholder?: string } }): Promise<string | null> {
  return new Promise((resolve) => {
    const request: Request = { ...options, id: nextId++, resolve: (ok, text) => resolve(ok && text?.trim() ? text.trim() : null) };
    if (show) show(request);
    else waiting.push(request);
  });
}

/** Asks the user; resolves true when they confirm. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const request = { ...options, id: nextId++, resolve };
    if (show) show(request);
    else waiting.push(request);   // asked before the host mounted: shown as soon as it does
  });
}

export function ConfirmHost() {
  // Unanswered requests, oldest first; the box shows the first one and stays open while more wait.
  const [queue, setQueue] = useState<Request[]>(() => [...waiting]);
  // The last request shown, so its text stays on screen while the box animates closed.
  const [last, setLast] = useState<Request | null>(null);
  if (queue[0] && queue[0] !== last) setLast(queue[0]);
  const current = queue[0] ?? last;
  const open = queue.length > 0;
  const safeRef = useRef<HTMLButtonElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");

  useEffect(() => {
    show = (r) => setQueue((q) => [...q, r]);
    waiting.length = 0;   // taken over by the initial queue
    return () => { show = null; };
  }, []);

  function answer(ok: boolean) {
    const first = queue[0];
    if (!first) return;
    if (ok && first.reason && !text.trim()) { reasonRef.current?.focus(); return; }
    first.resolve(ok, text);
    setText("");
    setQueue((q) => q.filter((r) => r !== first));
  }

  const danger = current?.tone === "danger";
  const Icon = danger ? AlertTriangleIcon : HelpCircleIcon;

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(o) => { if (!o) answer(false); }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-[60] bg-[oklch(0.2_0.03_268/0.35)] backdrop-blur-[2px] duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup
          role="alertdialog"
          initialFocus={current?.reason ? reasonRef : danger ? safeRef : okRef}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && (!current?.reason || e.ctrlKey || e.metaKey)) { e.preventDefault(); answer(true); }
          }}
          className="fixed top-1/2 left-1/2 z-[60] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 outline-none sm:max-w-md data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 duration-100"
        >
          {current && (
            <PopIn key={current.id} className="overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-pop">
              <div className="flex gap-4 p-5">
                <span className={cn(
                  "flex size-10 shrink-0 items-center justify-center rounded-full",
                  danger ? "bg-danger/12 text-danger" : "bg-primary/10 text-primary",
                )}>
                  <Icon className="size-5" />
                </span>
                <div className="min-w-0 space-y-1.5 pt-0.5">
                  <DialogPrimitive.Title className="font-heading text-base font-semibold">{current.title}</DialogPrimitive.Title>
                  {current.message && (
                    <DialogPrimitive.Description className="text-sm whitespace-pre-line text-muted-foreground">{current.message}</DialogPrimitive.Description>
                  )}
                  {current.reason && (
                    <label className="block space-y-1 pt-1 text-sm">
                      <span className="font-medium">{current.reason.label}</span>
                      <textarea ref={reasonRef} value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={500}
                        placeholder={current.reason.placeholder} data-testid="confirm-reason"
                        className={cn("w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                          !text.trim() && "border-danger/50")} />
                    </label>
                  )}
                </div>
              </div>
              <div className="flex flex-col-reverse gap-2 border-t bg-muted/40 px-5 py-3 sm:flex-row sm:justify-end">
                <Button ref={safeRef} variant="outline" onClick={() => answer(false)}>{current.cancelLabel ?? "Cancel"}</Button>
                <Button
                  ref={okRef}
                  onClick={() => answer(true)}
                  disabled={!!current.reason && !text.trim()}
                  className={danger ? "bg-danger text-white hover:bg-danger/90 focus-visible:ring-danger/30" : undefined}
                >
                  {current.confirmLabel ?? "OK"}
                </Button>
              </div>
            </PopIn>
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** "Reset demo data?" (user menu). */
export const confirmReset = () => confirmDialog({
  title: "Reset the demo data?",
  message: "Orders, kitchen tickets, menu changes and table layout go back to the sample restaurant. This can't be undone.",
  confirmLabel: "Reset", tone: "danger",
});
