"use client";

import { useEffect, useState } from "react";
import { MonitorIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/kit";

type Size = { w: number; h: number; dpr: number; sw: number; sh: number };

/**
 * Screen check: the size this browser really gives the page, and which layout that gets. Open it on a till to see why a
 * screen stacks: Windows display scaling or browser zoom shrink the width the page sees (1024 at 150% is 683).
 */
export default function ScreenPage() {
  const [s, setS] = useState<Size | null>(null);
  useEffect(() => {
    const read = () => setS({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, sw: screen.width, sh: screen.height });
    read();
    addEventListener("resize", read);
    return () => removeEventListener("resize", read);
  }, []);
  if (!s) return null;
  const till = s.w >= 768;
  const pct = Math.round(s.dpr * 100);
  return (
    <div className="mx-auto max-w-[760px] pb-6">
      <PageHeader title="Screen check" icon={MonitorIcon} description="The size this browser gives One POS on this screen." />
      <div className={cn("rounded-2xl border p-6 text-center", till ? "border-success/40 bg-success/10" : "border-danger/40 bg-danger/10")}>
        <div className="font-heading text-5xl font-semibold tabular-nums">{s.w} × {s.h}</div>
        <div className={cn("mt-2 text-lg font-medium", till ? "text-success" : "text-danger")}>
          {till ? "Till layout: panels side by side" : "Too narrow: panels stack like a phone"}
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-xl border bg-card p-3"><dt className="text-muted-foreground">Screen</dt><dd className="text-lg font-medium tabular-nums">{s.sw} × {s.sh}</dd></div>
        <div className="rounded-xl border bg-card p-3"><dt className="text-muted-foreground">Scaling and zoom</dt><dd className="text-lg font-medium tabular-nums">{pct}%</dd></div>
      </dl>
      {!till && (
        <p className="mt-4 text-sm">
          The page needs at least 768 wide. Set Windows display scaling to 100% (Settings › System › Display) and browser zoom to 100% (Ctrl+0), then press F11 for full screen.
        </p>
      )}
    </div>
  );
}
