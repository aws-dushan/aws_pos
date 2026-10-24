/**
 * A receipt or credit note printed from the browser (no Device Service on this PC): the on-screen receipt alone, on an 80 mm page
 * like the receipt printer's, outside the dialog it is shown in (a dialog is fixed, centred and clipped, so printing the page as is
 * cuts the receipt off). It prints from a hidden frame that carries the app's styles.
 */
export function printReceiptArea(): boolean {
  const el = Array.from(document.querySelectorAll<HTMLElement>(".print-receipt")).pop();
  if (!el) return false;
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"], style')).map((n) => n.outerHTML).join("");
  doc.open();
  // The page's own <html> classes carry the fonts (next/font variables): without them the receipt prints in a serif font.
  doc.write(`<!doctype html><html class="${document.documentElement.className}"><head><meta charset="utf-8">${styles}<style>
    @page { size: 80mm auto; margin: 0; }
    html, body { margin: 0; padding: 0; background: #fff; }
    .print-receipt { position: static !important; width: 72mm !important; margin: 0 4mm !important; max-height: none !important; overflow: visible !important; border: 0 !important; border-radius: 0 !important; box-shadow: none !important; padding: 2mm 0 !important; }
    .print-receipt img { width: 100% !important; }
  </style></head><body>${el.outerHTML}</body></html>`);
  doc.close();
  const go = () => {
    frame.contentWindow!.focus();
    frame.contentWindow!.print();
    window.setTimeout(() => frame.remove(), 1000);
  };
  // Print once the styles and images (logo, QR code) have loaded.
  if (doc.readyState === "complete") window.setTimeout(go, 250); else frame.onload = () => window.setTimeout(go, 250);
  return true;
}
