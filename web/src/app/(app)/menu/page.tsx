"use client";

import { useMemo, useState } from "react";
import { BanIcon, CameraIcon, CheckIcon, CookingPotIcon, HistoryIcon, ImageOffIcon, LayersIcon, PencilIcon, PlusIcon, Trash2Icon, UtensilsCrossedIcon } from "lucide-react";
import { toast } from "sonner";
import { api, apiUpload, shrinkImage, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtIn } from "@/lib/num";
import { imageUrl, initials, noPrice, type Menu, type MenuCategory, type MenuItem, type ModifierGroup, type Tone } from "@/lib/pos";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { EmptyState, ErrorNote, Field, LoadingRows, PageHeader, Pill, SearchField, Segmented, Switch, TONE } from "@/components/kit";
import { FactsPanel } from "@/components/facts-panel";
import { costTone, RecipeDialog, type Recipe, type RecipeTarget } from "@/components/recipe-editor";
import { Stagger, StaggerItem } from "@/components/motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const TONES: Tone[] = ["fin", "sales", "purch", "inv", "bp", "bank", "appr", "admin"];

/** The company menu (REQ MNU-01, MNU-02, REG-02): categories, items, option groups; this branch's availability and price. */
export default function MenuPage() {
  const { company, branch } = useSession();
  const menu = useApi<Menu>("/menu");
  useLiveEvent(["menu.changed"], () => menu.reload());
  const [tab, setTab] = useState<"items" | "groups">("items");
  const [cat, setCat] = useState<string | null>(null);
  const [editCat, setEditCat] = useState<MenuCategory | "new" | null>(null);
  const [editItem, setEditItem] = useState<MenuItem | "new" | "combo" | null>(null);
  const [editGroup, setEditGroup] = useState<ModifierGroup | "new" | null>(null);
  const cur = company?.currency ?? "AED";
  const m = menu.data;
  const fromFacts = company?.erpConnector === "facts";
  // A FACTS catalogue has thousands of items: show what's sold here, what's new from FACTS, what has no price, or all; search finds any.
  const [view, setView] = useState<"all" | "here" | "new" | "noprice">(fromFacts ? "here" : "all");
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const inView = useMemo(() => (m?.items ?? []).filter((i) =>
    (view === "all" || (view === "here" && i.isSold && i.isActive) || (view === "new" && i.erpNew && i.isActive) || (view === "noprice" && noPrice(i) && i.isSold && i.isActive))
    && (!term || i.name.toLowerCase().includes(term) || (i.erpItemCode ?? "").toLowerCase().includes(term))), [m, view, term]);
  const shownCats = useMemo(() => (m?.categories ?? []).filter((c) => (view === "all" && !term) || inView.some((i) => i.categoryId === c.id)), [m, inView, view, term]);
  const current = term ? null : (shownCats.some((c) => c.id === cat) ? cat : shownCats[0]?.id ?? null);
  const items = useMemo(() => inView.filter((i) => term || i.categoryId === current).slice(0, 300), [inView, current, term]);

  async function branchSet(i: MenuItem, body: Record<string, unknown>, msg: string) {
    try { await api(`/menu/items/${i.id}/branch`, "PUT", body); toast.success(msg); menu.reload(); } catch (e) { toast.error((e as Error).message); }
  }

  return (
    <div>
      <PageHeader title="Menu" icon={UtensilsCrossedIcon} module="inv" count={m?.items.length}
        description={`${company?.name}: one menu for every branch. Availability and prices below are for ${branch?.name ?? "the chosen branch"}.`}
        actions={<>
          <Segmented id="menu-tab" value={tab} onChange={setTab} options={[{ value: "items", label: "Items" }, { value: "groups", label: "Option groups" }]} />
          {tab === "items"
            ? <>
                <Button size="lg" variant={fromFacts ? "default" : "outline"} onClick={() => setEditItem("combo")} disabled={!m?.categories.length}><PlusIcon /> New combo</Button>
                {/* A FACTS company's items come from FACTS (the item sync); only combos are made here. */}
                {!fromFacts && <Button size="lg" onClick={() => setEditItem("new")} disabled={!m?.categories.length}><PlusIcon /> New item</Button>}
              </>
            : <Button size="lg" onClick={() => setEditGroup("new")}><PlusIcon /> New group</Button>}
        </>} />
      <ErrorNote message={menu.error} />
      {fromFacts && tab === "items" && <FactsPanel branchName={branch?.name} onChanged={() => menu.reload()} />}
      {m && tab === "items" && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Segmented id="menu-view" value={view} onChange={setView} options={[
            { value: "here", label: `Sold here (${m.items.filter((i) => i.isSold && i.isActive).length})` },
            ...(fromFacts ? [{ value: "new" as const, label: `New from FACTS (${m.items.filter((i) => i.erpNew && i.isActive).length})` }] : []),
            { value: "noprice", label: `No price (${m.items.filter((i) => noPrice(i) && i.isSold && i.isActive).length})` },
            { value: "all", label: `All (${m.items.length})` },
          ]} />
          <SearchField value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or FACTS code" className="w-72 max-w-full" />
        </div>
      )}
      {menu.loading && !m ? <LoadingRows /> : !m ? null : tab === "groups" ? (
        m.groups.length ? (
          <Stagger className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {m.groups.map((g) => (
              <StaggerItem key={g.id} className="h-full">
                <button type="button" onClick={() => setEditGroup(g)} data-module="inv" className="group surface card-lift flex h-full w-full flex-col p-5 text-left">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-heading text-base font-semibold">{g.name}</div>
                      <div className="text-xs text-muted-foreground">{g.minSelect ? `Required · choose ${g.minSelect === g.maxSelect ? g.minSelect : `${g.minSelect}–${g.maxSelect}`}` : `Optional · up to ${g.maxSelect}`}</div>
                    </div>
                    <span className="hover-hop flex size-10 items-center justify-center rounded-xl bg-mod-grad text-white shadow-[0_6px_16px_-6px_var(--mod)]"><LayersIcon className="size-[1.1rem]" /></span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {g.options.filter((o) => o.isActive).map((o) => <Pill key={o.id}>{o.name}{o.price ? ` +${fmtIn(o.price, 2)}` : ""}</Pill>)}
                  </div>
                  <div className="mt-3 text-xs text-muted-foreground">Used by {m.items.filter((i) => i.groupIds.includes(g.id)).length} items</div>
                </button>
              </StaggerItem>
            ))}
          </Stagger>
        ) : <EmptyState icon={LayersIcon} title="No option groups yet" module="inv" action={<Button size="lg" onClick={() => setEditGroup("new")}><PlusIcon /> New group</Button>}>Groups like Size, Spice level or Extras, with a price per option.</EmptyState>
      ) : (
        <div className="grid gap-4 md:grid-cols-[210px_minmax(0,1fr)] lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-5">
          <aside className="surface h-fit overflow-hidden">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="font-heading text-[0.9rem] font-semibold">Categories</h2>
              <Button variant="ghost" size="icon" aria-label="New category" onClick={() => setEditCat("new")}><PlusIcon /></Button>
            </div>
            <div className="p-2">
              {shownCats.map((c) => {
                const on = c.id === current;
                return (
                  <div key={c.id} data-module={c.tone} className={cn("group flex items-center rounded-xl transition-colors", on ? "bg-mod/10" : "hover:bg-muted")}>
                    <button type="button" onClick={() => setCat(c.id)} className="flex h-12 min-w-0 flex-1 items-center gap-2.5 px-3 text-left">
                      <span className={cn("size-2.5 shrink-0 rounded-full bg-mod", !c.isActive && "opacity-30")} />
                      <span className={cn("flex-1 truncate text-sm", on && "font-medium", !c.isActive && "text-muted-foreground line-through")}>{c.name}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">{inView.filter((i) => i.categoryId === c.id).length}</span>
                    </button>
                    <button type="button" aria-label={`Edit ${c.name}`} onClick={() => setEditCat(c)} className="mr-1 flex size-9 items-center justify-center rounded-lg text-muted-foreground opacity-60 hover:bg-card hover:opacity-100"><PencilIcon className="size-3.5" /></button>
                  </div>
                );
              })}
              {!m.categories.length && <p className="px-3 py-4 text-sm text-muted-foreground">Add the first category, e.g. Starters.</p>}
            </div>
          </aside>
          <section>
            {items.length ? (
              <Stagger key={`${current ?? ""}|${view}|${term}`} className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                {items.map((i) => {
                  const tone = m.categories.find((c) => c.id === i.categoryId)?.tone ?? "fin";
                  return (
                    <StaggerItem key={i.id}>
                      <div data-module={tone} className={cn("surface flex h-full flex-col p-4", !i.isActive && "opacity-60")}>
                        <div className="flex items-start gap-3">
                          <Thumb src={imageUrl(company?.id, i)} name={i.name} />
                          <div className="min-w-0 flex-1">
                            <div className="font-medium">{i.name} {i.nameAr && <span className="text-sm text-muted-foreground" dir="rtl">· {i.nameAr}</span>}</div>
                            <div className="text-xs text-muted-foreground">{i.station === "bar" ? "Bar" : i.station === "kitchen" ? "Kitchen" : "No station"}{i.groupIds.length ? ` · ${i.groupIds.map((g) => m.groups.find((x) => x.id === g)?.name).filter(Boolean).join(", ")}` : ""}</div>
                          </div>
                          <div className="text-right">
                            {noPrice(i) ? <div className="text-sm font-medium text-warning">{i.erpPriced ? "No FACTS price" : "No price"}</div> : <div className="font-heading font-semibold tabular-nums">{fmtIn(i.branchPrice ?? i.price, 2)}</div>}
                            {i.branchPrice !== null && !i.erpPriced && <div className="text-xs text-muted-foreground line-through tabular-nums">{fmtIn(i.price, 2)}</div>}
                          </div>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-1.5">
                          {i.isCombo && <Pill className={TONE.violet} dot>Combo</Pill>}
                          {!i.isActive && <Pill>Hidden everywhere</Pill>}
                          {!i.isSold && <Pill className={TONE.warn}>Not sold here</Pill>}
                          {i.soldOut && <Pill className={TONE.danger} dot>Sold out today</Pill>}
                          {i.erpPriced ? <Pill className={TONE.info}>FACTS price</Pill> : i.branchPrice !== null && <Pill className={TONE.info}>Branch price</Pill>}
                          {i.erpItemCode && <Pill>FACTS {i.erpItemCode}{i.erpUnit ? ` · ${i.erpUnit}` : ""}</Pill>}
                          {i.erpNew && i.isActive && <Pill className={TONE.info} dot>New from FACTS</Pill>}
                          {i.erpRemoved && <Pill className={TONE.danger}>Gone from FACTS</Pill>}
                          {fromFacts && !i.isCombo && !i.erpItemCode && <Pill className={TONE.danger}>Not in FACTS</Pill>}
                          {i.erpPriced && noPrice(i) && <span className="text-xs text-muted-foreground">Add its price in FACTS</span>}
                          {i.erpStock !== null && <Pill className={i.erpStock > 0 ? TONE.done : TONE.danger}>Stock {fmtIn(i.erpStock, i.erpStock % 1 ? 2 : 0)}</Pill>}
                        </div>
                        <div className="mt-auto flex flex-wrap gap-2 pt-3">
                          <Button variant={noPrice(i) && i.isSold && !i.erpPriced ? "default" : "outline"} className="h-10" onClick={() => setEditItem(i)}><PencilIcon /> {noPrice(i) && !i.erpPriced ? "Set price" : "Edit"}</Button>
                          <Button variant="outline" className="h-10" onClick={() => branchSet(i, { soldOutToday: !i.soldOut }, i.soldOut ? `${i.name} is back on.` : `${i.name} is sold out for today.`)}>
                            {i.soldOut ? <><CheckIcon /> Back on</> : <><BanIcon /> Sold out</>}
                          </Button>
                          <Button variant="ghost" className="h-10" onClick={() => branchSet(i, { isSold: !i.isSold }, i.isSold ? `${i.name} is no longer sold at ${branch?.name}.` : `${i.name} is sold at ${branch?.name} again.`)}>
                            {i.isSold ? "Don't sell here" : "Sell here"}
                          </Button>
                        </div>
                      </div>
                    </StaggerItem>
                  );
                })}
              </Stagger>
            ) : (
              term || view !== "all" ? <EmptyState icon={UtensilsCrossedIcon} title="Nothing here" module="inv">{term ? `No item matches “${q.trim()}”.` : view === "here" ? "No items are switched on at this branch yet." : view === "new" ? "Every item from FACTS has been reviewed." : "Every item sold here has a price."}</EmptyState> :
              <EmptyState icon={UtensilsCrossedIcon} title={m.categories.length ? "No items in this category" : "Start with a category"} module="inv"
                action={m.categories.length ? <Button size="lg" onClick={() => setEditItem(fromFacts ? "combo" : "new")}><PlusIcon /> {fromFacts ? "New combo" : "New item"}</Button> : <Button size="lg" onClick={() => setEditCat("new")}><PlusIcon /> New category</Button>}>
                {m.categories.length ? "Add dishes and drinks with their price and options." : "Categories group the menu on the register, e.g. Starters, Mains, Drinks."}
              </EmptyState>
            )}
          </section>
        </div>
      )}
      {m && <CategoryDialog value={editCat} onClose={() => setEditCat(null)} onSaved={(id) => { menu.reload(); if (id) setCat(id); }} />}
      {m && <ItemDialog value={editItem} menu={m} companyId={company?.id} fromFacts={fromFacts} defaultCategory={current} currency={cur} branchName={branch?.name} onClose={() => setEditItem(null)} onSaved={() => menu.reload()} />}
      {m && <GroupDialog value={editGroup} items={m.items} currency={cur} onClose={() => setEditGroup(null)} onSaved={() => menu.reload()} />}
    </div>
  );
}

