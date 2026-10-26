"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ErpConnectionDialog } from "@/components/erp-connection";
import { ArmchairIcon, Building2Icon, ChefHatIcon, CoffeeIcon, DatabaseIcon, WarehouseIcon, PencilIcon, PercentIcon, PlusIcon, ShoppingBagIcon, StoreIcon, MegaphoneIcon, Trash2Icon, ClipboardListIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { EmptyState, ErrorNote, Field, LoadingRows, ObjectStatus, PageHeader, Pill, Segmented, Switch, TablePanel, TONE } from "@/components/kit";
import { Stagger, StaggerItem } from "@/components/motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Erp = "none" | "awsone" | "facts";
type Company = { id: string; code: string; name: string; legalName: string; legalNameAr: string | null; trn: string | null; baseCurrency: string; vatRate: number; pricesIncludeVat: boolean; erpConnector: Erp; isActive: boolean; branches: number; users: number;
  vouchersEnabled: boolean; loyaltyEnabled: boolean; loyaltyPointsPerUnit: number; loyaltyPointValue: number; loyaltyMinRedeem: number };
type DayControl = "manual" | "automatic" | "cashier";
type Branch = {
  id: string; companyId: string; code: string; name: string; address: string | null; phone: string | null; timeZone: string; tableService: boolean; askGuests: boolean;
  serviceChargePct: number; receiptHeader: string | null; receiptFooter: string | null; dayControl: DayControl; isActive: boolean; returnDays: number;
  kitchenEnabled: boolean; autoOpenTime: string; autoCloseTime: string; varianceTolerance: number; defaultFloat: number; openOrdersAtClose: "carry" | "void_unsent";
  erpLocationCode: string | null; erpLocationName: string | null; factsDocPrefix: string | null; erpWasteLocation: string | null; factsPriceType: string | null; factsPricesIncludeVat: boolean; returnsEnabled: boolean;
  nameAr: string | null; addressAr: string | null; receiptLanguage: "en" | "bilingual"; shortStock: "allow" | "warn" | "block";
  pickupMode: "off" | "auto" | "cashier"; pickupMinutes: number; closeDelayMinutes: number; closeDelayMaxMinutes: number;
  wastageApproverId: string | null; wastageApprovalEmail: string | null; wastageFactsUser: string | null;
  marketingApproverId: string | null; marketingApprovalEmail: string | null; marketingFactsUser: string | null; marketingAccount: string | null;
  requestApproverId: string | null; requestApprovalEmail: string | null; requestFactsUser: string | null;
  discountApprovalEmails: string[] | null;
};

const ERP_LABEL: Record<Erp, string> = { none: "Standalone", awsone: "AWS One", facts: "FACTS" };
type FactsItems = { itemType: string; itemMaster: string | null; division: string | null };
const DAY_LABEL: Record<DayControl, string> = { manual: "Manual", automatic: "Automatic", cashier: "Cashier-run" };

/** Companies (administrators) and their branches (REQ ORG-01 … ORG-03): ERP connection, tax, table service, day control. */
export default function CompaniesPage() {
  const { me, refresh } = useSession();
  const companies = useApi<Company[]>("/companies");
  const [editCompany, setEditCompany] = useState<Company | "new" | null>(null);
  const [editBranch, setEditBranch] = useState<{ company: Company; branch: Branch | null } | null>(null);
  const [erpFor, setErpFor] = useState<Company | null>(null);
  const [version, setVersion] = useState(0);
  useLiveEvent(["branches.changed"], () => { companies.reload(); setVersion((v) => v + 1); });

  const saved = () => { companies.reload(); setVersion((v) => v + 1); void refresh(); };

  return (
    <div>
      <PageHeader title="Companies & branches" icon={Building2Icon} module="admin" count={companies.data?.length}
        description="Each company has its own tax, menu, roles and ERP; each branch decides table service and day control."
        actions={me.user.isAdmin && <Button size="lg" onClick={() => setEditCompany("new")}><PlusIcon /> New company</Button>} />
      <ErrorNote message={companies.error} />
      {companies.loading && !companies.data ? <LoadingRows rows={4} /> : companies.data?.length ? (
        <Stagger className="space-y-5">
          {companies.data.map((c) => (
            <StaggerItem key={c.id}>
              <CompanyCard company={c} version={version} canEdit={me.user.isAdmin}
                onEdit={() => setEditCompany(c)} onErp={() => setErpFor(c)} onAddBranch={() => setEditBranch({ company: c, branch: null })}
                onEditBranch={(b) => setEditBranch({ company: c, branch: b })} />
            </StaggerItem>
          ))}
        </Stagger>
      ) : (
        <EmptyState icon={Building2Icon} title="No companies yet" module="admin"
          action={me.user.isAdmin && <Button size="lg" onClick={() => setEditCompany("new")}><PlusIcon /> New company</Button>}>
          Start with the legal entity: its name, VAT number and whether it posts to AWS One or FACTS.
        </EmptyState>
      )}
      <CompanyDialog value={editCompany} onClose={() => setEditCompany(null)} onSaved={saved} />
      <ErpConnectionDialog company={erpFor} onClose={() => setErpFor(null)} />
      <BranchDialog value={editBranch} onClose={() => setEditBranch(null)} onSaved={saved} isAdmin={me.user.isAdmin} />
    </div>
  );
}

function CompanyCard({ company: c, version, canEdit, onEdit, onErp, onAddBranch, onEditBranch }: {
  company: Company; version: number; canEdit: boolean; onEdit: () => void; onErp: () => void; onAddBranch: () => void; onEditBranch: (b: Branch) => void;
}) {
  const branches = useApi<Branch[]>(`/companies/${c.id}/branches?v=${version}`);
  return (
    <section className="surface overflow-hidden" data-module="admin">
      <div className="flex flex-wrap items-center gap-3 border-b px-5 py-4">
        <span className="flex size-10 items-center justify-center rounded-xl bg-ink font-heading text-xs font-semibold text-background">{c.code.slice(0, 3)}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-heading text-base font-semibold">{c.name}</h2>
            <span className="font-mono text-xs text-muted-foreground">{c.code}</span>
            {!c.isActive && <ObjectStatus className={TONE.muted}>Inactive</ObjectStatus>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>{c.legalName}</span>
            {c.trn && <span>· TRN {c.trn}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill className={c.erpConnector === "none" ? undefined : c.erpConnector === "facts" ? TONE.warn : TONE.violet} dot>ERP: {ERP_LABEL[c.erpConnector]}</Pill>
          <Pill>{c.baseCurrency} · VAT {c.vatRate}% {c.pricesIncludeVat ? "incl." : "excl."}</Pill>
          <Pill>{c.users} user{c.users === 1 ? "" : "s"}</Pill>
        </div>
        {canEdit && c.erpConnector === "facts" && <Button variant="outline" onClick={onErp}><DatabaseIcon /> FACTS connection</Button>}
        {canEdit && <Button variant="outline" onClick={onEdit}><PencilIcon /> Edit</Button>}
      </div>
      {branches.loading && !branches.data ? (
        <div className="p-5 text-sm text-muted-foreground">Loading branches…</div>
      ) : branches.data?.length ? (
        <TablePanel className="rounded-none border-0 shadow-none">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Branch</TableHead>
                <TableHead>Service</TableHead>
                <TableHead>Day control</TableHead>
                <TableHead className="text-right">Service charge</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {branches.data.map((b) => (
                <TableRow key={b.id} className="cursor-pointer" onClick={() => onEditBranch(b)}>
                  <TableCell className="pl-5">
                    <div className="font-medium">{b.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">{b.code}{b.address ? ` · ${b.address}` : ""}</div>
                  </TableCell>
                  <TableCell>
                    {b.tableService
                      ? <ObjectStatus className={TONE.done} icon={ArmchairIcon}>Table service</ObjectStatus>
                      : <ObjectStatus className={TONE.info} icon={ShoppingBagIcon}>Quick service</ObjectStatus>}
                  </TableCell>
                  <TableCell>{DAY_LABEL[b.dayControl]}</TableCell>
                  <TableCell className="text-right tabular-nums">{b.tableService && b.serviceChargePct > 0 ? `${b.serviceChargePct}%` : "—"}</TableCell>
                  <TableCell>{b.isActive ? <ObjectStatus className={TONE.done}>Open</ObjectStatus> : <ObjectStatus className={TONE.muted}>Closed</ObjectStatus>}</TableCell>
                  <TableCell><PencilIcon className="size-3.5 text-muted-foreground" /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TablePanel>
      ) : (
        <p className="px-5 py-6 text-sm text-muted-foreground">No branches yet.</p>
      )}
      {canEdit && (
        <div className="border-t bg-muted/30 px-5 py-2.5">
          <Button variant="ghost" onClick={onAddBranch}><PlusIcon /> Add branch</Button>
        </div>
      )}
    </section>
  );
}

function CompanyDialog({ value, onClose, onSaved }: { value: Company | "new" | null; onClose: () => void; onSaved: () => void }) {
  const isNew = value === "new";
  const [f, setF] = useState({ code: "", name: "", legalName: "", legalNameAr: "", trn: "", baseCurrency: "AED", vatRate: "5", pricesIncludeVat: true, erpConnector: "none" as Erp, isActive: true });
  const [rw, setRw] = useState({ vouchersEnabled: false, loyaltyEnabled: false, pointsPerUnit: "1", pointValue: "0.05", minRedeem: "100" });
  const [seen, setSeen] = useState<typeof value>(null);
  const [busy, setBusy] = useState(false);
  if (value !== seen) {
    setSeen(value);
    if (value && value !== "new") setRw({ vouchersEnabled: value.vouchersEnabled, loyaltyEnabled: value.loyaltyEnabled, pointsPerUnit: String(value.loyaltyPointsPerUnit), pointValue: String(value.loyaltyPointValue), minRedeem: String(value.loyaltyMinRedeem) });
    if (value && value !== "new") setF({ code: value.code, name: value.name, legalName: value.legalName, legalNameAr: value.legalNameAr ?? "", trn: value.trn ?? "", baseCurrency: value.baseCurrency, vatRate: String(value.vatRate), pricesIncludeVat: value.pricesIncludeVat, erpConnector: value.erpConnector, isActive: value.isActive });
    else if (value === "new") setF({ code: "", name: "", legalName: "", legalNameAr: "", trn: "", baseCurrency: "AED", vatRate: "5", pricesIncludeVat: true, erpConnector: "none", isActive: true });
  }
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { ...f, vatRate: Number(f.vatRate) };
      if (isNew) await api("/companies", "POST", body);
      else if (value) {
        await api(`/companies/${value.id}`, "PUT", body);
        // Vouchers and loyalty: administrators only, saved on their own.
        if (rw.vouchersEnabled !== value.vouchersEnabled || rw.loyaltyEnabled !== value.loyaltyEnabled || Number(rw.pointsPerUnit) !== value.loyaltyPointsPerUnit
          || Number(rw.pointValue) !== value.loyaltyPointValue || Number(rw.minRedeem) !== value.loyaltyMinRedeem)
          await api(`/companies/${value.id}/rewards`, "PUT", { vouchersEnabled: rw.vouchersEnabled, loyaltyEnabled: rw.loyaltyEnabled,
            pointsPerUnit: Number(rw.pointsPerUnit), pointValue: Number(rw.pointValue), minRedeem: Number(rw.minRedeem) });
      }
      toast.success(isNew ? `${f.name} created with its starting roles.` : "Company saved.");
      onSaved();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!value} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-xl">
        <form onSubmit={save} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{isNew ? "New company" : `Edit ${f.name}`}</DialogTitle>
            <DialogDescription>The legal entity: tax, currency and which ERP it posts to.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            {!isNew && <Field label="Code" hint="Made from the name when the company was added; can't change."><Input value={f.code} disabled /></Field>}
            <Field label="Name" required><Input value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
            <Field label="Legal name" span><Input value={f.legalName} onChange={(e) => set("legalName", e.target.value)} placeholder="As on the trade licence" /></Field>
            <Field label="Legal name in Arabic" span hint="Printed under the English name on bilingual tax invoices.">
              <Input dir="rtl" value={f.legalNameAr} onChange={(e) => set("legalNameAr", e.target.value)} placeholder="كما في الرخصة التجارية" />
            </Field>
            <Field label="VAT registration number (TRN)"><Input value={f.trn} onChange={(e) => set("trn", e.target.value)} inputMode="numeric" /></Field>
            <Field label="Currency">
              <select className="h-8 w-full rounded-lg border border-input bg-card px-2.5 text-sm dark:bg-input/30" value={f.baseCurrency} onChange={(e) => set("baseCurrency", e.target.value)}>
                {["AED", "SAR", "QAR", "OMR", "BHD", "KWD", "USD"].map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="VAT rate (%)"><Input value={f.vatRate} onChange={(e) => set("vatRate", e.target.value)} inputMode="decimal" /></Field>
            {/* Labelled and sized like the VAT rate field beside it, so the two line up. */}
            <Field label="Menu prices">
              <div className="flex h-8 items-center justify-between gap-3 rounded-lg border border-input bg-card pr-1.5 pl-2.5 dark:bg-input/30">
                <span className="text-sm">Include VAT</span>
                <Switch on={f.pricesIncludeVat} onChange={(v) => set("pricesIncludeVat", v)} label="Menu prices include VAT" />
              </div>
            </Field>
          </div>
          <div className="space-y-2">
            <span className="block text-[0.8rem] font-medium text-foreground/80">ERP connection</span>
            <Segmented id="erp" value={f.erpConnector} onChange={(v) => set("erpConnector", v)} className="w-full"
              options={[{ value: "none", label: "Standalone" }, { value: "awsone", label: "AWS One" }, { value: "facts", label: "FACTS" }]} />
            <p className="text-xs text-muted-foreground">
              {f.erpConnector === "none" ? "One POS keeps its own menu and stock; nothing is posted to an ERP."
                : f.erpConnector === "awsone" ? "Items and stock come from AWS One; sales, payments and returns post back to it (phase 3)."
                  : "Items come from the FACTS item master and stock from the branch's FACTS location; returns post as STV documents (phase 3)."}
            </p>
          </div>
          {!isNew && (
            <div className="space-y-3 rounded-2xl border p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium">Gift vouchers</div>
                  <p className="text-xs text-muted-foreground">Managers issue vouchers with a code; tills take them as payment and can refund to a new voucher (store credit).</p>
                </div>
                <Switch on={rw.vouchersEnabled} onChange={(v) => setRw((x) => ({ ...x, vouchersEnabled: v }))} label="Gift vouchers" />
              </div>
              <div className="flex items-start justify-between gap-3 border-t pt-3">
                <div>
                  <div className="font-medium">Loyalty points</div>
                  <p className="text-xs text-muted-foreground">A customer on a paid order earns points; points can pay (part of) a later bill.</p>
                </div>
                <Switch on={rw.loyaltyEnabled} onChange={(v) => setRw((x) => ({ ...x, loyaltyEnabled: v }))} label="Loyalty points" />
              </div>
              {rw.loyaltyEnabled && (
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label={`Points per ${f.baseCurrency} 1`}><Input value={rw.pointsPerUnit} onChange={(e) => setRw((x) => ({ ...x, pointsPerUnit: e.target.value }))} inputMode="decimal" /></Field>
                  <Field label={`1 point is worth (${f.baseCurrency})`}><Input value={rw.pointValue} onChange={(e) => setRw((x) => ({ ...x, pointValue: e.target.value }))} inputMode="decimal" /></Field>
                  <Field label="Usable from (points)"><Input value={rw.minRedeem} onChange={(e) => setRw((x) => ({ ...x, minRedeem: e.target.value }))} inputMode="numeric" /></Field>
                  <p className="text-xs text-muted-foreground sm:col-span-3">
                    Spending {f.baseCurrency} 100 earns {Math.floor(100 * Number(rw.pointsPerUnit || 0))} points, worth {f.baseCurrency} {(Math.floor(100 * Number(rw.pointsPerUnit || 0)) * Number(rw.pointValue || 0)).toFixed(2)} back
                    ({(Number(rw.pointsPerUnit || 0) * Number(rw.pointValue || 0) * 100).toFixed(1)}% of spend).
                  </p>
                </div>
              )}
            </div>
          )}
          {value && value !== "new" && value.erpConnector === "facts" && <RequestStoresBox company={value} />}
          {!isNew && (
            <div className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5">
              <span className="text-sm">Active <span className="text-muted-foreground">· an inactive company’s tills can’t sign in</span></span>
              <Switch on={f.isActive} onChange={(v) => set("isActive", v)} label="Active" />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>{isNew ? "Create company" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const TIME_ZONES = ["Asia/Dubai", "Asia/Riyadh", "Asia/Qatar", "Asia/Muscat", "Asia/Bahrain", "Asia/Kuwait"];

function BranchDialog({ value, onClose, onSaved, isAdmin }: {
  value: { company: Company; branch: Branch | null } | null; onClose: () => void; onSaved: () => void; isAdmin: boolean;
}) {
  const isNew = !!value && !value.branch;
  const blank = { code: "", name: "", address: "", phone: "", timeZone: "Asia/Dubai", tableService: true, askGuests: true, serviceChargePct: "0", receiptHeader: "", receiptFooter: "", dayControl: "manual" as DayControl, isActive: true, returnDays: "0",
    kitchenEnabled: true, autoOpenTime: "10:00", autoCloseTime: "03:00", varianceTolerance: "5", defaultFloat: "500", openOrdersAtClose: "carry" as Branch["openOrdersAtClose"], erpLocationCode: "", erpLocationName: "", factsDocPrefix: "", erpWasteLocation: "", factsPriceType: "", factsPricesIncludeVat: true, returnsEnabled: false, nameAr: "", addressAr: "", receiptLanguage: "bilingual" as Branch["receiptLanguage"], shortStock: "allow" as Branch["shortStock"], pickupMode: "off" as Branch["pickupMode"], pickupMinutes: "10", closeDelayMinutes: "15", closeDelayMaxMinutes: "120" };
  const [f, setF] = useState(blank);
  const [seen, setSeen] = useState<typeof value>(null);
  const [busy, setBusy] = useState(false);
  if (value !== seen) {
    setSeen(value);
    const b = value?.branch;
    setF(b ? { code: b.code, name: b.name, address: b.address ?? "", phone: b.phone ?? "", timeZone: b.timeZone, tableService: b.tableService, askGuests: b.askGuests,
      serviceChargePct: String(b.serviceChargePct), receiptHeader: b.receiptHeader ?? "", receiptFooter: b.receiptFooter ?? "", dayControl: b.dayControl, isActive: b.isActive, returnDays: String(b.returnDays),
      kitchenEnabled: b.kitchenEnabled, autoOpenTime: b.autoOpenTime.slice(0, 5), autoCloseTime: b.autoCloseTime.slice(0, 5), varianceTolerance: String(b.varianceTolerance),
      defaultFloat: String(b.defaultFloat), openOrdersAtClose: b.openOrdersAtClose, erpLocationCode: b.erpLocationCode ?? "", erpLocationName: b.erpLocationName ?? "", factsDocPrefix: b.factsDocPrefix ?? "", erpWasteLocation: b.erpWasteLocation ?? "", factsPriceType: b.factsPriceType ?? "", factsPricesIncludeVat: b.factsPricesIncludeVat, returnsEnabled: b.returnsEnabled,
      nameAr: b.nameAr ?? "", addressAr: b.addressAr ?? "", receiptLanguage: b.receiptLanguage, shortStock: b.shortStock, pickupMode: b.pickupMode, pickupMinutes: String(b.pickupMinutes),
      closeDelayMinutes: String(b.closeDelayMinutes ?? 15), closeDelayMaxMinutes: String(b.closeDelayMaxMinutes ?? 120) } : blank);
  }
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  // Items to take from FACTS: the company's (all its branches share one catalogue); administrators change it here.
  const factsCo = value?.company.erpConnector === "facts" ? value.company.id : null;
  const items = useApi<FactsItems>(factsCo && isAdmin ? `/companies/${factsCo}/erp/items` : null);
  const [it, setIt] = useState<{ for: FactsItems | undefined; v: { itemType: string; itemMaster: string; division: string } }>({ for: undefined, v: { itemType: "", itemMaster: "", division: "" } });
  if (items.data !== it.for) setIt({ for: items.data, v: { itemType: items.data?.itemType ?? "FG", itemMaster: items.data?.itemMaster ?? "", division: items.data?.division ?? "" } });
  const itemsChanged = !!items.data && (it.v.itemType !== items.data.itemType || it.v.itemMaster !== (items.data.itemMaster ?? "") || it.v.division !== (items.data.division ?? ""));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!value) return;
    setBusy(true);
    try {
      const body = { ...f, serviceChargePct: Number(f.serviceChargePct), returnDays: Number(f.returnDays || 0), varianceTolerance: Number(f.varianceTolerance || 0), defaultFloat: Number(f.defaultFloat || 0), pickupMinutes: Number(f.pickupMinutes || 10),
        closeDelayMinutes: Number(f.closeDelayMinutes || 15), closeDelayMaxMinutes: Number(f.closeDelayMaxMinutes || 0) };
      if (isNew) await api(`/companies/${value.company.id}/branches`, "POST", body);
      else await api(`/branches/${value.branch!.id}`, "PUT", body);
      if (itemsChanged) {
        const r = await api<{ synced: Record<string, number> | null }>(`/companies/${value.company.id}/erp/items`, "PUT", it.v);
        if (r.synced) toast.success(`FACTS items synced: ${r.synced.added} new, ${r.synced.removed} switched off.`);
      }
      toast.success(isNew ? `${f.name} added.` : "Branch saved.");
      onSaved();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!value} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={save} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{isNew ? `New branch · ${value?.company.name}` : `Edit ${f.name}`}</DialogTitle>
            <DialogDescription>A location that sells: how it serves, how its day opens and closes, what its receipts say.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            {!isNew && <Field label="Code" hint="Made when the branch was added (company code and number); can't change."><Input value={f.code} disabled /></Field>}
            <Field label="Name" required><Input value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
            <Field label="Address"><Input value={f.address} onChange={(e) => set("address", e.target.value)} /></Field>
            <Field label="Phone"><Input value={f.phone} onChange={(e) => set("phone", e.target.value)} inputMode="tel" /></Field>
            <Field label="Name in Arabic"><Input dir="rtl" value={f.nameAr} onChange={(e) => set("nameAr", e.target.value)} /></Field>
            <Field label="Address in Arabic"><Input dir="rtl" value={f.addressAr} onChange={(e) => set("addressAr", e.target.value)} /></Field>
            <Field label="Receipts" span>
              <Segmented id="receipt-lang" value={f.receiptLanguage} onChange={(v) => set("receiptLanguage", v)} className="w-full"
                options={[{ value: "bilingual", label: "English and Arabic" }, { value: "en", label: "English only" }]} />
            </Field>
            <Field label="When stock runs short (FACTS stock and recipe ingredients)" span
              hint={f.shortStock === "allow" ? "Sell anyway. Stock can go below zero; the register shows what's left and the Ingredients screen flags shortages."
                : f.shortStock === "warn" ? "Sell, but the cashier is warned when an item is added beyond the stock left (or its ingredients don't cover it)."
                  : "The register won't sell more of an item than its FACTS stock has left at the branch, or than its ingredients cover."}>
              <Segmented id="short-stock" value={f.shortStock} onChange={(v) => set("shortStock", v)} className="w-full"
                options={[{ value: "allow", label: "Allow" }, { value: "warn", label: "Warn" }, { value: "block", label: "Block" }]} />
            </Field>
            <Field label="Order-ready screen (TV by the counter)" span
              hint={f.pickupMode === "off" ? "No screen, nothing for anyone to tap."
                : f.pickupMode === "auto" ? (f.kitchenEnabled ? "No taps: an order shows as ready when the kitchen finishes it." : "No taps: the number shows as ready as soon as it's paid (made while the customer pays).")
                  : "One tap: waiting order numbers show on the register; the cashier taps one when it's ready."}>
              <Segmented id="pickup-mode" value={f.pickupMode} onChange={(v) => set("pickupMode", v)} className="w-full"
                options={[{ value: "off", label: "Off" }, { value: "auto", label: "Automatic" }, { value: "cashier", label: "Cashier taps ready" }]} />
            </Field>
            {f.pickupMode !== "off" && (
              <Field label="Ready numbers stay on screen (minutes)" hint="Then they leave by themselves; nobody marks them collected.">
                <Input value={f.pickupMinutes} inputMode="numeric" onChange={(e) => set("pickupMinutes", e.target.value)} />
              </Field>
            )}
          </div>

          {/* The branch's stock location in FACTS: stock is read from it, returns are posted (STV) against it. */}
          {value?.company.erpConnector === "facts" && (
            <div data-module="inv" className="rounded-2xl border p-4">
              <div className="mb-3 flex items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-mod-grad text-white shadow-[0_6px_16px_-6px_var(--mod)]"><WarehouseIcon className="size-5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">FACTS stock location</div>
                  <p className="text-xs text-muted-foreground">Stock on the register comes from this location, and this branch&apos;s returns go to it as STV documents. Its prices come from its price type.</p>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Location code"><Input value={f.erpLocationCode} onChange={(e) => set("erpLocationCode", e.target.value)} placeholder="e.g. DXB01" /></Field>
                <Field label="Location name"><Input value={f.erpLocationName} onChange={(e) => set("erpLocationName", e.target.value)} placeholder="As named in FACTS" /></Field>
                <Field label="Wastage location" hint="Where finance moves the wastage (e.g. WEBQS)."><Input value={f.erpWasteLocation} onChange={(e) => set("erpWasteLocation", e.target.value.toUpperCase())} placeholder="e.g. WEBQS" /></Field>
                <Field label="Price type" hint={f.factsPriceType.trim() ? "Prices come only from this FACTS price type and can't be changed here." : "Empty = prices are set in One POS."}>
                  <Input value={f.factsPriceType} maxLength={20} onChange={(e) => set("factsPriceType", e.target.value)} placeholder="Code in FACTS Price Type Master" />
                </Field>
                {f.factsPriceType.trim() && (
                  <div className="flex items-end pb-2">
                    <Switch on={f.factsPricesIncludeVat} onChange={(v) => set("factsPricesIncludeVat", v)} label="FACTS prices include VAT" />
                  </div>
                )}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">Picking it from the FACTS list arrives with the FACTS link; until then, type the code as it is in FACTS.</p>
              {isAdmin && items.data && (
                <div className="mt-4 border-t pt-4">
                  <div className="font-medium">Items to take from FACTS</div>
                  <p className="mb-3 text-xs text-muted-foreground">For all of {value?.company.name}&apos;s branches (one catalogue; each branch switches on what it sells). Saving syncs the items; ones that no longer match are switched off.</p>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="Item type" hint="e.g. FG"><Input value={it.v.itemType} onChange={(e) => setIt({ ...it, v: { ...it.v, itemType: e.target.value.toUpperCase() } })} placeholder="FG" /></Field>
                    <Field label="Item master" hint="e.g. SMBK. Empty = any."><Input value={it.v.itemMaster} onChange={(e) => setIt({ ...it, v: { ...it.v, itemMaster: e.target.value.toUpperCase() } })} placeholder="SMBK" /></Field>
                    <Field label="Division" hint="Empty = any."><Input value={it.v.division} onChange={(e) => setIt({ ...it, v: { ...it.v, division: e.target.value } })} placeholder="e.g. 50" /></Field>
                  </div>
                </div>
              )}
              {items.error && <ErrorNote message={items.error} />}
            </div>
          )}
          {value?.branch && <DiscountApprovalBox branch={value.branch} onSaved={onSaved} />}
          {value?.branch && value.company.erpConnector === "facts" && <WastageApprovalBox company={value.company} branch={value.branch} onSaved={onSaved} />}
          {value?.branch && value.company.erpConnector === "facts" && <MarketingBox company={value.company} branch={value.branch} onSaved={onSaved} />}
          {value?.branch && value.company.erpConnector === "facts" && <RequestApprovalBox company={value.company} branch={value.branch} onSaved={onSaved} />}

          {/* Table service: the per-branch switch (REQ ORG-03, MOD). */}
          <div data-module={f.tableService ? "sales" : "fin"} className="overflow-hidden rounded-2xl border">
            <div className="flex items-start gap-3 p-4">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-mod-grad text-white shadow-[0_6px_16px_-6px_var(--mod)]">
                {f.tableService ? <ArmchairIcon className="size-5" /> : <ShoppingBagIcon className="size-5" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-medium">{f.tableService ? "Table service" : "Quick service"}</div>
                <p className="text-xs text-muted-foreground">
                  {f.tableService ? "Dine-in on tables of a floor plan, plus takeaway and delivery. Floor, tables and reservations are shown."
                    : "Counter orders only: takeaway and delivery with ticket numbers. No floor or tables."}
                </p>
              </div>
              <Switch size="lg" on={f.tableService} onChange={(v) => set("tableService", v)} label="Table service" />
            </div>
            <AnimatePresence initial={false}>
              {f.tableService && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}>
                  <div className="grid gap-4 border-t bg-muted/30 p-4 sm:grid-cols-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm">Ask for guests when seating</span>
                      <Switch on={f.askGuests} onChange={(v) => set("askGuests", v)} label="Ask for guests" />
                    </div>
                    <Field label="Service charge on dine-in (%)"><Input value={f.serviceChargePct} onChange={(e) => set("serviceChargePct", e.target.value)} inputMode="decimal" /></Field>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Kitchen: on for a restaurant; off for a café or counter that makes orders where they're paid. */}
          <div data-module={f.kitchenEnabled ? "purch" : "fin"} className="flex items-start gap-3 rounded-2xl border p-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-mod-grad text-white shadow-[0_6px_16px_-6px_var(--mod)]">
              {f.kitchenEnabled ? <ChefHatIcon className="size-5" /> : <CoffeeIcon className="size-5" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{f.kitchenEnabled ? "Kitchen" : "No kitchen (café / counter)"}</div>
              <p className="text-xs text-muted-foreground">
                {f.kitchenEnabled ? "Orders are sent to kitchen and bar stations: tickets print there or show on the kitchen display."
                  : "Orders are made at the counter where they're paid. No Send, no kitchen tickets, no kitchen display."}
              </p>
            </div>
            <Switch size="lg" on={f.kitchenEnabled} onChange={(v) => set("kitchenEnabled", v)} label="Kitchen" />
          </div>

          <div className="space-y-2">
            <span className="block text-[0.8rem] font-medium text-foreground/80">Day open and close</span>
            <Segmented id="day-control" value={f.dayControl} onChange={(v) => set("dayControl", v)} className="w-full"
              options={[{ value: "manual", label: "Manual" }, { value: "automatic", label: "Automatic" }, { value: "cashier", label: "Cashier-run" }]} />
            <p className="text-xs text-muted-foreground">
              {f.dayControl === "manual" ? "A manager opens and closes the business day."
                : f.dayControl === "automatic" ? "The day opens and closes on a schedule; counts and variances go to head office for approval."
                  : "A senior cashier opens and closes; approvals go to a manager's phone or head office."}
            </p>
            <div className="grid gap-4 pt-1 sm:grid-cols-2">
              {f.dayControl === "automatic" && <>
                <Field label="Opens at"><Input type="time" value={f.autoOpenTime} onChange={(e) => set("autoOpenTime", e.target.value)} /></Field>
                <Field label="Closes at" hint="Past midnight is fine (e.g. 03:00). Tills warn 10 minutes before and count down a minute."><Input type="time" value={f.autoCloseTime} onChange={(e) => set("autoCloseTime", e.target.value)} /></Field>
                <Field label="Customers waiting: delay by (minutes)" hint="One tap on the countdown, 5 to 60."><Input value={f.closeDelayMinutes} inputMode="numeric" onChange={(e) => set("closeDelayMinutes", e.target.value.replace(/\D/g, ""))} /></Field>
                <Field label="Longest delay in all (minutes)" hint="Then it closes regardless; 0 = no delays."><Input value={f.closeDelayMaxMinutes} inputMode="numeric" onChange={(e) => set("closeDelayMaxMinutes", e.target.value.replace(/\D/g, ""))} /></Field>
              </>}
              <Field label="Usual float per till"><Input value={f.defaultFloat} onChange={(e) => set("defaultFloat", e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" /></Field>
              <Field label="Variance accepted per shift" hint="More than this waits for a manager's approval."><Input value={f.varianceTolerance} onChange={(e) => set("varianceTolerance", e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" /></Field>
              <Field label="Orders still open at day close" span>
                <Segmented id="at-close" value={f.openOrdersAtClose} onChange={(v) => set("openOrdersAtClose", v)} className="w-full"
                  options={[{ value: "carry", label: "Carry to the next day" }, { value: "void_unsent", label: "Void unsent, carry the rest" }]} />
              </Field>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Time zone">
              <select className="h-8 w-full rounded-lg border border-input bg-card px-2.5 text-sm dark:bg-input/30" value={f.timeZone} onChange={(e) => set("timeZone", e.target.value)}>
                {TIME_ZONES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Returns" hint="Off: no Return button on Orders, and no refunds of paid bills here.">
              <Switch on={f.returnsEnabled} onChange={(v) => set("returnsEnabled", v)} label="Returns allowed" />
            </Field>
            {f.returnsEnabled && (
              <Field label="Returns accepted for (days)" hint="0 = the same business day. Later returns need a manager.">
                <Input value={f.returnDays} onChange={(e) => set("returnDays", e.target.value.replace(/\D/g, ""))} inputMode="numeric" />
              </Field>
            )}
            <Field label="Receipt header"><Textarea rows={2} value={f.receiptHeader} onChange={(e) => set("receiptHeader", e.target.value)} placeholder="Shown under the branch name" /></Field>
            <Field label="Receipt footer"><Textarea rows={2} value={f.receiptFooter} onChange={(e) => set("receiptFooter", e.target.value)} placeholder="e.g. Thank you for dining with us" /></Field>
          </div>
          {!isNew && value?.branch && <TillsSection branchId={value.branch.id} />}
          {!isNew && isAdmin && (
            <div className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5">
              <span className="flex items-center gap-2 text-sm"><StoreIcon className="size-4 text-muted-foreground" /> Open <span className="text-muted-foreground">· a closed branch’s tills can’t sign in</span></span>
              <Switch on={f.isActive} onChange={(v) => set("isActive", v)} label="Branch open" />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>{isNew ? "Add branch" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Till = { id: string; code: string; name: string; isActive: boolean; sharedDrawer: boolean };

/**
 * The branch's tills and whether each drawer is shared: on a shared till (one till, several cashiers) the first cashier opens the
 * shift with the float count, the others sign in and sell in it; each payment keeps who took it; any of them closes it. Saved at once.
 */
function TillsSection({ branchId }: { branchId: string }) {
  const tills = useApi<Till[]>(`/branches/${branchId}/registers`);
  async function share(t: Till, on: boolean) {
    try {
      await api(`/registers/${t.id}`, "PUT", { code: t.code, name: t.name, isActive: t.isActive, sharedDrawer: on });
      toast.success(on ? `${t.name}: shared drawer. Every cashier signed in there works in its open shift.` : `${t.name}: one cashier per shift.`);
      tills.reload();
    } catch (e) { toast.error((e as Error).message); }
  }
  if (!tills.data?.length) return null;
  return (
    <div className="rounded-xl border">
      <div className="border-b bg-muted/40 px-3 py-2 text-sm font-medium">Tills <span className="font-normal text-muted-foreground">· shared drawer: several cashiers on one till, one drawer count</span></div>
      {tills.data.map((t) => (
        <div key={t.id} className="flex items-center justify-between gap-3 border-b px-3 py-2.5 last:border-0">
          <span className="text-sm">{t.name} <span className="font-mono text-xs text-muted-foreground">{t.code}</span>{!t.isActive && <span className="text-xs text-muted-foreground"> · off</span>}</span>
          <span className="flex items-center gap-2 text-sm text-muted-foreground">{t.sharedDrawer ? "Shared drawer" : "One cashier"}
            <Switch on={t.sharedDrawer} onChange={(v) => void share(t, v)} label={`Shared drawer on ${t.name}`} /></span>
        </div>
      ))}
    </div>
  );
}

/** Discount approval email for one branch: where a discount request sent to a manager is emailed (it is on the Approvals page too). */
function DiscountApprovalBox({ branch, onSaved }: { branch: Branch; onSaved: () => void }) {
  const [emails, setEmails] = useState((branch.discountApprovalEmails ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      const list = emails.split(/[\s,;]+/).filter(Boolean);
      await api(`/branches/${branch.id}/discount-approval`, "PUT", { emails: list });
      toast.success(list.length ? "Discount approval email saved." : "Discount approval email off for this branch.");
      onSaved();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  const on = !!branch.discountApprovalEmails?.length;
  return (
    <div data-module="sales" className="rounded-2xl border p-4">
      <div className="mb-3 flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-mod-grad text-white shadow-[0_6px_16px_-6px_var(--mod)]"><PercentIcon className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <div className="font-medium">Discount approval email {on ? <Pill className={TONE.done} dot>On</Pill> : <Pill className={TONE.muted}>Off</Pill>}</div>
          <p className="text-xs text-muted-foreground">
            A discount above the cashier&apos;s limit, sent to a manager, is emailed here and shows on the Approvals page. Approved with a manager&apos;s PIN at the till, no email. Empty: no email.
          </p>
        </div>
      </div>
      <Field label="Send to" hint="One address per line."><Textarea rows={2} value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="manager@company.com" /></Field>
      <div className="mt-3"><Button type="button" className="h-10" disabled={busy} onClick={() => void save()}>Save discount approval email</Button></div>
    </div>
  );
}

type CompanyUser = { id: string; displayName: string; username: string; isActive: boolean };

/**
 * Wastage approval for one branch: who approves (a One POS user), where requests are emailed, and the approver's FACTS username,
 * which approved wastage is posted as in FACTS (it must be allowed STV50 "Transaction Posting" there). Saved on its own.
 */
function WastageApprovalBox({ company, branch, onSaved }: { company: Company; branch: Branch; onSaved: () => void }) {
  const users = useApi<CompanyUser[]>(`/companies/${company.id}/users`);
  const [v, setV] = useState({ approverId: branch.wastageApproverId ?? "", email: branch.wastageApprovalEmail ?? "", factsUser: branch.wastageFactsUser ?? "" });
  const [busy, setBusy] = useState(false);
  async function save(off = false) {
    setBusy(true);
    try {
      await api(`/branches/${branch.id}/wastage-approval`, "PUT", off ? { approverId: null, email: null, factsUser: null }
        : { approverId: v.approverId || null, email: v.email.trim() || null, factsUser: v.factsUser.trim() || null });
      if (off) setV({ approverId: "", email: "", factsUser: "" });
      toast.success(off ? "Wastage approval off for this branch." : "Wastage approval saved.");
      onSaved();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  const on = !!branch.wastageApproverId;
  return (
    <div data-module="inv" className="rounded-2xl border p-4">
      <div className="mb-3 flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-mod-grad text-white shadow-[0_6px_16px_-6px_var(--mod)]"><Trash2Icon className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <div className="font-medium">Wastage approval {on ? <Pill className={TONE.done} dot>On</Pill> : <Pill className={TONE.muted}>Off</Pill>}</div>
          <p className="text-xs text-muted-foreground">
            Wastage recorded at this branch waits for the approver (email and Approvals page). Approved, it is posted in FACTS as a stock transfer to the wastage
            location, batches oldest first, as the approver&apos;s FACTS username. Off: wastage goes as before.
          </p>
        </div>
      </div>
      {users.error ? <ErrorNote message={users.error} /> : (
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Approver (One POS user)">
            <select value={v.approverId} onChange={(e) => setV({ ...v, approverId: e.target.value })} className="h-10 w-full rounded-xl border border-input bg-card px-3 text-sm dark:bg-input/30">
              <option value="">Choose a user</option>
              {(users.data ?? []).filter((u) => u.isActive).map((u) => <option key={u.id} value={u.id}>{u.displayName} ({u.username})</option>)}
            </select>
          </Field>
          <Field label="Approval email"><Input type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} placeholder="name@company.com" /></Field>
          <Field label="FACTS username" hint="Posts the approved wastage in FACTS."><Input value={v.factsUser} maxLength={20} onChange={(e) => setV({ ...v, factsUser: e.target.value })} placeholder="e.g. QasimullahM" /></Field>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" className="h-10" disabled={busy || !v.approverId} onClick={() => void save()}>Save wastage approval</Button>
        {on && <Button type="button" variant="outline" className="h-10" disabled={busy} onClick={() => void save(true)}>Turn off</Button>}
      </div>
    </div>
  );
}

/**
 * Marketing give-aways at one branch: who approves them (a One POS user), where requests are emailed, the approver's FACTS username
 * the approved MCV50 is posted as (it must be allowed MCV50 "Transaction Posting" there), and the FACTS expense account it debits.
 * Set, the branch has a Marketing tab on Stock. Saved on its own.
 */
function MarketingBox({ company, branch, onSaved }: { company: Company; branch: Branch; onSaved: () => void }) {
  const users = useApi<CompanyUser[]>(`/companies/${company.id}/users`);
  const [v, setV] = useState({ approverId: branch.marketingApproverId ?? "", email: branch.marketingApprovalEmail ?? "", factsUser: branch.marketingFactsUser ?? "", account: branch.marketingAccount ?? "" });
  const [busy, setBusy] = useState(false);
  async function save(off = false) {
    setBusy(true);
    try {
      await api(`/branches/${branch.id}/marketing`, "PUT", off ? { approverId: null, email: null, factsUser: null, account: null }
        : { approverId: v.approverId || null, email: v.email.trim() || null, factsUser: v.factsUser.trim() || null, account: v.account.trim() || null });
      if (off) setV({ approverId: "", email: "", factsUser: "", account: "" });
      toast.success(off ? "Marketing off for this branch." : "Marketing saved.");
      onSaved();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  const on = !!branch.marketingApproverId;
  return (
    <div data-module="sales" className="rounded-2xl border p-4">
      <div className="mb-3 flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-mod-grad text-white shadow-[0_6px_16px_-6px_var(--mod)]"><MegaphoneIcon className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <div className="font-medium">Marketing (items given away) {on ? <Pill className={TONE.done} dot>On</Pill> : <Pill className={TONE.muted}>Off</Pill>}</div>
          <p className="text-xs text-muted-foreground">
            Items given away at this branch (tasting, promotions, influencers, gifts) are recorded on Stock &rarr; Marketing and wait for the approver (email and
            Approvals page). Approved, they are posted in FACTS as a material consumption (MCV50) at batch cost to the expense account, as the approver&apos;s
            FACTS username. Off: no Marketing tab.
          </p>
        </div>
      </div>
      {users.error ? <ErrorNote message={users.error} /> : (
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <Field label="Approver" hint="The One POS user who approves the give-aways.">
            <select value={v.approverId} onChange={(e) => setV({ ...v, approverId: e.target.value })} className="h-10 w-full rounded-xl border border-input bg-card px-3 text-sm dark:bg-input/30">
              <option value="">Choose a user</option>
              {(users.data ?? []).filter((u) => u.isActive).map((u) => <option key={u.id} value={u.id}>{u.displayName} ({u.username})</option>)}
            </select>
          </Field>
          <Field label="Approval email"><Input type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} placeholder="name@company.com" /></Field>
          <Field label="FACTS username" hint="Posts the MCV50 in FACTS (must be allowed MCV50 posting)."><Input value={v.factsUser} maxLength={20} onChange={(e) => setV({ ...v, factsUser: e.target.value })} placeholder="e.g. MalikaT" /></Field>
          <Field label="Expense account" hint="FACTS account the give-aways are charged to."><Input value={v.account} maxLength={20} onChange={(e) => setV({ ...v, account: e.target.value })} placeholder="e.g. 8003" /></Field>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" className="h-10" disabled={busy || !v.approverId} onClick={() => void save()}>Save marketing</Button>
        {on && <Button type="button" variant="outline" className="h-10" disabled={busy} onClick={() => void save(true)}>Turn off</Button>}
      </div>
    </div>
  );
}

/**
 * Stock requests at one branch (STR50): who approves them (a One POS user), where requests are emailed, and the approver's FACTS
 * username the approved STR50 is posted as. Set, the branch has a Requests tab on Stock. Saved on its own.
 */
function RequestApprovalBox({ company, branch, onSaved }: { company: Company; branch: Branch; onSaved: () => void }) {
  const users = useApi<CompanyUser[]>(`/companies/${company.id}/users`);
  const [v, setV] = useState({ approverId: branch.requestApproverId ?? "", email: branch.requestApprovalEmail ?? "", factsUser: branch.requestFactsUser ?? "" });
  const [busy, setBusy] = useState(false);
  async function save(off = false) {
    setBusy(true);
    try {
      await api(`/branches/${branch.id}/request-approval`, "PUT", off ? { approverId: null, email: null, factsUser: null }
        : { approverId: v.approverId || null, email: v.email.trim() || null, factsUser: v.factsUser.trim() || null });
      if (off) setV({ approverId: "", email: "", factsUser: "" });
      toast.success(off ? "Stock requests off for this branch." : "Stock requests saved.");
      onSaved();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  const on = !!branch.requestApproverId;
  return (
    <div data-module="inv" className="rounded-2xl border p-4">
      <div className="mb-3 flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-mod-grad text-white shadow-[0_6px_16px_-6px_var(--mod)]"><ClipboardListIcon className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <div className="font-medium">Stock requests {on ? <Pill className={TONE.done} dot>On</Pill> : <Pill className={TONE.muted}>Off</Pill>}</div>
          <p className="text-xs text-muted-foreground">
            The branch asks a store for stock on Stock &rarr; Requests; the request waits for the approver (email and Approvals page), who can change quantities.
            Approved, it is posted in FACTS as a stock transfer request (STR50) as the approver&apos;s FACTS username. Off: no Requests tab.
          </p>
        </div>
      </div>
      {users.error ? <ErrorNote message={users.error} /> : (
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <Field label="Approver" hint="The One POS user who approves the requests.">
            <select value={v.approverId} onChange={(e) => setV({ ...v, approverId: e.target.value })} className="h-10 w-full rounded-xl border border-input bg-card px-3 text-sm dark:bg-input/30">
              <option value="">Choose a user</option>
              {(users.data ?? []).filter((u) => u.isActive).map((u) => <option key={u.id} value={u.id}>{u.displayName} ({u.username})</option>)}
            </select>
          </Field>
          <Field label="Approval email"><Input type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} placeholder="name@company.com" /></Field>
          <Field label="FACTS username" hint="Posts the approved STR50 in FACTS."><Input value={v.factsUser} maxLength={20} onChange={(e) => setV({ ...v, factsUser: e.target.value })} placeholder="e.g. NaziaS" /></Field>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" className="h-10" disabled={busy || !v.approverId} onClick={() => void save()}>Save stock requests</Button>
        {on && <Button type="button" variant="outline" className="h-10" disabled={busy} onClick={() => void save(true)}>Turn off</Button>}
      </div>
    </div>
  );
}

/** The stores branches can ask for stock (FACTS locations, e.g. the main store 5ALK1): add one by its code, rename it, switch it off. */
function RequestStoresBox({ company }: { company: Company }) {
  const list = useApi<{ id: string; code: string; name: string; isActive: boolean }[]>(`/companies/${company.id}/request-stores`);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  async function put(body: { code: string; name?: string | null; isActive?: boolean }, done: string) {
    setBusy(true);
    try {
      const r = await api<{ code: string; name: string }>(`/companies/${company.id}/request-stores`, "PUT", body);
      toast.success(`${done}: ${r.name} (${r.code})`);
      list.reload();
      return true;
    } catch (e) { toast.error((e as Error).message); return false; } finally { setBusy(false); }
  }
  return (
    <div data-module="inv" className="rounded-2xl border p-4">
      <div className="mb-3 flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-mod-grad text-white shadow-[0_6px_16px_-6px_var(--mod)]"><WarehouseIcon className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <div className="font-medium">Request stores</div>
          <p className="text-xs text-muted-foreground">The FACTS locations branches can ask for stock (Stock &rarr; Requests). Empty name: FACTS&apos; own name is used.</p>
        </div>
      </div>
      <ErrorNote message={list.error} />
      {!!list.data?.length && (
        <div className="mb-3 divide-y rounded-xl border">
          {list.data.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-3 py-2">
              <span className="w-16 font-mono text-xs text-muted-foreground">{s.code}</span>
              <span className={s.isActive ? "min-w-0 flex-1 truncate text-sm" : "min-w-0 flex-1 truncate text-sm text-muted-foreground line-through"}>{s.name}</span>
              <Switch on={s.isActive} onChange={(v) => void put({ code: s.code, name: s.name, isActive: v }, v ? "Switched on" : "Switched off")} label={`${s.name} active`} />
            </div>
          ))}
        </div>
      )}
      <div className="grid items-end gap-3 sm:grid-cols-[8rem_minmax(0,1fr)_auto]">
        <Field label="FACTS location"><Input value={code} maxLength={20} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. 5ALK1" /></Field>
        <Field label="Name (optional)"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Main store" /></Field>
        <Button type="button" className="h-10" disabled={busy || !code.trim()}
          onClick={() => void put({ code: code.trim(), name: name.trim() || null }, "Store added").then((ok) => { if (ok) { setCode(""); setName(""); } })}>
          <PlusIcon /> Add store
        </Button>
      </div>
    </div>
  );
}
