"use client";

import { useEffect, useState } from "react";
import { withBase } from "@/lib/base-path";

/** The digital receipt's address (REQ PAY-05): this One POS site, /r/<token>. */
export const receiptUrl = (token: string) => `${window.location.origin}${withBase(`/r/${token}`)}`;

/** A QR code as a PNG data URL (black on white, for the receipt printer and the screen). The library loads only when needed. */
export async function qrImage(text: string): Promise<string> {
  const QR = await import("qrcode");
  return QR.toDataURL(text, { errorCorrectionLevel: "M", margin: 1, width: 256, color: { dark: "#000000", light: "#ffffff" } });
}

/** The receipt's QR picture once made (null while making it, or when the receipt has none). */
export function useReceiptQr(token: string | null | undefined) {
  const [img, setImg] = useState<{ token: string; src: string } | null>(null);
  useEffect(() => {
    if (!token) return;
    let live = true;
    void qrImage(receiptUrl(token)).then((src) => { if (live) setImg({ token, src }); }, () => {});
    return () => { live = false; };
  }, [token]);
  return token && img?.token === token ? img.src : null;
}
