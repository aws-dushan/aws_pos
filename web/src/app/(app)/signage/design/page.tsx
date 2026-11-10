"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowDownIcon, ArrowLeftIcon, ArrowUpIcon, CopyIcon, EyeIcon, EyeOffIcon, Loader2Icon, PaletteIcon, PlayIcon, PlusIcon, RotateCcwIcon,
  SaveIcon, SquareIcon, Trash2Icon, XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  ANIMS, DAY_NAMES, FONTS, LAYOUTS, PALETTES, TRANSITIONS, newId, newSlide, normalize, slideItems,
  type Anim, type Ambient, type DesignContent, type FontKey, type Layout, type PaletteKey, type PlayData, type Slide, type Speed, type Theme, type Transition,
} from "@/lib/signage";
import { confirmDialog } from "@/components/confirm";
import { ErrorNote, Field, LoadingRows, Segmented, Switch, selectClass } from "@/components/kit";
import { SignageStage } from "@/components/signage/stage";
import { previewUrls } from "@/components/signage/preview";
import { MediaThumb, UploadButton, type MediaRow } from "@/components/signage/media";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Loaded = { id: string; branchId: string | null; name: string; content: DesignContent; updatedAt: string };
type Overview = { media: MediaRow[] };

const TAGS = ["", "Bestseller", "New", "Hot", "Chef's pick", "Limited", "Vegan", "Spicy"];

/**
 * The TV design editor: the slides in order on the left (add, reorder, copy, switch off, delete), the live preview in the middle
 * (exactly what the TV plays, with the branch's menu), and the selected slide's or the theme's settings on the right.
 */
export default function DesignEditorPage() {
  return <Suspense fallback={<LoadingRows />}><Loader /></Suspense>;
}

function Loader() {
  const id = useSearchParams().get("id");
  const loaded = useApi<Loaded>(id ? `/signage/designs/${id}` : null);
  if (!id) return <ErrorNote message="No design chosen. Open one from TV screens." />;
  if (loaded.error && !loaded.data) return <ErrorNote message={loaded.error} />;
  if (!loaded.data) return <LoadingRows />;
  return <Editor key={loaded.data.id} initial={loaded.data} />;
}

