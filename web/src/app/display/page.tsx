"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckIcon } from "lucide-react";
import { fmtIn } from "@/lib/num";
import { DISPLAY_CHANNEL, type DisplayMessage } from "@/lib/customer-display";
import { Logo } from "@/components/logo";
import { CountUp, EASE } from "@/components/motion";
import { fmtQty } from "@/lib/pos";
import { api, setApiScope } from "@/lib/api";
import { appStorage } from "@/lib/base-path";
import { useStored } from "@/lib/hooks";
import { withBase } from "@/lib/base-path";

const money = (n: number) => fmtIn(n, 2);

/**
 * The customer display (REQ HW-05) for the till's second screen: welcome when idle; the order building up as items are added
 * (each slides in), the total counting; on payment a green check with the change, then back to welcome. Tap once for full screen.
 */
export default function CustomerDisplayPage() {
  const [msg, setMsg] = useState<DisplayMessage>({ kind: "idle" });
  // Pictures between orders (Receipt & display screen): each for its seconds, in turn; read again every 5 minutes.
  const [pictures, setPictures] = useState<{ id: string; companyId: string; caption: string | null; seconds: number; createdAt: string }[]>([]);
  const [slide, setSlide] = useState(0);
  // The display is its own window: it works for the company and branch chosen in this browser (a till's PIN sign-in has its own).
  const stored = useStored("onepos.scope");
  const tillBranch = useStored("onepos.till.branch");
  // The branch's logo on the welcome screen (each branch has its own).
  const branchId = tillBranch ?? (() => { try { return (JSON.parse(stored ?? "{}") as { branchId?: string }).branchId ?? null; } catch { return null; } })();
  const [logoOk, setLogoOk] = useState(true);
  useEffect(() => {
    try {
      const s = JSON.parse(appStorage.getItem("onepos.scope") ?? "{}") as { companyId?: string; branchId?: string };
      const tillBranch = appStorage.getItem("onepos.till.branch");
      setApiScope(s.companyId ?? null, tillBranch ?? s.branchId ?? null);
    } catch { /* nothing stored: a till's session decides */ }
    const load = () => void api<{ id: string; companyId: string; caption: string | null; seconds: number; createdAt: string }[]>("/display/images").then(setPictures, () => {});
    load();
    const t = window.setInterval(load, 5 * 60_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    if (msg.kind !== "idle" || pictures.length < 2) return;
    const t = window.setTimeout(() => setSlide((n) => n + 1), (pictures[slide % pictures.length]?.seconds ?? 8) * 1000);
    return () => window.clearTimeout(t);
  }, [msg.kind, pictures, slide]);
  useEffect(() => {
    const ch = new BroadcastChannel(DISPLAY_CHANNEL);
    let back: number | undefined;
    ch.onmessage = (e: MessageEvent<DisplayMessage>) => {
      window.clearTimeout(back);
      setMsg(e.data);
      if (e.data.kind === "paid") back = window.setTimeout(() => setMsg({ kind: "idle" }), 8000);
    };
    return () => { ch.close(); window.clearTimeout(back); };
  }, []);

  return (
    <main className="flex h-dvh cursor-none flex-col overflow-hidden bg-background select-none"
      onClick={() => { if (!document.fullscreenElement) void document.documentElement.requestFullscreen().catch(() => {}); }}>
      <AnimatePresence mode="wait">
        {msg.kind === "idle" && (pictures.length > 0 ? (
          <motion.section key="pictures" className="relative flex-1 bg-black" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
            <AnimatePresence>
              <motion.img key={pictures[slide % pictures.length].id} src={withBase(`/api/display/images/${pictures[slide % pictures.length].companyId}/${pictures[slide % pictures.length].id}?v=${pictures[slide % pictures.length].createdAt}`)}
                alt={pictures[slide % pictures.length].caption ?? ""} className="absolute inset-0 size-full object-contain"
                initial={{ opacity: 0, scale: 1.02 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.8, ease: EASE }} />
            </AnimatePresence>
            {pictures[slide % pictures.length].caption && (
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-12 pt-20 pb-10 font-heading text-4xl font-medium text-white">{pictures[slide % pictures.length].caption}</div>
            )}
          </motion.section>
        ) : (
          <motion.section key="idle" className="flex flex-1 flex-col items-center justify-center gap-8 text-white" style={{ background: "var(--hero)" }}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
            {branchId && logoOk
              // eslint-disable-next-line @next/next/no-img-element -- the branch's own logo, same origin
              ? <img src={withBase(`/api/branches/${branchId}/logo`)} alt="" onError={() => setLogoOk(false)} className="max-h-48 max-w-[50vw] rounded-3xl bg-white/95 object-contain p-6" />
              : <Logo variant="full" tone="dark" className="h-28" />}
            <div className="font-heading text-5xl font-light tracking-tight">Welcome · أهلاً وسهلاً</div>
          </motion.section>
        ))}

        {msg.kind === "order" && (
          <motion.section key="order" className="grid flex-1 grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
            <div className="flex min-h-0 flex-col p-10">
              <div className="mb-6 flex items-center justify-between">
                <Logo className="h-12" />
                {msg.number && <span className="font-mono text-lg text-muted-foreground">#{msg.number}</span>}
              </div>
              <ul className="min-h-0 flex-1 space-y-3 overflow-hidden">
                <AnimatePresence initial={false}>
                  {msg.lines.slice(-9).map((l) => (
                    <motion.li key={l.id} layout initial={{ opacity: 0, x: -24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease: EASE }}
                      className="surface flex items-center gap-5 px-6 py-4">
                      <span className="font-heading text-3xl font-semibold text-primary tabular-nums">{fmtQty(l.qty)}×</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-heading text-2xl font-medium">{l.name}</span>
                        {l.nameAr && <span dir="rtl" className="block truncate text-right text-xl text-muted-foreground">{l.nameAr}</span>}
                        {l.extras && <span className="block truncate text-base text-muted-foreground">{l.extras}</span>}
                      </span>
                      <span className="font-heading text-2xl tabular-nums">{money(l.amount)}</span>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            </div>
            <div className="flex flex-col justify-end gap-6 p-10 text-white" style={{ background: "var(--hero)" }}>
              {msg.discount > 0 && <Row label="Discount · الخصم" value={`−${money(msg.discount)}`} />}
              <Row label="VAT included · شامل الضريبة" value={money(msg.vat)} />
              <div className="border-t border-white/20 pt-6">
                <div className="text-xl text-white/70">{msg.due < msg.total ? "Left to pay · المتبقي" : "Total · الإجمالي"}</div>
                <div className="mt-2 flex items-baseline gap-3 font-heading text-8xl font-semibold tracking-tight">
                  <span className="text-3xl font-medium opacity-60">{msg.currency}</span><CountUp value={msg.due} format={money} duration={0.4} />
                </div>
              </div>
            </div>
          </motion.section>
        )}

        {msg.kind === "paid" && (
          <motion.section key="paid" className="flex flex-1 flex-col items-center justify-center gap-6 text-white" style={{ background: "var(--hero)" }}
            initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.35, ease: EASE }}>
            <motion.span className="flex size-36 items-center justify-center rounded-full bg-success shadow-pop"
              initial={{ scale: 0.4 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 300, damping: 16 }}>
              <CheckIcon className="size-20" strokeWidth={3} />
            </motion.span>
            <div className="font-heading text-6xl font-semibold tracking-tight">Thank you · شكراً</div>
            {msg.change > 0 && <div className="text-4xl text-white/85">Your change · الباقي <span className="font-heading font-semibold tabular-nums">{msg.currency} {money(msg.change)}</span></div>}
          </motion.section>
        )}
      </AnimatePresence>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between text-2xl text-white/80"><span>{label}</span><span className="tabular-nums">{value}</span></div>;
}
