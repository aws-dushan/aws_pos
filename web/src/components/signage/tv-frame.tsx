"use client";

import { useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/base-path";
import { cn } from "@/lib/utils";
import type { DesignContent, PlayData } from "@/lib/signage";

/**
 * The TV player itself (public/tv.html) in a frame, showing a design: the designer's preview and the design cards are drawn by
 * the same code as the TVs. `lock` shows one slide only (none: the loop); a new `replay` number draws it again. The player uses the
 * signed-in manager's session for pictures (same address). Children sit on top of the picture (the placed-pictures editor).
 */
export function TvFrame({ content, data, lock = null, replay = 0, className, children }: {
  content: DesignContent | null; data: PlayData | null; lock?: string | null; replay?: number; className?: string; children?: React.ReactNode;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin === window.location.origin && e.source === frame.current?.contentWindow && (e.data as { type?: string })?.type === "onepos-tv-ready") setReady(true);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  useEffect(() => {
    if (!ready || !content) return;
    frame.current?.contentWindow?.postMessage({ type: "onepos-tv", content, data, lock, replay }, window.location.origin);
  }, [ready, content, data, lock, replay]);

  return (
    <div className={cn("relative aspect-video w-full overflow-hidden bg-black", className)}>
      <iframe ref={frame} src={withBase("/tv.html?preview=1")} title="TV preview" tabIndex={-1}
        className="pointer-events-none absolute inset-0 size-full border-0" />
      {children}
    </div>
  );
}