function CategoryDialog({ value, onClose, onSaved }: { value: MenuCategory | "new" | null; onClose: () => void; onSaved: (id?: string) => void }) {
  const [f, setF] = useState({ name: "", nameAr: "", tone: "fin" as Tone, isActive: true });
  const [seen, setSeen] = useState<typeof value>(null);
  if (value !== seen) { setSeen(value); setF(value && value !== "new" ? { name: value.name, nameAr: value.nameAr ?? "", tone: value.tone, isActive: value.isActive } : { name: "", nameAr: "", tone: "fin", isActive: true }); }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      const r = value === "new" ? await api<{ id: string }>("/menu/categories", "POST", f) : await api<{ id: string }>(`/menu/categories/${(value as MenuCategory).id}`, "PUT", f);
      toast.success("Category saved."); onSaved(r.id); onClose();
    } catch (err) { toast.error((err as Error).message); }
  }
  return (
    <Dialog open={!!value} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={save} className="grid gap-4">
          <DialogHeader><DialogTitle>{value === "new" ? "New category" : `Category · ${f.name}`}</DialogTitle></DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Arabic name"><Input dir="rtl" value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
          </div>
          <Field label="Colour on the register">
            <div className="flex flex-wrap gap-2">
              {TONES.map((t) => (
                <button key={t} type="button" data-module={t} onClick={() => setF({ ...f, tone: t })} aria-label={t} aria-pressed={f.tone === t}
                  className={cn("size-11 rounded-xl bg-mod-grad transition-transform active:scale-95", f.tone === t ? "ring-3 ring-primary ring-offset-2 ring-offset-popover" : "opacity-80")} />
              ))}
            </div>
          </Field>
          {value !== "new" && (
            <div className="flex items-center justify-between rounded-xl border px-3 py-2.5"><span className="text-sm">Shown on the register</span><Switch on={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} label="Shown" /></div>
          )}
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={!f.name.trim()}>Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** An item's photo, or its initials on the category colour. */
function Thumb({ src, name, size = "size-14" }: { src: string | null; name: string; size?: string }) {
  return src
    // eslint-disable-next-line @next/next/no-img-element -- a small same-origin photo
    ? <img src={src} alt="" className={cn(size, "shrink-0 rounded-xl object-cover shadow-soft")} />
    : <span className={cn(size, "flex shrink-0 items-center justify-center rounded-xl bg-mod-grad font-heading text-xs font-semibold text-white shadow-[0_6px_14px_-6px_var(--mod)]")}>{initials(name)}</span>;
}

function ItemDialog({ value, menu, companyId, fromFacts, defaultCategory, currency, branchName, onClose, onSaved }: {
  value: MenuItem | "new" | "combo" | null; menu: Menu; companyId?: string; fromFacts?: boolean; defaultCategory: string | null; currency: string; branchName?: string; onClose: () => void; onSaved: () => void;
}) {
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | "remove" | null>(null);
  const blank = { categoryId: defaultCategory ?? "", name: "", nameAr: "", description: "", price: "", station: "kitchen", erpItemCode: "", isActive: true, groupIds: [] as string[], branchPrice: "", isCombo: false };
  const [f, setF] = useState(blank);
  const [seen, setSeen] = useState<typeof value>(null);
  if (value !== seen) {
    setSeen(value);
    setPhoto(null);
    setF(value && value !== "new" && value !== "combo" ? { categoryId: value.categoryId, name: value.name, nameAr: value.nameAr ?? "", description: value.description ?? "", price: String(value.price), station: value.station,
      erpItemCode: value.erpItemCode ?? "", isActive: value.isActive, groupIds: value.groupIds, branchPrice: value.branchPrice === null ? "" : String(value.branchPrice), isCombo: value.isCombo }
      : value === "combo" ? { ...blank, isCombo: true, station: "none" } : blank);
  }
  const existing = value && value !== "new" && value !== "combo" ? value : null;
  // This branch takes the item's price from FACTS (its price type): no price is typed here, the item shows FACTS' price.
  const factsPriced = !!existing?.erpPriced && !f.isCombo;
  const recipe = useApi<Recipe>(existing ? `/recipes/item/${existing.id}` : null);
  const [recipeFor, setRecipeFor] = useState<RecipeTarget | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      const body = { ...f, price: Number(f.price) };
      const r = existing ? await api<{ id: string }>(`/menu/items/${existing.id}`, "PUT", body) : await api<{ id: string }>("/menu/items", "POST", body);
      const bp = f.branchPrice.trim();
      if (existing && !existing.erpPriced && bp !== (existing.branchPrice === null ? "" : String(existing.branchPrice)))
        await api(`/menu/items/${r.id}/branch`, "PUT", bp ? { price: Number(bp) } : { clearPrice: true });
      if (photo === "remove") await api(`/menu/items/${r.id}/image`, "DELETE");
      else if (photo) await apiUpload(`/menu/items/${r.id}/image`, photo.blob, "photo.webp");
      toast.success("Item saved."); onSaved(); onClose();
    } catch (err) { toast.error((err as Error).message); }
  }
  const toggleGroup = (id: string) => setF({ ...f, groupIds: f.groupIds.includes(id) ? f.groupIds.filter((g) => g !== id) : [...f.groupIds, id] });
  return (
    <Dialog open={!!value} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-xl">
        <form onSubmit={save} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{existing ? existing.name : f.isCombo ? "New combo" : "New item"}</DialogTitle>
            <DialogDescription>Shown on every branch&apos;s register in its category.</DialogDescription>
          </DialogHeader>
          <PhotoPicker current={photo === "remove" ? null : photo ? photo.url : existing && companyId ? imageUrl(companyId, existing) : null} name={f.name || "New item"}
            onPick={async (file) => { try { const blob = await shrinkImage(file); setPhoto({ blob, url: URL.createObjectURL(blob) }); } catch (e) { toast.error((e as Error).message || "Couldn't read the photo."); } }}
            onRemove={() => setPhoto(existing?.hasImage ? "remove" : null)} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Arabic name"><Input dir="rtl" value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} /></Field>
            {f.isCombo
              ? <Field label="Price" hint="The prices on its choices (each a menu item)."><Input value="Priced by its choices" readOnly disabled /></Field>
              : factsPriced
              ? <Field label={`Price at ${branchName ?? "this branch"}`} hint="From this branch's FACTS price type; change it in FACTS."><Input value={f.branchPrice ? `${currency} ${f.branchPrice}` : "No price in FACTS"} readOnly disabled /></Field>
              : <Field label={`Price (${currency})`} required><Input inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>}
            <Field label="Category">
              <select className="h-8 w-full rounded-lg border border-input bg-card px-2.5 text-sm dark:bg-input/30" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
                {menu.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Description" span><Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Shown when choosing options" /></Field>
          </div>
          <Field label="Prepared at">
            <Segmented id="station" value={f.station} onChange={(v) => setF({ ...f, station: v })} className="w-full"
              options={[{ value: "kitchen", label: "Kitchen" }, { value: "bar", label: "Bar" }, { value: "none", label: "Nowhere (ready to sell)" }]} />
          </Field>
          {!fromFacts && <div data-module="appr" className="flex items-center justify-between gap-3 rounded-xl border px-4 py-3">
            <span className="text-sm"><span className="font-medium">This is a combo</span> <span className="text-muted-foreground">· one price for a set of items the customer chooses, e.g. a main + a drink</span></span>
            <Switch on={f.isCombo} onChange={(v) => setF({ ...f, isCombo: v, station: v ? "none" : f.station })} label="Combo" />
          </div>}
          <Field label={f.isCombo ? "Combo choices" : "Option groups"} hint={f.isCombo ? "Tap the choice groups this combo offers, e.g. Choose a main, Choose a drink. Make them in the Option groups tab, linking each option to a menu item. Every choice must be a menu item; FACTS gets each chosen item with its own code, at the price set on the choice." : "Tap to attach. Required groups must be chosen at the register."}>
            <div className="flex flex-wrap gap-2">
              {menu.groups.map((g) => {
                const on = f.groupIds.includes(g.id);
                return (
                  <button key={g.id} type="button" onClick={() => toggleGroup(g.id)} aria-pressed={on}
                    className={cn("h-10 rounded-xl border px-3.5 text-sm transition-[background-color,transform] active:scale-[0.97]", on ? "border-primary bg-primary/10 font-medium text-primary" : "bg-card hover:bg-muted")}>
                    {g.name}{g.minSelect ? " *" : ""}
                  </button>
                );
              })}
              {!menu.groups.length && <span className="text-sm text-muted-foreground">No groups yet (Option groups tab).</span>}
            </div>
          </Field>
          {existing && !f.isCombo && (
            <button type="button" onClick={() => setRecipeFor({ kind: "item", id: existing.id, name: existing.name })}
              className="flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors hover:bg-muted/60">
              <CookingPotIcon className="size-5 shrink-0 text-primary" />
              <span className="min-w-0 flex-1 text-sm">
                <span className="font-medium">Recipe</span>{" "}
                <span className="text-muted-foreground">
                  · {recipe.data?.lines.length ? `${recipe.data.lines.length} ingredient${recipe.data.lines.length === 1 ? "" : "s"}: ${recipe.data.lines.map((l) => l.name).join(", ")}` : "none yet: add one so sales take ingredients off stock"}
                </span>
              </span>
              {recipe.data?.lines.length ? (
                <span className="shrink-0 text-sm font-medium tabular-nums">{currency} {fmtIn(recipe.data.cost, 2)}{recipe.data.costPct !== null && <span className={cn("ml-1.5", costTone(recipe.data.costPct))}>{recipe.data.costPct}%</span>}</span>
              ) : null}
            </button>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {!f.isCombo && (fromFacts
              ? <Field label="FACTS item" hint="From FACTS; it links the item there."><Input value={f.erpItemCode || "Not in FACTS"} readOnly disabled /></Field>
              : <Field label="ERP item code" hint="Links to the AWS One / FACTS item (phase 3)."><Input value={f.erpItemCode} onChange={(e) => setF({ ...f, erpItemCode: e.target.value })} /></Field>)}
            {existing && !f.isCombo && !factsPriced && (
              <Field label={`Price at ${branchName ?? "this branch"}`} hint="Empty = the company price."><Input inputMode="decimal" value={f.branchPrice} onChange={(e) => setF({ ...f, branchPrice: e.target.value })} placeholder={String(existing.price)} /></Field>
            )}
          </div>
          {existing && <PriceHistory itemId={existing.id} currency={currency} branchName={branchName} />}
          {existing && <div className="flex items-center justify-between rounded-xl border px-3 py-2.5"><span className="text-sm">On the menu <span className="text-muted-foreground">· off hides it at every branch</span></span><Switch on={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} label="On the menu" /></div>}
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={!f.name.trim() || f.price === "" || !f.categoryId}>Save</Button></DialogFooter>
        </form>
        <RecipeDialog target={recipeFor} currency={currency} onClose={() => setRecipeFor(null)} onSaved={() => recipe.reload()} />
      </DialogContent>
    </Dialog>
  );
}

type PriceChange = { changedAt: string; branch: boolean; oldPrice: number | null; newPrice: number | null; source: "facts" | "manual"; factsPrice: number | null; by: string | null; platform: string | null };

/** The item's price changes here and its company price, newest first (bills already rung up keep the price they were sold at). */
function PriceHistory({ itemId, currency, branchName }: { itemId: string; currency: string; branchName?: string }) {
  const [open, setOpen] = useState(false);
  const h = useApi<PriceChange[]>(open ? `/menu/items/${itemId}/price-history` : null);
  const p = (n: number | null) => (n === null ? "none" : fmtIn(n, 2));
  return (
    <div className="rounded-xl border">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm hover:bg-muted/60">
        <HistoryIcon className="size-4 text-muted-foreground" /><span className="font-medium">Price history</span>
        <span className="text-muted-foreground">· {open ? "hide" : "show"}</span>
      </button>
      {open && (
        <div className="max-h-56 overflow-y-auto border-t px-4 py-2 text-sm">
          {h.error ? <ErrorNote message={h.error} /> : !h.data ? <span className="text-muted-foreground">Loading…</span> : !h.data.length ? <span className="text-muted-foreground">No price changes yet.</span> :
            h.data.map((x, n) => (
              <div key={n} className="flex flex-wrap items-baseline gap-x-2 py-1.5">
                <span className="w-36 shrink-0 text-xs text-muted-foreground tabular-nums">{new Date(x.changedAt).toLocaleString()}</span>
                <span className="tabular-nums">{currency} {p(x.oldPrice)} → <span className="font-medium">{p(x.newPrice)}</span></span>
                <span className="text-xs text-muted-foreground">
                  {x.platform ? `${x.platform} price` : x.branch ? branchName ?? "this branch" : "company price"} · {x.source === "facts" ? `FACTS${!x.platform && x.factsPrice !== null && x.factsPrice !== x.newPrice ? ` (${fmtIn(x.factsPrice, 2)} before VAT)` : ""}` : `set by ${x.by ?? "someone"}`}
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/** Choose the menu item an option is: search by name or ERP item code; each shows its code. */
function ItemPicker({ items, value, onChange }: { items: MenuItem[]; value: string; onChange: (item: MenuItem | null) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const chosen = items.find((x) => x.id === value);
  const term = q.trim().toLowerCase();
  const found = items.filter((x) => !x.isCombo && (!term || x.name.toLowerCase().includes(term) || (x.erpItemCode ?? "").toLowerCase().includes(term))).slice(0, 50);
  const pick = (it: MenuItem | null) => { onChange(it); setOpen(false); setQ(""); };
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ(""); }}>
      <PopoverTrigger render={
        <button type="button" aria-label="Menu item" className="flex h-8 min-w-0 items-center rounded-lg border border-input bg-card px-2 text-left text-sm dark:bg-input/30">
          <span className={cn("min-w-0 flex-1 truncate", !chosen && "text-muted-foreground")}>{chosen ? chosen.name : "Not an item"}</span>
          {chosen?.erpItemCode && <span className="ml-1.5 shrink-0 text-xs text-muted-foreground tabular-nums">{chosen.erpItemCode}</span>}
        </button>
      } />
      <PopoverContent align="start" className="w-80 gap-1.5 p-1.5">
        <Input autoFocus value={q} placeholder="Search name or item code" onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (found[0]) pick(found[0]); } }} />
        <div className="max-h-64 overflow-y-auto">
          {!term && <button type="button" onClick={() => pick(null)} className="w-full rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted">Not an item</button>}
          {found.map((x) => (
            <button key={x.id} type="button" onClick={() => pick(x)}
              className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted", x.id === value && "bg-muted")}>
              <span className="min-w-0 flex-1 truncate">{x.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{x.erpItemCode ?? "No item code"}</span>
            </button>
          ))}
          {!found.length && <div className="px-2 py-3 text-center text-sm text-muted-foreground">No item matches.</div>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function GroupDialog({ value, items, currency, onClose, onSaved }: { value: ModifierGroup | "new" | null; items: MenuItem[]; currency: string; onClose: () => void; onSaved: () => void }) {
  const [recipeFor, setRecipeFor] = useState<RecipeTarget | null>(null);
  type Opt = { id?: string; name: string; price: string; itemId: string };
  const [name, setName] = useState("");
  const [min, setMin] = useState(0);
  const [max, setMax] = useState(1);
  const [opts, setOpts] = useState<Opt[]>([]);
  const [seen, setSeen] = useState<typeof value>(null);
  if (value !== seen) {
    setSeen(value);
    const g = value && value !== "new" ? value : null;
    setName(g?.name ?? ""); setMin(g?.minSelect ?? 0); setMax(g?.maxSelect ?? 1);
    setOpts(g ? g.options.filter((o) => o.isActive).map((o) => ({ id: o.id, name: o.name, price: String(o.price), itemId: o.itemId ?? "" })) : [{ name: "", price: "0", itemId: "" }, { name: "", price: "0", itemId: "" }]);
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const body = { name, minSelect: min, maxSelect: max, options: opts.filter((o) => o.name.trim()).map((o) => ({ id: o.id ?? null, name: o.name, price: Number(o.price || 0), itemId: o.itemId || null })) };
    try {
      if (value === "new") await api("/menu/modifier-groups", "POST", body); else await api(`/menu/modifier-groups/${(value as ModifierGroup).id}`, "PUT", body);
      toast.success("Option group saved."); onSaved(); onClose();
    } catch (err) { toast.error((err as Error).message); }
  }
  const required = min > 0;
  return (
    <Dialog open={!!value} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto sm:max-w-lg">
        <form onSubmit={save} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{value === "new" ? "New option group" : `Options · ${name}`}</DialogTitle>
            <DialogDescription>e.g. Size (required, one), Extras (optional, up to 3).</DialogDescription>
          </DialogHeader>
          <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Must choose">
              <Segmented id="grp-req" value={required ? "yes" : "no"} onChange={(v) => { setMin(v === "yes" ? 1 : 0); if (v === "yes" && max < 1) setMax(1); }} className="w-full"
                options={[{ value: "no", label: "Optional" }, { value: "yes", label: "Required" }]} />
            </Field>
            <Field label="At most">
              <div className="flex h-10 items-center rounded-xl border bg-card">
                <button type="button" className="flex size-10 items-center justify-center text-muted-foreground" onClick={() => setMax(Math.max(Math.max(1, min), max - 1))}>−</button>
                <span className="flex-1 text-center font-semibold tabular-nums">{max}</span>
                <button type="button" className="flex size-10 items-center justify-center text-muted-foreground" onClick={() => setMax(Math.min(20, max + 1))}>+</button>
              </div>
            </Field>
          </div>
          <div className="space-y-2">
            <div className="text-[0.8rem] font-medium text-foreground/80">Options</div>
            <p className="text-xs text-muted-foreground">For a combo, every option must be a menu item: the kitchen gets that item, and FACTS gets it with its item code at the price here (its price in the combo; it starts at the item&apos;s menu price). Otherwise the price is the upcharge.</p>
            {opts.map((o, i) => (
              <div key={o.id ?? `new-${i}`} className="grid grid-cols-[1fr_9rem_6rem_auto_auto] gap-2">
                <Input value={o.name} placeholder={`Option ${i + 1}`} onChange={(e) => setOpts(opts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <ItemPicker items={items} value={o.itemId}
                  onChange={(it) => setOpts(opts.map((x, j) => (j === i ? { ...x, itemId: it?.id ?? "", name: x.name.trim() || !it ? x.name : it.name,
                    price: it && !Number(x.price) ? String(it.branchPrice ?? it.price) : x.price } : x)))} />
                <Input value={o.price} inputMode="decimal" aria-label="Extra price" onChange={(e) => setOpts(opts.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
                <Button type="button" variant="ghost" size="icon" disabled={!o.id} title={o.id ? "Recipe: what this option adds (e.g. extra cheese)" : "Save the group first"}
                  aria-label="Option recipe" onClick={() => o.id && setRecipeFor({ kind: "option", id: o.id, name: o.name })}><CookingPotIcon /></Button>
                <Button type="button" variant="ghost" size="icon" aria-label="Remove option" onClick={() => setOpts(opts.filter((_, j) => j !== i))}><Trash2Icon /></Button>
              </div>
            ))}
            <Button type="button" variant="outline" onClick={() => setOpts([...opts, { name: "", price: "0", itemId: "" }])}><PlusIcon /> Add option</Button>
            <p className="text-xs text-muted-foreground">An option linked to a menu item uses that item&apos;s recipe unless it has its own.</p>
          </div>
          <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button type="submit" disabled={!name.trim() || !opts.some((o) => o.name.trim())}>Save</Button></DialogFooter>
        </form>
        <RecipeDialog target={recipeFor} currency={currency} onClose={() => setRecipeFor(null)} />
      </DialogContent>
    </Dialog>
  );
}

/** The item's photo: shown as on the register tile; tap to take or choose one (tablets open the camera), or remove it. */
function PhotoPicker({ current, name, onPick, onRemove }: { current: string | null; name: string; onPick: (f: File) => void; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-4 rounded-2xl border p-3">
      <div className="relative h-24 w-32 shrink-0 overflow-hidden rounded-xl bg-mod-grad" data-module="inv">
        {current
          // eslint-disable-next-line @next/next/no-img-element -- preview of a local or same-origin photo
          ? <img src={current} alt="" className="animate-tab-in size-full object-cover" />
          : <span className="flex size-full items-center justify-center font-heading text-2xl font-semibold text-white/90">{initials(name)}</span>}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="text-sm font-medium">Photo</div>
        <p className="text-xs text-muted-foreground">Shown on the register tile. Square or landscape works best; it&apos;s shrunk automatically.</p>
        <div className="flex flex-wrap gap-2">
          <label className="inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-lg border bg-card px-3 text-sm font-medium transition-colors hover:bg-muted">
            <CameraIcon className="size-4" /> {current ? "Replace" : "Add photo"}
            <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ""; }} />
          </label>
          {current && <Button type="button" variant="ghost" className="h-10" onClick={onRemove}><ImageOffIcon /> Remove</Button>}
        </div>
      </div>
    </div>
  );
}
