"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { ReceiptLine } from "@/lib/device";
import { drawReceipt } from "@/lib/receipt-draw";

/**
 * Receipt lines on screen exactly as the till's receipt printer prints them: drawn the way the Device Service draws them (the same
 * fonts, sizes and columns), so the preview, a browser print and the printed receipt look the same. Only this prints with the
 * browser (.print-area); its text stays readable to screen readers.
 */
export function PrintedLines({ lines, className }: { lines: ReceiptLine[]; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  // Redrawn when the receipt changes, not on every render (callers build a new list each time).
  const key = JSON.stringify(lines);
  useEffect(() => {
    let live = true;
    drawReceipt(JSON.parse(key) as ReceiptLine[]).then((s) => { if (live) setSrc(s); }).catch(() => { if (live) setSrc(null); });
    return () => { live = false; };
  }, [key]);
  const text = lines.map((l) => [l.text, l.ar, l.mid, l.right].filter(Boolean).join("  ")).filter(Boolean).join("\n");
  return (
    <div className={cn("print-area print-receipt overflow-y-auto rounded-xl border bg-white p-2", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- the receipt drawn here (data URL) */}
      {src ? <img src={src} alt={text} className="block w-full" /> : <div className="h-80 rounded-lg skeleton-shimmer" aria-label="Receipt" />}
    </div>
  );
}
