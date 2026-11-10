"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowDownIcon, ArrowLeftIcon, ArrowUpIcon, CopyIcon, EyeIcon, EyeOffIcon, Loader2Icon, PaletteIcon, PlayIcon, PlusIcon, RotateCcwIcon,
  ImagePlusIcon, SaveIcon, SquareIcon, Trash2Icon, XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  ANIMS, DAY_NAMES, FONTS, LAYOUTS, PALETTES, STICKER_ANIMS, TRANSITIONS, newId, newSlide, normalize, slideItems,
  type Anim, type Ambient, type DesignContent, type FontKey, type Layout, type PaletteKey, type PlayData, type Slide, type Speed, type Sticker, type StickerAnim,
  type Theme, type Transition,
} from "@/lib/signage";
import { withBase } from "@/lib/base-path";
import { confirmDialog } from "@/components/confirm";
import { ErrorNote, Field, LoadingRows, Segmented, Switch, selectClass } from "@/components/kit";
import { TvFrame } from "@/components/signage/tv-frame";
import { MediaThumb, UploadButton, type MediaRow } from "@/components/signage/media";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Loaded = { id: string; branchId: string | null; name: string; content: DesignContent; updatedAt: string };
type Overview = { media: MediaRow[] };

const TAGS = ["", "Bestseller", "New", "Hot", "Chef's pick", "Limited", "Vegan", "Spicy"];

/**
 * The TV design editor: the slides in order on the left (add, reorder, copy, switch off, delete), the live preview in the middle
 * (the TV player itself, with the branch's menu; pictures placed on a slide are dragged into place there), and the selected
 * slide's or the theme's settings on the right.
 */

/** Layouts that are older and take the Animation choice; the newer ones have their own built-in motion. */
const CLASSIC: Layout[] = ["hero", "offer", "grid", "list", "fresh", "media"];
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
  const [sticker, setSticker] = useState<string | null>(null);

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
  const slide = content?.slides.find((s) => s.id === selected) ?? null;
  // Dragging a placed picture changes the design many times a second: keep the animation still while it moves.
  const moveSticker = useCallback((sid: string, kid: string, x: number, y: number) => {
    change((c) => ({ ...c, slides: c.slides.map((s) => (s.id === sid ? { ...s, stickers: (s.stickers ?? []).map((k) => (k.id === kid ? { ...k, x, y } : k)) } : s)) }));
  }, [change]);

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
            <TvFrame content={content} data={data} lock={playAll ? null : selected} replay={replay}>
              {!playAll && slide && (slide.stickers?.length ?? 0) > 0 && (
                <StickerLayer slide={slide} picked={sticker} onPick={setSticker} onMove={(kid, x, y) => moveSticker(slide.id, kid, x, y)} onDrop={() => setReplay((r) => r + 1)} />
              )}
            </TvFrame>
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
            <SlidePanel s={slide} set={(p) => setSlide(slide.id, p)} data={data} media={media} companyId={data?.companyId ?? null} onMedia={overview.reload}
              sticker={sticker} setSticker={setSticker} />
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