function Editor({ initial }: { initial: Loaded }) {
  const id = initial.id;
  const preview = useApi<PlayData>("/signage/preview-data");
  const overview = useApi<Overview>("/signage");

  const [name, setName] = useState(initial.name);
  const [allBranches, setAllBranches] = useState(initial.branchId === null);
  const [content, setContent] = useState<DesignContent>(() => normalize(initial.content));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<string | null>(() => normalize(initial.content).slides[0]?.id ?? null);
  const [tab, setTab] = useState<"slide" | "theme">("slide");
  const [playAll, setPlayAll] = useState(false);
  const [replay, setReplay] = useState(0);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const change = useCallback((f: (c: DesignContent) => DesignContent) => { setContent((c) => f(c)); setDirty(true); }, []);
  const setSlide = useCallback((sid: string, patch: Partial<Slide>) => {
    change((c) => ({ ...c, slides: c.slides.map((s) => (s.id === sid ? { ...s, ...patch } : s)) }));
    setReplay((r) => r + 1);
  }, [change]);
  const setTheme = useCallback((patch: Partial<Theme>) => { change((c) => ({ ...c, theme: { ...c.theme, ...patch } })); setReplay((r) => r + 1); }, [change]);

  const save = useCallback(async () => {
    if (!name.trim()) { toast.error("Give the design a name."); return; }
    setSaving(true);
    try { await api(`/signage/designs/${id}`, "PUT", { name: name.trim(), content, allBranches }); setDirty(false); toast.success("Saved. TVs playing it change within a few seconds."); }
    catch (e) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  }, [id, content, name, allBranches]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [save]);

  const media = useMemo(() => overview.data?.media ?? [], [overview.data]);
  const data = preview.data ?? null;
  const urls = useMemo(() => previewUrls(data, media.filter((m) => m.kind === "video").map((m) => m.id)), [data, media]);
  const slide = content?.slides.find((s) => s.id === selected) ?? null;

  const move = (sid: string, by: number) => change((c) => {
    const i = c.slides.findIndex((s) => s.id === sid), j = i + by;
    if (i < 0 || j < 0 || j >= c.slides.length) return c;
    const slides = [...c.slides]; [slides[i], slides[j]] = [slides[j], slides[i]];
    return { ...c, slides };
  });
  const duplicate = (s: Slide) => { const copy = { ...s, id: newId() }; change((c) => { const i = c.slides.findIndex((x) => x.id === s.id); const slides = [...c.slides]; slides.splice(i + 1, 0, copy); return { ...c, slides }; }); setSelected(copy.id); };
  const remove = async (s: Slide) => {
    if (!(await confirmDialog({ title: "Delete this slide?", confirmLabel: "Delete", tone: "danger" }))) return;
    change((c) => ({ ...c, slides: c.slides.filter((x) => x.id !== s.id) }));
    if (selected === s.id) setSelected(content.slides.find((x) => x.id !== s.id)?.id ?? null);
  };
  const add = (layout: Layout) => { const s = newSlide(layout, data); change((c) => ({ ...c, slides: [...c.slides, s] })); setSelected(s.id); setTab("slide"); setAdding(false); };

  return (
    <div className="mx-auto max-w-[1500px] space-y-4 pb-10">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="icon" nativeButton={false} render={<Link href="/signage" />} aria-label="Back to TV screens"><ArrowLeftIcon /></Button>
        <Input value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} maxLength={80} className="h-9 w-64 text-base font-semibold" aria-label="Design name" />
        <label className="flex items-center gap-2 text-sm"><Switch on={allBranches} onChange={(v) => { setAllBranches(v); setDirty(true); }} label="All branches" />All branches</label>
        <div className="flex-1" />
        {dirty && <span className="text-xs text-muted-foreground">Not saved</span>}
        <Button size="lg" onClick={() => void save()} disabled={saving || !dirty}>{saving ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}Save</Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[230px_minmax(0,1fr)_340px]">
        {/* Slides */}
        <aside className="surface h-max space-y-2 p-3">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-sm font-semibold">Slides</h2>
            <span className="text-xs text-muted-foreground">{content.slides.reduce((n, s) => n + (s.enabled ? s.seconds : 0), 0)} s loop</span>
          </div>
          <ol className="space-y-1.5">
            {content.slides.map((s, i) => (
              <li key={s.id}>
                <div role="button" tabIndex={0} onClick={() => { setSelected(s.id); setTab("slide"); setPlayAll(false); setReplay((r) => r + 1); }}
                  onKeyDown={(e) => { if (e.key === "Enter") setSelected(s.id); }}
                  className={cn("group rounded-lg border px-2.5 py-2 text-left transition-colors", selected === s.id ? "border-primary bg-primary/5" : "hover:bg-muted", !s.enabled && "opacity-50")}>
                  <div className="flex items-center gap-2">
                    <span className="grid size-5 place-items-center rounded bg-muted text-[0.7rem] font-semibold tabular-nums">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{slideLabel(s, data)}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                    <span className="flex-1">{LAYOUTS[s.layout].label} · {s.seconds}s{s.schedule ? " · timed" : ""}</span>
                    <IconBtn label="Move up" onClick={() => move(s.id, -1)} disabled={i === 0}><ArrowUpIcon /></IconBtn>
                    <IconBtn label="Move down" onClick={() => move(s.id, 1)} disabled={i === content.slides.length - 1}><ArrowDownIcon /></IconBtn>
                    <IconBtn label={s.enabled ? "Switch off" : "Switch on"} onClick={() => setSlide(s.id, { enabled: !s.enabled })}>{s.enabled ? <EyeIcon /> : <EyeOffIcon />}</IconBtn>
                    <IconBtn label="Copy" onClick={() => duplicate(s)}><CopyIcon /></IconBtn>
                    <IconBtn label="Delete" onClick={() => void remove(s)}><Trash2Icon /></IconBtn>
                  </div>
                </div>
              </li>
            ))}
          </ol>
          {adding ? (
            <div className="space-y-1 rounded-lg border p-1.5">
              {(Object.keys(LAYOUTS) as Layout[]).map((l) => (
                <button key={l} type="button" onClick={() => add(l)} className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-muted">
                  <div className="text-sm font-medium">{LAYOUTS[l].label}</div>
                  <div className="text-xs text-muted-foreground">{LAYOUTS[l].hint}</div>
                </button>
              ))}
              <Button variant="ghost" size="sm" className="w-full" onClick={() => setAdding(false)}><XIcon />Cancel</Button>
            </div>
          ) : content.slides.length < 40 && <Button variant="outline" className="w-full" onClick={() => setAdding(true)}><PlusIcon />Add slide</Button>}
          <Button variant={tab === "theme" ? "secondary" : "ghost"} className="w-full justify-start" onClick={() => setTab("theme")}><PaletteIcon />Theme, ticker and clock</Button>
        </aside>

        {/* Preview */}
        <div className="min-w-0 space-y-2">
          <div className="overflow-hidden rounded-xl bg-black shadow-lg ring-1 ring-border">
            <SignageStage content={content} data={data} urls={urls} lock={playAll ? null : selected} replay={replay} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => setReplay((r) => r + 1)} disabled={playAll}><RotateCcwIcon />Replay animation</Button>
            <Button variant={playAll ? "secondary" : "outline"} onClick={() => setPlayAll((p) => !p)}>{playAll ? <SquareIcon /> : <PlayIcon />}{playAll ? "Stop" : "Play the loop"}</Button>
            <span className="text-xs text-muted-foreground">
              {playAll ? "As the TV plays it now: slides outside their times or past their end are skipped." : "Showing the selected slide. Prices, photos and counts are this branch's, live."}
            </span>
          </div>
          {preview.error && <ErrorNote message={preview.error} />}
        </div>

        {/* Settings */}
        <aside className="surface h-max space-y-4 p-4">
          {tab === "theme" ? <ThemePanel theme={content.theme} set={setTheme} /> : slide ? (
            <SlidePanel s={slide} set={(p) => setSlide(slide.id, p)} data={data} media={media} companyId={data?.companyId ?? null} onMedia={overview.reload} />
          ) : <p className="text-sm text-muted-foreground">Add a slide to start.</p>}
        </aside>
      </div>
    </div>
  );
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="grid size-6 place-items-center rounded hover:bg-background disabled:opacity-30 [&_svg]:size-3.5">{children}</button>
  );
}

