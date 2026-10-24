"use client";

import { useState } from "react";
import { PercentIcon, TagIcon, XIcon } from "lucide-react";
import { useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtIn } from "@/lib/num";
import type { OrderDetail, OrderLine } from "@/lib/pos";
import { Numpad } from "@/components/numpad";
import { Segmented } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type Listed = { id: string; name: string; type: "pct" | "amount"; value: number; target: "bill" | "item"; needsNote: boolean };
const money = (n: number) => fmtIn(n, 2);

/**
 * The Discount window on the till: for the whole bill, or for one item (`line`). Tap a ready-made discount (the ones this user's
 * role may give), or type a % or an AED amount (within the role's limit: above it a manager approves on the till). Remove takes
 * the discount off. `apply` sends it and answers the whole order (null when it failed: the error is already shown).
 */
export function DiscountDialog({ open, line, detail, currency, onClose, apply }: {
  open: boolean; line: OrderLine | null; detail: OrderDetail; currency: string; onClose: () => void;
  apply: (path: string, body: unknown) => Promise<OrderDetail | null>;
}) {
  const o = detail.order;
  const target = line ? "item" : "bill";
  const list = useApi<{ canDiscount: boolean; limitPct: number | null; discounts: Listed[] }>(open ? "/pos/discounts" : null);
  const [mode, setMode] = useState<"pct" | "amount">("pct");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [needsNoteFor, setNeedsNoteFor] = useState<Listed | null>(null);
  const [busy, setBusy] = useState(false);
  const path = line ? `/orders/${o.id}/lines/${line.id}/discount` : `/orders/${o.id}/discount`;
  const listed = (list.data?.discounts ?? []).filter((d) => d.target === target);
  const has = line ? !!line.discType : o.discountPct > 0 || o.discountAmount > 0;
  const gross = line ? line.unitPrice * line.qty : o.subtotal;

  async function send(body: unknown) {
    setBusy(true);
    const r = await apply(path, body);
    setBusy(false);
    if (r) { setValue(""); setNote(""); setNeedsNoteFor(null); onClose(); }
  }
  function pick(d: Listed) {
    if (d.needsNote && !note.trim()) { setNeedsNoteFor(d); return; }
    void send({ discountId: d.id, note: note.trim() || null });
  }
  const typed = Number(value || 0);
  const preview = mode === "pct" ? gross * typed / 100 : line ? typed * line.qty : typed;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{line ? `Discount · ${line.name}` : "Discount · whole bill"}</DialogTitle>
          <DialogDescription>
            {line ? `${money(line.unitPrice)} each × ${line.qty}. ` : `Bill ${currency} ${money(o.subtotal)}. `}
            Pick a discount or type one.{o.platformId ? ` A ${o.platformName ?? "platform"} order: no discount limit.`
              : list.data?.limitPct != null ? ` You can give up to ${list.data.limitPct}% yourself; more needs a manager.` : ""}
          </DialogDescription>
        </DialogHeader>
        {list.data && !list.data.canDiscount ? (
          <p className="rounded-xl bg-warning/12 px-4 py-3 text-sm text-warning">Your role can&apos;t give discounts. Ask a supervisor.</p>
        ) : (
          <div className="grid gap-5 md:grid-cols-[1fr_280px]">
            <div className="space-y-3">
              {listed.length > 0 && (
                <div className="grid grid-cols-2 gap-2">
                  {listed.map((d) => (
                    <button key={d.id} type="button" disabled={busy} onClick={() => pick(d)}
                      className={cn("flex min-h-14 items-center gap-2 rounded-xl border bg-card px-3 py-2 text-left transition-[background-color,transform] hover:bg-muted active:scale-[0.98]",
                        needsNoteFor?.id === d.id && "border-primary bg-primary/10")}>
                      <TagIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm leading-tight font-medium">{d.name}</span>
                        <span className="block text-xs text-muted-foreground">{d.type === "pct" ? `${d.value}% off` : `${currency} ${money(d.value)} off${line ? " each" : ""}`}{d.needsNote ? " · name/reason" : ""}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {needsNoteFor && (
                <div className="space-y-2 rounded-xl border border-primary/40 bg-primary/5 p-3">
                  <span className="text-sm font-medium">{needsNoteFor.name}: who is it for, or why?</span>
                  <div className="flex gap-2">
                    <Input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. staff member's name" className="h-11" />
                    <Button className="h-11" disabled={busy || !note.trim()} onClick={() => void send({ discountId: needsNoteFor.id, note: note.trim() })}>Apply</Button>
                  </div>
                </div>
              )}
              <div className="space-y-2 rounded-xl border p-3">
                <span className="flex items-center gap-1.5 text-sm font-medium"><PercentIcon className="size-4 text-muted-foreground" /> Type a discount</span>
                <Segmented id="disc-mode" value={mode} onChange={(m) => { setMode(m); setValue(""); }} className="w-full"
                  options={[{ value: "pct", label: "% off" }, { value: "amount", label: line ? `${currency} off each` : `${currency} off` }]} />
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason (optional)" className="h-11" />
                {typed > 0 && <p className="text-sm text-muted-foreground">Takes {currency} {money(Math.min(preview, gross))} off{line ? ` ${line.name}` : " the bill"}.</p>}
              </div>
            </div>
            <div className="space-y-3">
              <div className="flex h-14 items-center justify-end rounded-xl border bg-muted/40 px-4 font-heading text-3xl font-semibold tabular-nums">
                <span className="mr-auto text-sm font-medium text-muted-foreground">{mode === "pct" ? "%" : currency}</span>{value || "0"}
              </div>
              <Numpad value={value} onChange={setValue} onEnter={() => { if (!busy && typed > 0) void send(mode === "pct" ? { pct: typed, note: note.trim() || null } : { amount: typed, note: note.trim() || null }); }} />
            </div>
          </div>
        )}
        <DialogFooter>
          {has && <Button variant="outline" className="mr-auto h-12 text-danger" disabled={busy} onClick={() => void send({ clear: true })}><XIcon /> Remove discount</Button>}
          <Button variant="outline" className="h-12" onClick={onClose}>Cancel</Button>
          <Button className="h-12 min-w-40" disabled={busy || !(typed > 0) || !list.data?.canDiscount}
            onClick={() => void send(mode === "pct" ? { pct: typed, note: note.trim() || null } : { amount: typed, note: note.trim() || null })}>
            Apply {typed > 0 ? (mode === "pct" ? `${typed}%` : `${currency} ${money(typed)}`) : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A delivery platform's offer on its order: the amount shown on the platform's tablet, and who pays for it. "We pay" becomes the
 * bill discount (so One POS matches what the platform pays us); "Platform pays" leaves the bill at full price and only notes it.
 */
export function PlatformOfferDialog({ open, detail, currency, onClose, apply }: {
  open: boolean; detail: OrderDetail; currency: string; onClose: () => void; apply: (path: string, body: unknown) => Promise<OrderDetail | null>;
}) {
  const o = detail.order;
  const [paidBy, setPaidBy] = useState<"us" | "platform">("us");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const amount = Number(value || 0);
  async function save(v: number) {
    setBusy(true);
    const r = await apply(`/orders/${o.id}/platform-offer`, { amount: v, paidBy });
    setBusy(false);
    if (r) { setValue(""); onClose(); }
  }
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{o.platformName} offer</DialogTitle>
          <DialogDescription>Type the offer shown on the {o.platformName} tablet, and who pays for it.</DialogDescription>
        </DialogHeader>
        <Segmented id="offer-paid-by" value={paidBy} onChange={setPaidBy} className="w-full"
          options={[{ value: "us", label: "We pay (discount on the bill)" }, { value: "platform", label: `${o.platformName} pays` }]} />
        <p className="text-xs text-muted-foreground">
          {paidBy === "us" ? `The bill goes down by the offer, so it matches what ${o.platformName} pays us.` : `The bill stays at full price: ${o.platformName} pays us the offer. It is only noted on the order.`}
        </p>
        <div className="flex h-14 items-center justify-end rounded-xl border bg-muted/40 px-4 font-heading text-3xl font-semibold tabular-nums">
          <span className="mr-auto text-sm font-medium text-muted-foreground">{currency}</span>{value || "0"}
        </div>
        <Numpad value={value} onChange={setValue} onEnter={() => { if (!busy && amount > 0) void save(amount); }} />
        <DialogFooter>
          {(o.platformFunded > 0 || o.discountSource === "platform") && (
            <Button variant="outline" className="mr-auto h-12 text-danger" disabled={busy} onClick={async () => {
              setBusy(true);
              if (o.discountSource === "platform") await apply(`/orders/${o.id}/platform-offer`, { amount: 0, paidBy: "us" });
              const r = o.platformFunded > 0 ? await apply(`/orders/${o.id}/platform-offer`, { amount: 0, paidBy: "platform" }) : true;
              setBusy(false);
              if (r) onClose();
            }}><XIcon /> Remove offer</Button>
          )}
          <Button variant="outline" className="h-12" onClick={onClose}>Cancel</Button>
          <Button className="h-12 min-w-36" disabled={busy || !(amount > 0)} onClick={() => void save(amount)}>Save offer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
