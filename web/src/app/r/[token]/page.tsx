"use client";

import { use, useEffect, useState } from "react";
import { PrinterIcon, ReceiptTextIcon } from "lucide-react";
import { withBase } from "@/lib/base-path";
import { receiptLines, type Receipt } from "@/components/pos-payment";
import { PrintedLines } from "@/components/printed-lines";
import { Button } from "@/components/ui/button";

/**
 * The digital receipt (REQ PAY-05): what a receipt's QR code opens on the customer's phone, without signing in. The same lines
 * as the printed receipt (payment references left out), to keep, print or save as PDF.
 */
export default function DigitalReceiptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [r, setR] = useState<Receipt | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(withBase(`/api/public/receipts/${encodeURIComponent(token)}`)).then(async (res) => {
      if (!live) return;
      if (!res.ok) { setMissing(true); return; }
      setR({ ...(await res.json() as Receipt), publicToken: token });
    }, () => live && setMissing(true));
    return () => { live = false; };
  }, [token]);

  return (
    <main className="min-h-dvh bg-muted/40 px-4 py-8">
      <div className="mx-auto w-full max-w-sm">
        {missing ? (
          <div className="surface flex flex-col items-center gap-3 px-6 py-12 text-center">
            <ReceiptTextIcon className="size-8 text-muted-foreground" />
            <h1 className="font-heading text-lg font-semibold">Receipt not found</h1>
            <p className="text-sm text-muted-foreground">Check the link, or ask the restaurant for a copy.</p>
          </div>
        ) : !r ? <div className="h-[32rem] rounded-2xl skeleton-shimmer" /> : (
          <>
            <div className="surface p-4"><PrintedLines lines={receiptLines(r)} /></div>
            <Button variant="outline" className="mt-4 h-11 w-full print:hidden" onClick={() => window.print()}><PrinterIcon /> Print or save as PDF</Button>
          </>
        )}
      </div>
    </main>
  );
}