function slideLabel(s: Slide, data: PlayData | null) {
  const item = s.itemId ? data?.items.find((i) => i.id === s.itemId) : null;
  return s.title || item?.name || s.kicker || LAYOUTS[s.layout].label;
}

const num = (v: string) => (v.trim() === "" ? null : Number(v));

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 border-t pt-4 first:border-0 first:pt-0">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </div>
  );
}

function SlidePanel({ s, set, data, media, companyId, onMedia }: {
  s: Slide; set: (p: Partial<Slide>) => void; data: PlayData | null; media: MediaRow[]; companyId: string | null; onMedia: () => void;
}) {
  const L = s.layout;
  return (
    <>
      <Section title={`${LAYOUTS[L].label} slide`}>
        <p className="-mt-1 text-xs text-muted-foreground">{LAYOUTS[L].hint}</p>
        {(L === "hero" || L === "offer" || L === "fresh") && (
          <Field label={L === "hero" ? "Item" : "Item (photo and price)"}>
            <ItemSelect value={s.itemId ?? null} data={data} onChange={(itemId) => set({ itemId })} />
          </Field>
        )}
        {L !== "grid" && L !== "list" && L !== "media" && <Field label="Small heading"><Input value={s.kicker ?? ""} onChange={(e) => set({ kicker: e.target.value })} maxLength={50} /></Field>}
        <Field label={L === "hero" ? "Title (empty: the item's name)" : L === "media" ? "Caption" : "Title"}><Input value={s.title ?? ""} onChange={(e) => set({ title: e.target.value })} maxLength={60} /></Field>
        {L !== "media" && <Field label="Title in Arabic"><Input dir="rtl" value={s.titleAr ?? ""} onChange={(e) => set({ titleAr: e.target.value })} maxLength={60} /></Field>}
        {(L === "offer" || L === "media") && <Field label="Text"><Textarea value={s.text ?? ""} onChange={(e) => set({ text: e.target.value })} maxLength={160} rows={2} /></Field>}
      </Section>

      {L === "hero" && (
        <Section title="Extras">
          <Field label="Words under the title" hint="Separate with commas, e.g. Double shot, Sweet and creamy">
            <Input value={(s.words ?? []).join(", ")} onChange={(e) => set({ words: e.target.value.split(",").map((w) => w.trimStart()).slice(0, 5) })} />
          </Field>
          <Field label="Badge" hint="A spinning star, e.g. No. 1 or New"><Input value={s.badge ?? ""} onChange={(e) => set({ badge: e.target.value })} maxLength={12} /></Field>
          <Toggle label="Show how many sold today (live)" on={!!s.showSoldToday} set={(v) => set({ showSoldToday: v })} />
        </Section>
      )}

      {L === "offer" && (
        <Section title="Deal">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Offer price" hint="Empty: menu price"><Input type="number" min={0} step="0.25" value={s.price ?? ""} onChange={(e) => set({ price: num(e.target.value) })} /></Field>
            <Field label="Was"><Input type="number" min={0} step="0.25" value={s.oldPrice ?? ""} onChange={(e) => set({ oldPrice: num(e.target.value) })} /></Field>
          </div>
          <Field label="Ends at (today)" hint="A countdown shows; after this time the slide stops playing. Empty: no countdown.">
            <Input type="time" value={s.endsAt ?? ""} onChange={(e) => set({ endsAt: e.target.value || null })} />
          </Field>
          <MediaPick label="Picture instead of the item's photo" value={s.mediaId ?? null} media={media} companyId={companyId} set={(mediaId) => set({ mediaId })} onMedia={onMedia} />
        </Section>
      )}

      {L === "fresh" && (
        <Section title="Fresh now">
          <Field label="Rolling words" hint="Separate with commas (up to 5)">
            <Input value={(s.words ?? []).join(", ")} onChange={(e) => set({ words: e.target.value.split(",").map((w) => w.trimStart()).slice(0, 5) })} />
          </Field>
          <Field label="Next batch at"><Input type="time" value={s.nextAt ?? ""} onChange={(e) => set({ nextAt: e.target.value || null })} /></Field>
          <div className="grid grid-cols-[1fr_96px] gap-3">
            <Field label="Add-on line"><Input value={s.upsell ?? ""} onChange={(e) => set({ upsell: e.target.value })} maxLength={50} /></Field>
            <Field label="Price"><Input type="number" min={0} step="0.25" value={s.upsellPrice ?? ""} onChange={(e) => set({ upsellPrice: num(e.target.value) })} /></Field>
          </div>
          <MediaPick label="Picture instead of the item's photo" value={s.mediaId ?? null} media={media} companyId={companyId} set={(mediaId) => set({ mediaId })} onMedia={onMedia} />
        </Section>
      )}

      {(L === "grid" || L === "list") && (
        <Section title="Items">
          <Segmented id={`src-${s.id}`} value={s.source ?? "category"} onChange={(v) => set({ source: v })} options={[{ value: "category", label: "A category" }, { value: "items", label: "Pick items" }]} />
          {(s.source ?? "category") === "category" ? (
            <Field label="Category">
              <select className={selectClass} value={s.categoryId ?? ""} onChange={(e) => {
                const cat = data?.categories.find((c) => c.id === e.target.value);
                set({ categoryId: e.target.value || null, ...(cat ? { title: cat.name, titleAr: cat.nameAr ?? "" } : {}) });
              }}>
                <option value="">Choose…</option>
                {data?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
          ) : (
            <ItemsPick ids={s.itemIds ?? []} data={data} max={L === "grid" ? 12 : 16} set={(itemIds) => set({ itemIds })} />
          )}
          {L === "grid" && (
            <>
              <Field label="Cards per row"><Segmented id={`cols-${s.id}`} value={String(s.columns ?? 3) as "2" | "3" | "4"} onChange={(v) => set({ columns: Number(v) as 2 | 3 | 4 })} options={[{ value: "2", label: "2" }, { value: "3", label: "3" }, { value: "4", label: "4" }]} /></Field>
              <Toggle label="Photos" on={s.showPhotos !== false} set={(v) => set({ showPhotos: v })} />
              <Toggle label="Spotlight one item at a time" on={!!s.spotlight} set={(v) => set({ spotlight: v })} />
            </>
          )}
          <Toggle label="Hide sold-out items" on={!!s.hideSoldOut} set={(v) => set({ hideSoldOut: v })} />
          <TagsEdit s={s} data={data} set={set} />
        </Section>
      )}

      {L === "media" && (
        <Section title="Picture or video">
          <MediaPick label="Shown full screen" value={s.mediaId ?? null} media={media} companyId={companyId} set={(mediaId) => set({ mediaId })} onMedia={onMedia} />
        </Section>
      )}

      <Section title="Motion">
        <Field label="Animation">
          <div className="grid grid-cols-4 gap-1.5">
            {(Object.keys(ANIMS) as Anim[]).map((a) => (
              <button key={a} type="button" onClick={() => set({ animation: a })}
                className={cn("rounded-md border px-1 py-1.5 text-xs font-medium", s.animation === a ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted")}>{ANIMS[a]}</button>
            ))}
          </div>
        </Field>
        <Field label="Speed"><Segmented id={`spd-${s.id}`} value={s.speed} onChange={(v: Speed) => set({ speed: v })} options={[{ value: "slow", label: "Slow" }, { value: "normal", label: "Normal" }, { value: "fast", label: "Fast" }]} /></Field>
        <Field label={`On screen for ${s.seconds} seconds`}>
          <input type="range" min={4} max={60} value={s.seconds} onChange={(e) => set({ seconds: Number(e.target.value) })} className="w-full accent-[var(--primary)]" />
        </Field>
      </Section>

      <Section title="Background">
        <Segmented id={`bg-${s.id}`} value={s.background.kind} onChange={(kind) => set({ background: { ...s.background, kind } })}
          options={[{ value: "theme", label: "Theme" }, { value: "color", label: "Colour" }, { value: "media", label: "Picture" }]} />
        {s.background.kind === "color" && (
          <input type="color" value={s.background.color ?? "#000000"} onChange={(e) => set({ background: { ...s.background, color: e.target.value } })} className="h-9 w-full cursor-pointer rounded-md border" aria-label="Background colour" />
        )}
        {s.background.kind === "media" && (
          <>
            <MediaPick label="Background" value={s.background.mediaId ?? null} media={media} companyId={companyId} set={(mediaId) => set({ background: { ...s.background, mediaId } })} onMedia={onMedia} />
            <Field label={`Darken ${s.background.dim ?? 40}%`} hint="Keeps the text readable over the picture">
              <input type="range" min={0} max={85} value={s.background.dim ?? 40} onChange={(e) => set({ background: { ...s.background, dim: Number(e.target.value) } })} className="w-full accent-[var(--primary)]" />
            </Field>
          </>
        )}
      </Section>

      <Section title="When it plays">
        <Segmented id={`when-${s.id}`} value={s.schedule ? "set" : "always"} onChange={(v) => set({ schedule: v === "always" ? null : { days: [0, 1, 2, 3, 4, 5, 6], from: "06:00", to: "11:00" } })}
          options={[{ value: "always", label: "All day" }, { value: "set", label: "Set times" }]} />
        {s.schedule && (
          <>
            <div className="flex flex-wrap gap-1">
              {DAY_NAMES.map((d, i) => {
                const on = s.schedule!.days.includes(i);
                return (
                  <button key={d} type="button" onClick={() => set({ schedule: { ...s.schedule!, days: on ? s.schedule!.days.filter((x) => x !== i) : [...s.schedule!.days, i].sort() } })}
                    className={cn("rounded-md border px-2 py-1 text-xs font-medium", on ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted")}>{d}</button>
                );
              })}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="From"><Input type="time" value={s.schedule.from} onChange={(e) => set({ schedule: { ...s.schedule!, from: e.target.value } })} /></Field>
              <Field label="To"><Input type="time" value={s.schedule.to} onChange={(e) => set({ schedule: { ...s.schedule!, to: e.target.value } })} /></Field>
            </div>
            <p className="text-xs text-muted-foreground">The branch&apos;s time. Outside these times the TV skips this slide.</p>
          </>
        )}
      </Section>
    </>
  );
}

function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return <label className="flex items-center justify-between gap-3 text-sm"><span>{label}</span><Switch on={on} onChange={set} label={label} /></label>;
}

function ItemSelect({ value, data, onChange }: { value: string | null; data: PlayData | null; onChange: (id: string | null) => void }) {
  return (
    <select className={selectClass} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">Choose an item…</option>
      {data?.categories.map((c) => {
        const items = data.items.filter((i) => i.categoryId === c.id);
        return items.length ? <optgroup key={c.id} label={c.name}>{items.map((i) => <option key={i.id} value={i.id}>{i.name} · {i.price}</option>)}</optgroup> : null;
      })}
    </select>
  );
}

function ItemsPick({ ids, data, max, set }: { ids: string[]; data: PlayData | null; max: number; set: (ids: string[]) => void }) {
  const items = ids.map((id) => data?.items.find((i) => i.id === id)).filter((i) => !!i);
  return (
    <div className="space-y-2">
      <ol className="space-y-1">
        {items.map((i, k) => (
          <li key={i!.id} className="flex items-center gap-1 rounded-md bg-muted/60 px-2 py-1 text-sm">
            <span className="min-w-0 flex-1 truncate">{i!.name}</span>
            <IconBtn label="Move up" disabled={k === 0} onClick={() => { const n = [...ids]; [n[k - 1], n[k]] = [n[k], n[k - 1]]; set(n); }}><ArrowUpIcon /></IconBtn>
            <IconBtn label="Remove" onClick={() => set(ids.filter((x) => x !== i!.id))}><XIcon /></IconBtn>
          </li>
        ))}
      </ol>
      {ids.length < max && <ItemSelect value={null} data={data} onChange={(id) => { if (id && !ids.includes(id)) set([...ids, id]); }} />}
      <p className="text-xs text-muted-foreground">Up to {max} items, in this order.</p>
    </div>
  );
}

function TagsEdit({ s, data, set }: { s: Slide; data: PlayData | null; set: (p: Partial<Slide>) => void }) {
  const items = slideItems(s, data, s.layout === "grid" ? 12 : 16);
  if (!items.length) return null;
  return (
    <details className="rounded-md border px-2.5 py-2">
      <summary className="cursor-pointer text-sm font-medium">Tags on items ({Object.values(s.tags ?? {}).filter(Boolean).length})</summary>
      <div className="mt-2 space-y-1.5">
        {items.map((i) => (
          <div key={i.id} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate">{i.name}</span>
            <select className={cn(selectClass, "w-32")} value={s.tags?.[i.id] ?? ""} onChange={(e) => set({ tags: { ...(s.tags ?? {}), [i.id]: e.target.value } })}>
              {TAGS.map((t) => <option key={t} value={t}>{t || "No tag"}</option>)}
            </select>
          </div>
        ))}
      </div>
    </details>
  );
}

function MediaPick({ label, value, media, companyId, set, onMedia }: {
  label: string; value: string | null; media: MediaRow[]; companyId: string | null; set: (id: string | null) => void; onMedia: () => void;
}) {
  return (
    <Field label={label}>
      <div className="space-y-2">
        <div className="grid grid-cols-3 gap-1.5">
          {media.map((m) => <MediaThumb key={m.id} m={m} companyId={companyId} picked={m.id === value} onPick={() => set(m.id === value ? null : m.id)} />)}
        </div>
        <div className="flex gap-2">
          <UploadButton label="Upload" onDone={(row) => { onMedia(); set(row.id); }} />
          {value && <Button variant="ghost" onClick={() => set(null)}><XIcon />None</Button>}
        </div>
      </div>
    </Field>
  );
}

function ThemePanel({ theme, set }: { theme: Theme; set: (p: Partial<Theme>) => void }) {
  const c = theme.colors;
  return (
    <>
      <Section title="Colours">
        <div className="grid grid-cols-3 gap-1.5">
          {(Object.keys(PALETTES) as Exclude<PaletteKey, "custom">[]).map((k) => {
            const p = PALETTES[k];
            return (
              <button key={k} type="button" onClick={() => set({ palette: k, colors: { ...p.colors } })}
                className={cn("overflow-hidden rounded-md border text-left text-xs font-medium", theme.palette === k && "ring-2 ring-primary")}>
                <div className="flex h-7" style={{ background: p.colors.bg }}>
                  <span className="m-1.5 w-3 rounded-full" style={{ background: p.colors.accent }} />
                  <span className="my-1.5 w-3 rounded-full" style={{ background: p.colors.hot }} />
                </div>
                <div className="px-1.5 py-1">{p.label}</div>
              </button>
            );
          })}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {([["bg", "Background"], ["bg2", "Glow"], ["text", "Text"], ["accent", "Prices"], ["hot", "Highlights"], ["muted", "Soft text"]] as const).map(([k, l]) => (
            <label key={k} className="space-y-1 text-xs text-muted-foreground">
              <span className="block">{l}</span>
              <input type="color" value={c[k]} onChange={(e) => set({ palette: "custom", colors: { ...c, [k]: e.target.value } })} className="h-8 w-full cursor-pointer rounded border" />
            </label>
          ))}
        </div>
      </Section>
      <Section title="Lettering">
        <div className="grid grid-cols-2 gap-1.5">
          {(Object.keys(FONTS) as FontKey[]).map((f) => (
            <button key={f} type="button" onClick={() => set({ font: f })} className={cn("rounded-md border px-2 py-1.5 text-sm", theme.font === f ? "border-primary bg-primary/10" : "hover:bg-muted")}>{FONTS[f]}</button>
          ))}
        </div>
        <Toggle label="Arabic names" on={theme.arabic} set={(arabic) => set({ arabic })} />
      </Section>
      <Section title="Between slides">
        <div className="grid grid-cols-3 gap-1.5">
          {(Object.keys(TRANSITIONS) as Transition[]).map((t) => (
            <button key={t} type="button" onClick={() => set({ transition: t })} className={cn("rounded-md border px-1 py-1.5 text-xs font-medium", theme.transition === t ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted")}>{TRANSITIONS[t]}</button>
          ))}
        </div>
        <Field label="Background movement">
          <Segmented id="ambient" value={theme.ambient} onChange={(ambient: Ambient) => set({ ambient })} options={[{ value: "glow", label: "Glow" }, { value: "rays", label: "Glow + rays" }, { value: "none", label: "Still" }]} />
        </Field>
      </Section>
      <Section title="Bottom strip">
        <Toggle label="Logo and branch name" on={theme.showLogo} set={(showLogo) => set({ showLogo })} />
        <Toggle label="Clock" on={theme.showClock} set={(showClock) => set({ showClock })} />
        <Toggle label="Scrolling messages" on={theme.ticker.on} set={(on) => set({ ticker: { ...theme.ticker, on } })} />
        {theme.ticker.on && (
          <>
            <Field label="Messages" hint="One per line">
              <Textarea rows={4} value={theme.ticker.messages.join("\n")} onChange={(e) => set({ ticker: { ...theme.ticker, messages: e.target.value.split("\n").slice(0, 12) } })} />
            </Field>
            <Field label={`One pass every ${theme.ticker.seconds} seconds`}>
              <input type="range" min={12} max={90} value={theme.ticker.seconds} onChange={(e) => set({ ticker: { ...theme.ticker, seconds: Number(e.target.value) } })} className="w-full accent-[var(--primary)]" />
            </Field>
          </>
        )}
      </Section>
    </>
  );
}
