"use client";

import { NewspaperIcon, TriangleAlertIcon } from "lucide-react";
import { api, useApi } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type Notice = {
  id: string; branchCode: string; branchName: string; businessDate: string; kind: "summary" | "alert"; title: string;
  lines: { label: string; value: string; warn: boolean }[]; emailStatus: string; createdAt: string; isRead: boolean;
};

/**
 * Daily summaries and alerts (REQ DAY-10): made when a branch's day closes, where the company has them switched on. Shown only
 * once there is one; opening the list marks them read.
 */
export function NoticeBell() {
  const { can } = useSession();
  const show = can("reports.view") || can("day.manage");
  const list = useApi<{ unread: number; items: Notice[] }>(show ? "/notices?take=20" : null);
  useLiveEvent(["day.changed"], () => list.reload());
  if (!show || !list.data?.items.length) return null;
  const n = list.data.unread;
  const hasAlert = list.data.items.some((x) => !x.isRead && x.kind === "alert");

  return (
    <Popover onOpenChange={(open) => { if (open && n > 0) void api("/notices/read", "POST", { ids: null }).then(() => list.reload(), () => {}); }}>
      <PopoverTrigger render={
        <button type="button" aria-label={`Daily summaries and alerts${n ? `: ${n} new` : ""}`} className="relative flex size-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
          <NewspaperIcon className={cn("size-5", hasAlert ? "text-danger" : n > 0 && "text-primary")} />
          {n > 0 && <span className={cn("absolute top-1 right-1 flex min-w-4.5 items-center justify-center rounded-full px-1 text-[0.65rem] font-semibold text-white tabular-nums animate-rise-in", hasAlert ? "bg-danger" : "bg-primary")}>{n}</span>}
        </button>
      } />
      <PopoverContent align="end" className="max-h-[70vh] w-96 overflow-y-auto p-0">
        <div className="border-b px-4 py-3 font-heading text-sm font-semibold">Daily summaries and alerts</div>
        <div className="divide-y">
          {list.data.items.map((x) => (
            <div key={x.id} className={cn("px-4 py-3", !x.isRead && "bg-primary/[0.04]")}>
              <div className="flex items-center gap-2">
                {x.kind === "alert" ? <TriangleAlertIcon className="size-4 shrink-0 text-danger" /> : <NewspaperIcon className="size-4 shrink-0 text-primary" />}
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{x.branchCode} · {x.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(x.createdAt)}</span>
              </div>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                {x.lines.map((l, i) => (
                  <div key={i} className="contents">
                    <dt className="text-muted-foreground">{l.label}</dt>
                    <dd className={cn("text-right tabular-nums", l.warn && "font-medium text-danger")}>{l.value}</dd>
                  </div>
                ))}
              </dl>
              {x.emailStatus === "failed" && <p className="mt-1.5 text-xs text-warning">Couldn&apos;t be emailed (check the email settings).</p>}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
