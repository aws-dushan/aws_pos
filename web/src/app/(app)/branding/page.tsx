"use client";

import { useMemo, useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, ImagePlusIcon, Loader2Icon, MonitorIcon, PrinterIcon, ReceiptTextIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { toast } from "sonner";
import { api, apiUpload, newKey, shrinkImage, useApi } from "@/lib/api";
import { printReceipt } from "@/lib/device";
import { withBase } from "@/lib/base-path";
import { cn } from "@/lib/utils";
import { openCustomerDisplay } from "@/lib/customer-display";
import type { OrderDetail } from "@/lib/pos";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { confirmDialog } from "@/components/confirm";
import { ErrorNote, Field, LoadingRows, PageHeader, Segmented, Switch } from "@/components/kit";
import { PrintedLines } from "@/components/printed-lines";
import { useReceiptQr } from "@/lib/qr";
import { receiptLines, type HeaderKey, type Receipt, type ReceiptSettings } from "@/components/pos-payment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type ReceiptConfig = { language: "en" | "bilingual"; header: string | null; footer: string | null; email: string | null; website: string | null; settings: ReceiptSettings; logoAt: string | null; tradingName: string };
type CompanyInfo = { id: string; legalName: string; legalNameAr: string | null; trn: string | null; baseCurrency: string; vatRate: number };
type BranchInfo = { id: string; code: string; name: string; nameAr: string | null; address: string | null; addressAr: string | null; phone: string | null; factsDocPrefix: string | null };
type Picture = { id: string; companyId: string; branchId: string | null; branchCode: string | null; caption: string | null; seconds: number; sort: number; isActive: boolean; startsOn: string | null; endsOn: string | null; createdAt: string };

/** The header lines a receipt can show, in the words of the settings screen. */
const HEADER_LINES: Record<HeaderKey, { label: string; hint?: string }> = {
  logo: { label: "Logo" },
  name: { label: "Name" },
  nameAr: { label: "Name in Arabic", hint: "Bilingual receipts" },
  branch: { label: "Branch name" },
  branchAr: { label: "Branch name in Arabic", hint: "Bilingual receipts" },
  address: { label: "Address" },
  phone: { label: "Phone" },
  email: { label: "Email" },
  website: { label: "Website" },
  trn: { label: "TRN", hint: "Tax invoices and credit notes always show it (UAE VAT); off hides it on bills only." },
};
const DETAILS: { key: "table" | "customer" | "cashier"; label: string }[] = [
  { key: "table", label: "Table" }, { key: "customer", label: "Customer name" }, { key: "cashier", label: "Till and cashier" },
];

/** Receipt & display: the company logo, what this branch's receipts show (live preview), and the customer display's pictures. */
export default function BrandingPage() {
  const { company, branch } = useSession();
  const [tab, setTab] = useState<"receipt" | "display">("receipt");
  return (
    <div className="pb-8">
      <PageHeader title="Receipt & display" icon={ReceiptTextIcon} module="admin"
        description={`The logo and receipt for ${branch?.name ?? "this branch"} of ${company?.name ?? "the company"}, and the pictures on its customer display.`}
        actions={<Segmented id="brand-tab" value={tab} onChange={setTab} options={[{ value: "receipt", label: "Receipt", icon: ReceiptTextIcon }, { value: "display", label: "Customer display", icon: MonitorIcon }]} />} />
      {tab === "receipt" ? <ReceiptSetup /> : <DisplayPictures />}
    </div>
  );
}

function ReceiptSetup() {
  const { company, branch } = useSession();
  const cfg = useApi<ReceiptConfig>(branch ? `/branches/${branch.id}/receipt` : null);
  const companies = useApi<CompanyInfo[]>("/companies");
  const branches = useApi<BranchInfo[]>(company ? `/companies/${company.id}/branches` : null);
  useLiveEvent(["branding.changed"], () => cfg.reload());
  const [f, setF] = useState<ReceiptConfig | null>(null);
  const [seen, setSeen] = useState<ReceiptConfig | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  if (cfg.data !== seen) { setSeen(cfg.data); if (cfg.data) setF({ ...cfg.data, settings: { ...cfg.data.settings, order: [...cfg.data.settings.order], show: { ...cfg.data.settings.show } } }); }
  const co = companies.data?.find((c) => c.id === company?.id);
  const br = branches.data?.find((b) => b.id === branch?.id);

  // The preview: a sample sale with this branch's details and the settings as they are now on screen.
  // A sample QR for the preview (the real one links to each receipt).
  const qrSample = useReceiptQr(f?.settings.show.qr ? "preview-sample-receipt" : null);
  const preview = useMemo(() => {
    if (!f || !co || !br || !company) return null;
    const now = new Date().toISOString();
    const r: Receipt = {
      legalName: co.legalName, legalNameAr: co.legalNameAr, trn: co.trn, currency: co.baseCurrency, branch: br.name, branchCode: br.code, branchAr: br.nameAr,
      address: br.address, addressAr: br.addressAr, phone: br.phone, receiptHeader: f.header, receiptFooter: f.footer, language: f.language,
      email: f.email, website: f.website, settings: f.settings, logoAt: f.logoAt, companyId: company.id, tradingName: f.tradingName,
      detail: {
        order: {
          id: "x", number: 195, invoiceNo: `INV-${br.code}-000123`, orderType: "takeaway", tableLabel: null, customerName: "Layla", customerPhone: "050 123 4567",
          registerName: "Till 1", openedByName: "Sara Ahmed", openedAt: now, closedAt: now,
          subtotal: 36.5, discountTotal: 3.65, discountPct: 10, serviceCharge: 0, servicePct: 0, vat: 1.56, vatRate: co.vatRate, pricesIncludeVat: true, total: 32.85,
        },
        lines: [
          { id: "1", name: "Cafe Latte", nameAr: "كافيه لاتيه", qty: 2, lineTotal: 30, modifiers: [{ name: "Regular", price: 0 }], note: null, isVoid: false },
          { id: "2", name: "Triple Chocolate Cookies 70gm", nameAr: "كوكيز الشوكولاتة الثلاثية ٧٠ غم", qty: 1, lineTotal: 6.5, modifiers: [], note: null, isVoid: false },
        ],
        payments: [{ id: "p", kind: "payment", method: "cash", amount: 32.85, tendered: 50, changeGiven: 17.15 }],
        creditNotes: [], tickets: [],
      } as unknown as OrderDetail,
    };
    return receiptLines(r, f.settings.show.qr ? qrSample : null);
  }, [f, co, br, company, qrSample]);

  // The sample on this PC's receipt printer, to see the settings on paper before saving them.
  async function printSample() {
    if (!preview) return;
    try { await printReceipt(newKey(), preview, false); toast.success("Sample sent to the receipt printer."); }
    catch (e) { toast.error((e as Error).message); }
  }

  async function save() {
    if (!f || !branch) return;
    setBusy(true);
    try { await api(`/branches/${branch.id}/receipt`, "PUT", f); toast.success("Receipt saved"); cfg.reload(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  async function uploadLogo(file: File) {
    if (!company) return;
    try {
      // PNG keeps a transparent background; large photos are shrunk first.
      const blob = file.size > 1_500_000 ? await shrinkImage(file, 1000) : file;
      await apiUpload(`/companies/${company.id}/logo`, blob, file.name);
      toast.success("Logo saved"); cfg.reload();
    } catch (e) { toast.error((e as Error).message); }
  }
  async function removeLogo() {
    if (!company || !(await confirmDialog({ title: "Remove the logo?", message: "Receipts show the company name instead.", confirmLabel: "Remove", tone: "danger" }))) return;
    try { await api(`/companies/${company.id}/logo`, "DELETE"); cfg.reload(); } catch (e) { toast.error((e as Error).message); }
  }

  if (cfg.error) return <ErrorNote message={cfg.error} />;
  if (!f) return <LoadingRows rows={5} />;
  const set = <K extends keyof ReceiptConfig>(k: K, v: ReceiptConfig[K]) => setF({ ...f, [k]: v });
  const setS = (patch: Partial<ReceiptSettings>) => setF({ ...f, settings: { ...f.settings, ...patch } });
  const move = (i: number, dir: -1 | 1) => {
    const order = [...f.settings.order];
    [order[i], order[i + dir]] = [order[i + dir], order[i]];
    setS({ order });
  };
  // What a tax invoice needs (UAE VAT): the supplier's name (or a logo showing it) and address; the TRN always prints.
  const missing = [
    ...(!(f.settings.show.name && f.settings.nameSource !== "none") && !(f.settings.show.logo && f.logoAt) ? ["name"] : []),
    ...(!f.settings.show.address ? ["address"] : []),
  ];

  return (
    <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_280px] lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-5">
        <section className="surface p-5" data-module="admin">
          <h2 className="mb-1 font-heading font-semibold">Company logo</h2>
          <p className="mb-4 text-sm text-muted-foreground">Printed at the top of receipts and credit notes in black and white. A wide logo on a white or transparent background prints best.</p>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex h-24 w-56 items-center justify-center overflow-hidden rounded-xl border bg-white">
              {/* eslint-disable-next-line @next/next/no-img-element -- the company's own logo, same origin */}
              {f.logoAt ? <img src={withBase(`/api/companies/${company!.id}/logo?v=${encodeURIComponent(f.logoAt)}`)} alt="Logo" className="max-h-20 max-w-52 object-contain" />
                : <span className="text-sm text-muted-foreground">No logo</span>}
            </div>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const x = e.target.files?.[0]; e.target.value = ""; if (x) void uploadLogo(x); }} />
            <Button variant="outline" className="h-11" onClick={() => fileRef.current?.click()}><UploadIcon /> {f.logoAt ? "Replace" : "Upload logo"}</Button>
            {f.logoAt && <Button variant="ghost" className="h-11 text-danger" onClick={() => void removeLogo()}><Trash2Icon /> Remove</Button>}
          </div>
        </section>

        <section className="surface p-5" data-module="admin">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-heading font-semibold">Receipt at {branch?.name}</h2>
            <Segmented id="rcpt-lang" value={f.language} onChange={(v) => set("language", v)} options={[{ value: "bilingual", label: "English and Arabic" }, { value: "en", label: "English only" }]} />
          </div>
          {/* Which name prints at the top. */}
          <Field label="Name on the receipt">
            <Segmented id="rcpt-name" value={f.settings.nameSource} onChange={(v) => setS({ nameSource: v })} className="w-full"
              options={[{ value: "legal", label: "Legal name" }, { value: "trading", label: "Trading name" }, { value: "custom", label: "Own text" }, { value: "none", label: "None" }]} />
          </Field>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {f.settings.nameSource === "legal" ? `“${co?.legalName ?? ""}”, as on the trade licence.` : f.settings.nameSource === "trading" ? `“${f.tradingName}”, the company's name in One POS.`
              : f.settings.nameSource === "none" ? "No name line, e.g. when the logo already shows the name." : "Type the name to print, in English and Arabic."}
          </p>
          {f.settings.nameSource === "custom" && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Input value={f.settings.customName ?? ""} onChange={(e) => setS({ customName: e.target.value })} placeholder="Name in English" className="h-11" />
              <Input dir="rtl" value={f.settings.customNameAr ?? ""} onChange={(e) => setS({ customNameAr: e.target.value })} placeholder="الاسم بالعربية" className="h-11" />
            </div>
          )}

          {/* The header lines: on or off, and their order. */}
          <div className="mt-5 mb-2 text-[0.8rem] font-medium text-foreground/80">Header, top to bottom</div>
          <div className="divide-y rounded-xl border">
            {f.settings.order.map((k, i) => (
              <div key={k} className={cn("flex items-center gap-3 px-3 py-2", !f.settings.show[k] && "text-muted-foreground")}>
                <div className="flex">
                  <Button variant="ghost" size="icon" className="size-9" aria-label={`Move ${HEADER_LINES[k].label} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUpIcon /></Button>
                  <Button variant="ghost" size="icon" className="size-9" aria-label={`Move ${HEADER_LINES[k].label} down`} disabled={i === f.settings.order.length - 1} onClick={() => move(i, 1)}><ArrowDownIcon /></Button>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{HEADER_LINES[k].label}</div>
                  {HEADER_LINES[k].hint && <div className="text-xs text-muted-foreground">{HEADER_LINES[k].hint}</div>}
                </div>
                <Switch on={f.settings.show[k]} onChange={(v) => setS({ show: { ...f.settings.show, [k]: v } })} label={HEADER_LINES[k].label} />
              </div>
            ))}
          </div>
          {missing.length > 0 && (
            <p className="mt-2 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
              A UAE tax invoice must show the supplier&apos;s {missing.join(" and ")}. Receipts can print without it, but check with your accountant.
            </p>
          )}

          <div className="mt-5 mb-2 text-[0.8rem] font-medium text-foreground/80">Order details</div>
          <div className="grid gap-2 sm:grid-cols-3">
            {DETAILS.map((d) => (
              <div key={d.key} className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5">
                <span className="text-sm font-medium">{d.label}</span>
                <Switch on={f.settings.show[d.key]} onChange={(v) => setS({ show: { ...f.settings.show, [d.key]: v } })} label={d.label} />
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-start justify-between gap-3 rounded-xl border px-3 py-2.5">
            <span className="text-sm"><span className="font-medium">QR code to the digital receipt</span>
              <span className="block text-xs text-muted-foreground">Printed at the bottom of paid receipts. The customer scans it to keep the receipt on their phone; no sign-in, payment references left out.</span></span>
            <Switch on={!!f.settings.show.qr} onChange={(v) => setS({ show: { ...f.settings.show, qr: v } })} label="QR code to the digital receipt" />
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <Field label="Email (company)"><Input value={f.email ?? ""} onChange={(e) => set("email", e.target.value)} inputMode="email" className="h-11" /></Field>
            <Field label="Website (company)"><Input value={f.website ?? ""} onChange={(e) => set("website", e.target.value)} className="h-11" /></Field>
            <Field label="Extra header lines" hint="Under the title, e.g. an offer or opening hours."><Textarea rows={3} value={f.header ?? ""} onChange={(e) => set("header", e.target.value)} /></Field>
            <Field label="Footer" hint="e.g. Thank you · شكراً لزيارتكم"><Textarea rows={3} value={f.footer ?? ""} onChange={(e) => set("footer", e.target.value)} /></Field>
          </div>
          <div className="mt-5 flex justify-end"><Button className="h-11 min-w-32" disabled={busy} onClick={() => void save()}>{busy && <Loader2Icon className="animate-spin" />} Save</Button></div>
        </section>
      </div>

      <aside className="md:sticky md:top-20 md:self-start">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">Preview · a sample sale</span>
          <Button variant="outline" size="sm" disabled={!preview} onClick={() => void printSample()}><PrinterIcon /> Print sample</Button>
        </div>
        {preview ? <PrintedLines lines={preview} className="max-h-[calc(100dvh-9rem)] shadow-soft" /> : <div className="h-96 rounded-xl skeleton-shimmer" />}
      </aside>
    </div>
  );
}

function DisplayPictures() {
  const list = useApi<Picture[]>("/display/images?all=true");
  useLiveEvent(["branding.changed"], () => list.reload());
  const [uploading, setUploading] = useState(false);
  const [scope, setScope] = useState<"all" | "branch">("all");
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload(files: FileList) {
    setUploading(true);
    try {
      for (const file of Array.from(files)) await apiUpload(`/display/images?allBranches=${scope === "all"}`, await shrinkImage(file, 1920), file.name);
      toast.success(files.length === 1 ? "Picture added" : `${files.length} pictures added`); list.reload();
    } catch (e) { toast.error((e as Error).message); } finally { setUploading(false); }
  }
  async function change(p: Picture, patch: Partial<Picture> & { allBranches?: boolean }) {
    try {
      await api(`/display/images/${p.id}`, "PUT", { caption: p.caption, seconds: p.seconds, sort: p.sort, isActive: p.isActive, startsOn: p.startsOn, endsOn: p.endsOn, ...patch });
      list.reload();
    } catch (e) { toast.error((e as Error).message); }
  }
  async function move(i: number, dir: -1 | 1) {
    const rows = list.data!, other = rows[i + dir];
    if (!other) return;
    await change(rows[i], { sort: other.sort });
    await change(other, { sort: rows[i].sort });
  }
  async function remove(p: Picture) {
    if (!(await confirmDialog({ title: "Remove this picture?", confirmLabel: "Remove", tone: "danger" }))) return;
    try { await api(`/display/images/${p.id}`, "DELETE"); list.reload(); } catch (e) { toast.error((e as Error).message); }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => { const x = e.target.files; if (x?.length) void upload(x); e.target.value = ""; }} />
        <Button className="h-11" disabled={uploading} onClick={() => fileRef.current?.click()}>{uploading ? <Loader2Icon className="animate-spin" /> : <ImagePlusIcon />} Add pictures</Button>
        <Segmented id="pic-scope" value={scope} onChange={setScope} options={[{ value: "all", label: "For every branch" }, { value: "branch", label: "For this branch only" }]} />
        <Button variant="outline" className="h-11 ml-auto" onClick={() => void openCustomerDisplay(withBase("/display"))}><MonitorIcon /> Open the customer display</Button>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">Shown full screen on the customer display between orders, one after another. Landscape pictures (16:9, e.g. 1920 × 1080) fill it best.</p>
      <ErrorNote message={list.error} />
      {!list.data ? <LoadingRows rows={3} /> : list.data.length ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {list.data.map((p, i) => (
            <div key={p.id} className={cn("surface overflow-hidden", !p.isActive && "opacity-60")}>
              {/* eslint-disable-next-line @next/next/no-img-element -- the company's own pictures, same origin */}
              <img src={withBase(`/api/display/images/${p.companyId}/${p.id}?v=${p.createdAt}`)} alt={p.caption ?? ""} className="aspect-video w-full bg-black object-contain" />
              <div className="space-y-3 p-4">
                <Input defaultValue={p.caption ?? ""} placeholder="Caption (optional)" className="h-10" onBlur={(e) => e.target.value !== (p.caption ?? "") && void change(p, { caption: e.target.value })} />
                <div className="grid grid-cols-3 gap-2">
                  <label className="grid gap-1 text-xs text-muted-foreground">Seconds
                    <Input type="number" min={3} max={120} defaultValue={p.seconds} className="h-10" onBlur={(e) => Number(e.target.value) !== p.seconds && void change(p, { seconds: Number(e.target.value) })} />
                  </label>
                  <label className="grid gap-1 text-xs text-muted-foreground">From
                    <Input type="date" defaultValue={p.startsOn ?? ""} className="h-10" onBlur={(e) => (e.target.value || null) !== p.startsOn && void change(p, { startsOn: e.target.value || null })} />
                  </label>
                  <label className="grid gap-1 text-xs text-muted-foreground">Until
                    <Input type="date" defaultValue={p.endsOn ?? ""} className="h-10" onBlur={(e) => (e.target.value || null) !== p.endsOn && void change(p, { endsOn: e.target.value || null })} />
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch on={p.isActive} onChange={(v) => void change(p, { isActive: v })} label="Shown" />
                  <span className="text-sm">{p.isActive ? "Shown" : "Hidden"}</span>
                  <span className="text-xs text-muted-foreground">· {p.branchCode ? `${p.branchCode} only` : "every branch"}</span>
                  <div className="ml-auto flex">
                    <Button variant="ghost" size="icon" aria-label="Earlier" disabled={i === 0} onClick={() => void move(i, -1)}><ArrowUpIcon /></Button>
                    <Button variant="ghost" size="icon" aria-label="Later" disabled={i === list.data!.length - 1} onClick={() => void move(i, 1)}><ArrowDownIcon /></Button>
                    <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => void remove(p)}><Trash2Icon /></Button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="surface flex flex-col items-center gap-3 px-6 py-12 text-center">
          <MonitorIcon className="size-8 text-muted-foreground" />
          <div className="font-medium">No pictures yet</div>
          <p className="max-w-md text-sm text-muted-foreground">Between orders the customer display shows the One POS welcome screen. Add pictures (offers, new items) to show them instead.</p>
        </div>
      )}
    </div>
  );
}