function SlidePanel({ s, set, data, media, companyId, onMedia, sticker, setSticker }: {
  s: Slide; set: (p: Partial<Slide>) => void; data: PlayData | null; media: MediaRow[]; companyId: string | null; onMedia: () => void;
  sticker: string | null; setSticker: (id: string | null) => void;
}) {
  const L = s.layout;
  const oneItem = L === "hero" || L === "offer" || L === "fresh" || L === "zoom" || L === "kinetic" || L === "flash";
  const pickMax = L === "combo" ? 3 : L === "versus" ? 2 : L === "polaroid" ? 4 : L === "story" ? 3 : L === "top5" ? 5 : 0;
  return (
    <>
      <Section title={`${LAYOUTS[L].label} slide`}>
        <p className="-mt-1 text-xs text-muted-foreground">{LAYOUTS[L].hint}</p>
        {oneItem && (
          <Field label={L === "hero" ? "Item" : "Item (photo and price)"}>
            <ItemSelect value={s.itemId ?? null} data={data} onChange={(itemId) => set({ itemId })} />
          </Field>
        )}
        {(L === "hero" || L === "offer" || L === "fresh" || L === "zoom") && <Field label="Small heading"><Input value={s.kicker ?? ""} onChange={(e) => set({ kicker: e.target.value })} maxLength={50} /></Field>}
        {L !== "story" && <Field label={L === "hero" || L === "zoom" || L === "kinetic" ? "Title (empty: the item's name)" : L === "media" ? "Caption" : L === "versus" ? "Question at the top" : "Title"}><Input value={s.title ?? ""} onChange={(e) => set({ title: e.target.value })} maxLength={60} /></Field>}
        {CLASSIC.includes(L) && L !== "media" && <Field label="Title in Arabic"><Input dir="rtl" value={s.titleAr ?? ""} onChange={(e) => set({ titleAr: e.target.value })} maxLength={60} /></Field>}
        {(L === "offer" || L === "media" || L === "kinetic") && <Field label="Text"><Textarea value={s.text ?? ""} onChange={(e) => set({ text: e.target.value })} maxLength={160} rows={2} /></Field>}
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

      {(L === "grid" || L === "list" || L === "neon") && (
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
            <ItemsPick ids={s.itemIds ?? []} data={data} max={L === "grid" ? 12 : L === "neon" ? 10 : 16} set={(itemIds) => set({ itemIds })} />
          )}
          {L === "grid" && (
            <>
              <Field label="Cards per row"><Segmented id={`cols-${s.id}`} value={String(s.columns ?? 3) as "2" | "3" | "4"} onChange={(v) => set({ columns: Number(v) as 2 | 3 | 4 })} options={[{ value: "2", label: "2" }, { value: "3", label: "3" }, { value: "4", label: "4" }]} /></Field>
              <Toggle label="Photos" on={s.showPhotos !== false} set={(v) => set({ showPhotos: v })} />
              <Toggle label="Spotlight one item at a time" on={!!s.spotlight} set={(v) => set({ spotlight: v })} />
            </>
          )}
          <Toggle label="Hide sold-out items" on={!!s.hideSoldOut} set={(v) => set({ hideSoldOut: v })} />
          {L !== "neon" && <TagsEdit s={s} data={data} set={set} />}
        </Section>
      )}

      {L === "kinetic" && (
        <Section title="Words">
          <Field label="Words that slam in" hint="Separate with commas (up to 4), e.g. Fresh, Flaky, Buttery">
            <Input value={(s.words ?? []).join(", ")} onChange={(e) => set({ words: e.target.value.split(",").map((w) => w.trimStart()).slice(0, 4) })} />
          </Field>
          <Field label="Price" hint="Empty: menu price"><Input type="number" min={0} step="0.25" value={s.price ?? ""} onChange={(e) => set({ price: num(e.target.value) })} /></Field>
        </Section>
      )}

      {L === "zoom" && (
        <Section title="Price sticker">
          <Field label="Price" hint="Empty: menu price"><Input type="number" min={0} step="0.25" value={s.price ?? ""} onChange={(e) => set({ price: num(e.target.value) })} /></Field>
        </Section>
      )}

      {(L === "flash" || L === "combo") && (
        <Section title={L === "flash" ? "Price drop" : "Combo price"}>
          <div className="grid grid-cols-2 gap-3">
            <Field label={L === "flash" ? "Now" : "Combo price"} hint={L === "flash" ? "Empty: menu price" : "Empty: the items added up"}><Input type="number" min={0} step="0.25" value={s.price ?? ""} onChange={(e) => set({ price: num(e.target.value) })} /></Field>
            <Field label="Was"><Input type="number" min={0} step="0.25" value={s.oldPrice ?? ""} onChange={(e) => set({ oldPrice: num(e.target.value) })} /></Field>
          </div>
          {L === "flash" && (
            <Field label="Ends at (today)" hint="A countdown shows; after this time the slide stops playing. Empty: no countdown.">
              <Input type="time" value={s.endsAt ?? ""} onChange={(e) => set({ endsAt: e.target.value || null })} />
            </Field>
          )}
        </Section>
      )}

      {pickMax > 0 && (
        <Section title="Items">
          {L === "top5" && <p className="-mt-1 text-xs text-muted-foreground">Empty: today&apos;s best sellers by themselves.</p>}
          {(L === "combo" || L === "polaroid" || L === "story" || L === "versus") && <p className="-mt-1 text-xs text-muted-foreground">Empty: your best sellers with photos.</p>}
          <ItemsPick ids={s.itemIds ?? []} data={data} max={pickMax} set={(itemIds) => set({ itemIds })} />
        </Section>
      )}

      {(L === "neon" || L === "versus") && (
        <Section title={L === "neon" ? "Neon sign" : "Middle badge"}>
          <Field label={L === "neon" ? "Sign at the bottom" : "Badge text"} hint={L === "neon" ? "e.g. OPEN TILL 1 AM. Empty: no sign." : "e.g. VS or OR"}>
            <Input value={s.badge ?? ""} onChange={(e) => set({ badge: e.target.value })} maxLength={24} />
          </Field>
        </Section>
      )}

      {L === "media" && (
        <Section title="Picture or video">
          <MediaPick label="Shown full screen" value={s.mediaId ?? null} media={media} companyId={companyId} set={(mediaId) => set({ mediaId })} onMedia={onMedia} />
        </Section>
      )}

      <Stickers s={s} set={set} media={media} companyId={companyId} onMedia={onMedia} picked={sticker} setPicked={setSticker} />

      <Section title="Motion">
        {CLASSIC.includes(L) ? <Field label="Animation">
          <div className="grid grid-cols-4 gap-1.5">
            {(Object.keys(ANIMS) as Anim[]).map((a) => (
              <button key={a} type="button" onClick={() => set({ animation: a })}
                className={cn("rounded-md border px-1 py-1.5 text-xs font-medium", s.animation === a ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted")}>{ANIMS[a]}</button>
            ))}
          </div>
        </Field> : <p className="text-xs text-muted-foreground">This layout has its own animation.</p>}
        {CLASSIC.includes(L) && <Field label="Speed"><Segmented id={`spd-${s.id}`} value={s.speed} onChange={(v: Speed) => set({ speed: v })} options={[{ value: "slow", label: "Slow" }, { value: "normal", label: "Normal" }, { value: "fast", label: "Fast" }]} /></Field>}
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

/** Pictures placed on the slide: add (upload or choose), size, turn, motion, remove; dragged into place on the preview. */
function Stickers({ s, set, media, companyId, onMedia, picked, setPicked }: {
  s: Slide; set: (p: Partial<Slide>) => void; media: MediaRow[]; companyId: string | null; onMedia: () => void; picked: string | null; setPicked: (id: string | null) => void;
}) {
  const list = s.stickers ?? [];
  const [choosing, setChoosing] = useState(false);
  const one = list.find((k) => k.id === picked) ?? null;
  const patch = (id: string, p: Partial<Sticker>) => set({ stickers: list.map((k) => (k.id === id ? { ...k, ...p } : k)) });
  const add = (mediaId: string) => {
    const m = media.find((x) => x.id === mediaId);
    const place = (r: number) => {
      const k: Sticker = { id: newId(), mediaId, x: 50, y: 45, w: 22, r, rotate: 0, anim: "float" };
      set({ stickers: [...list, k].slice(0, 12) }); setPicked(k.id); setChoosing(false);
    };
    if (m?.kind === "video") { place(9 / 16); return; }
    const img = new Image();
    img.onload = () => place(img.naturalWidth ? img.naturalHeight / img.naturalWidth : 1);
    img.onerror = () => place(1);
    img.src = withBase(`/api/public/signage/media/${mediaId}?co=${companyId ?? ""}`);
  };
  return (
    <Section title="Pictures on this slide">
      <p className="-mt-1 text-xs text-muted-foreground">Logos, stickers, food photos… Drag them into place on the preview.</p>
      {list.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {list.map((k, i) => (
            <button key={k.id} type="button" onClick={() => setPicked(k.id === picked ? null : k.id)}
              className={cn("rounded-md border px-2 py-1 text-xs font-medium", k.id === picked ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted")}>Picture {i + 1}</button>
          ))}
        </div>
      )}
      {one && (
        <div className="space-y-3 rounded-lg border p-3">
          <Field label={`Size ${Math.round(one.w)}% of the screen width`}>
            <input type="range" min={4} max={90} value={one.w} onChange={(e) => patch(one.id, { w: Number(e.target.value) })} className="w-full accent-[var(--primary)]" />
          </Field>
          <Field label={`Turn ${one.rotate}°`}>
            <input type="range" min={-45} max={45} value={one.rotate} onChange={(e) => patch(one.id, { rotate: Number(e.target.value) })} className="w-full accent-[var(--primary)]" />
          </Field>
          <Field label="Motion">
            <div className="grid grid-cols-5 gap-1">
              {(Object.keys(STICKER_ANIMS) as StickerAnim[]).map((a) => (
                <button key={a} type="button" onClick={() => patch(one.id, { anim: a })}
                  className={cn("rounded-md border px-1 py-1.5 text-xs font-medium", one.anim === a ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted")}>{STICKER_ANIMS[a]}</button>
              ))}
            </div>
          </Field>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => patch(one.id, { x: 50, y: 50 })}>Centre</Button>
            <Button variant="ghost" size="sm" onClick={() => { set({ stickers: list.filter((k) => k.id !== one.id) }); setPicked(null); }}><Trash2Icon />Remove</Button>
          </div>
        </div>
      )}
      {choosing ? (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-1.5">
            {media.map((m) => <MediaThumb key={m.id} m={m} companyId={companyId} onPick={() => add(m.id)} />)}
          </div>
          <div className="flex gap-2">
            <UploadButton label="Upload" onDone={(row) => { onMedia(); add(row.id); }} />
            <Button variant="ghost" onClick={() => setChoosing(false)}><XIcon />Cancel</Button>
          </div>
        </div>
      ) : list.length < 12 && <Button variant="outline" className="w-full" onClick={() => setChoosing(true)}><ImagePlusIcon />Add a picture</Button>}
    </Section>
  );
}

/** Outlines of the placed pictures over the preview; drag one to move it (its centre, in % of the screen). */
function StickerLayer({ slide, picked, onPick, onMove, onDrop }: {
  slide: Slide; picked: string | null; onPick: (id: string) => void; onMove: (id: string, x: number, y: number) => void; onDrop: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const at = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 };
  };
  const clamp = (v: number) => Math.round(Math.max(0, Math.min(100, v)) * 10) / 10;
  return (
    <div ref={box} className="absolute inset-0"
      onPointerMove={(e) => { const d = drag.current; if (!d) return; const p = at(e); onMove(d.id, clamp(p.x - d.dx), clamp(p.y - d.dy)); }}
      onPointerUp={() => { if (drag.current) { drag.current = null; onDrop(); } }}>
      {(slide.stickers ?? []).map((k) => {
        const h = k.w * (k.r || 1) * (16 / 9);
        return (
          <div key={k.id} role="button" tabIndex={-1} aria-label="Move picture"
            onPointerDown={(e) => { e.preventDefault(); (e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId); const p = at(e); drag.current = { id: k.id, dx: p.x - k.x, dy: p.y - k.y }; onPick(k.id); }}
            className={cn("absolute cursor-move rounded-sm border-2 border-dashed", k.id === picked ? "border-primary bg-primary/10" : "border-white/60 hover:border-white")}
            style={{ left: `${k.x - k.w / 2}%`, top: `${k.y - h / 2}%`, width: `${k.w}%`, height: `${h}%`, transform: `rotate(${k.rotate}deg)` }} />
        );
      })}
    </div>
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
