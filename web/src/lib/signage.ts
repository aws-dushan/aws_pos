/*
 * TV screens (digital signage): the design format the designer saves and the TV plays, its defaults, and the rules the TV
 * follows (which slides play now, how long an offer has left). The server stores a design as it is (signage_design.content).
 */

export type Layout = "hero" | "offer" | "grid" | "list" | "fresh" | "media"
  | "zoom" | "kinetic" | "flash" | "top5" | "combo" | "neon" | "polaroid" | "versus" | "story";
export type Anim = "rise" | "fade" | "zoom" | "slide" | "pop" | "blur" | "none";
export type Speed = "slow" | "normal" | "fast";
export type Transition = "flash" | "fade" | "slide" | "zoom" | "none";
export type FontKey = "bricolage" | "fraunces" | "bebas" | "playfair" | "poppins";
export type PaletteKey = "espresso" | "midnight" | "berry" | "matcha" | "cream" | "custom";
export type Ambient = "glow" | "rays" | "none";

export type Colors = { bg: string; bg2: string; text: string; accent: string; hot: string; muted: string };

export type Schedule = { days: number[]; from: string; to: string };

export type StickerAnim = "none" | "float" | "spin" | "pulse" | "swing";
/** A picture placed on a slide: its centre (x, y) and width in % of the screen; r = height / width of the picture. */
export type Sticker = { id: string; mediaId: string; x: number; y: number; w: number; r: number; rotate: number; anim: StickerAnim };

export type Slide = {
  id: string;
  layout: Layout;
  enabled: boolean;
  seconds: number;
  animation: Anim;
  speed: Speed;
  /** null: all day, every day. Days 0 = Sunday … 6 = Saturday; times in the branch's time zone. */
  schedule: Schedule | null;
  background: { kind: "theme" | "color" | "media"; color?: string; mediaId?: string | null; dim?: number };
  kicker?: string;
  title?: string;
  titleAr?: string;
  text?: string;
  /** The item a hero or offer is about: its photo, name and price come from the menu. */
  itemId?: string | null;
  /** Grid and list: a category, or items picked one by one. */
  source?: "category" | "items";
  categoryId?: string | null;
  itemIds?: string[];
  /** Offer: its price and the price before (empty: the item's menu price). */
  price?: number | null;
  oldPrice?: number | null;
  /** Offer: ends at this time today (a countdown shows; after it the slide stops playing). */
  endsAt?: string | null;
  badge?: string;
  words?: string[];
  nextAt?: string | null;
  upsell?: string;
  upsellPrice?: number | null;
  showSoldToday?: boolean;
  spotlight?: boolean;
  showPhotos?: boolean;
  hideSoldOut?: boolean;
  columns?: 2 | 3 | 4;
  /** Item id → a tag on its card (Bestseller, New, Hot, Vegan…). */
  tags?: Record<string, string>;
  /** Offer picture, or the picture or video of a media slide. */
  mediaId?: string | null;
  /** Pictures placed on top of the slide. */
  stickers?: Sticker[];
};

export type Theme = {
  palette: PaletteKey;
  colors: Colors;
  font: FontKey;
  transition: Transition;
  ambient: Ambient;
  arabic: boolean;
  showClock: boolean;
  showLogo: boolean;
  ticker: { on: boolean; messages: string[]; seconds: number };
};

export type DesignContent = { version: 1; theme: Theme; slides: Slide[] };

export type PlayItem = {
  id: string; categoryId: string; name: string; nameAr: string | null; description: string | null; price: number;
  soldOut: boolean; imageAt: string | null; soldToday: number;
};
export type PlayData = {
  companyId: string; branchId: string; branch: string; branchAr: string | null; timeZone: string; currency: string; logoAt: string | null;
  categories: { id: string; name: string; nameAr: string | null }[]; items: PlayItem[]; serverTime: string;
  /** Media that are videos (the rest are pictures). */
  videos: string[];
};

export const PALETTES: Record<Exclude<PaletteKey, "custom">, { label: string; colors: Colors }> = {
  espresso: { label: "Espresso", colors: { bg: "#24150d", bg2: "#4a2814", text: "#fff3df", accent: "#ffc23d", hot: "#ff5a36", muted: "#c6a688" } },
  midnight: { label: "Midnight", colors: { bg: "#0b1020", bg2: "#1d2a52", text: "#f2f5ff", accent: "#5eead4", hot: "#f472b6", muted: "#93a0c4" } },
  berry: { label: "Berry", colors: { bg: "#2a0b1c", bg2: "#5b1238", text: "#fff0f6", accent: "#ffd166", hot: "#ff4d6d", muted: "#d7a1b8" } },
  matcha: { label: "Matcha", colors: { bg: "#0f2016", bg2: "#245236", text: "#f1fbef", accent: "#c6f36b", hot: "#ff8a3d", muted: "#9cc3a6" } },
  cream: { label: "Cream", colors: { bg: "#f7efe2", bg2: "#ead7b8", text: "#2b1a10", accent: "#b4471b", hot: "#d62f2f", muted: "#7b6552" } },
};

export const FONTS: Record<FontKey, string> = {
  bricolage: "Bricolage", fraunces: "Fraunces", bebas: "Bebas Neue", playfair: "Playfair", poppins: "Poppins",
};

export const LAYOUTS: Record<Layout, { label: string; hint: string }> = {
  hero: { label: "Bestseller", hint: "One item, big, with its photo, price and how many sold today" },
  offer: { label: "Offer", hint: "A deal with the old price crossed out and a countdown to its end" },
  grid: { label: "Menu grid", hint: "Up to 12 items as cards, with photos, prices and tags" },
  list: { label: "Menu list", hint: "Two columns of items and prices, English and Arabic" },
  fresh: { label: "Fresh now", hint: "Freshly made, rolling words, next batch time and an add-on" },
  media: { label: "Picture or video", hint: "Full screen, with an optional caption" },
  zoom: { label: "Hero zoom", hint: "One item's photo slowly zooming, big title and a price sticker that slams in" },
  kinetic: { label: "Kinetic words", hint: "Big words slam in one by one on colour flashes, then the item" },
  flash: { label: "Flash sale", hint: "Moving warning stripes, shaking title, price drop and a countdown" },
  top5: { label: "Top 5 today", hint: "Today's best sellers as growing bars with live counts" },
  combo: { label: "Combo builder", hint: "Up to 3 items drop in with + signs, then the combo price" },
  neon: { label: "Neon menu", hint: "Glowing neon sign style menu in two columns" },
  polaroid: { label: "Polaroid wall", hint: "Up to 4 items as pinned photos with price tags" },
  versus: { label: "This or that", hint: "Two items side by side with a pulsing VS" },
  story: { label: "Story cards", hint: "Up to 3 items, one after another, like social media stories" },
};

export const STICKER_ANIMS: Record<StickerAnim, string> = { none: "Still", float: "Float", spin: "Spin", pulse: "Pulse", swing: "Swing" };

export const ANIMS: Record<Anim, string> = { rise: "Rise", fade: "Fade", zoom: "Zoom", slide: "Slide in", pop: "Pop", blur: "Focus", none: "None" };
export const TRANSITIONS: Record<Transition, string> = { flash: "Flash", fade: "Fade", slide: "Slide", zoom: "Zoom", none: "Cut" };
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const newId = () => Math.random().toString(36).slice(2, 10);

export function defaultTheme(): Theme {
  return {
    palette: "espresso", colors: { ...PALETTES.espresso.colors }, font: "bricolage", transition: "flash", ambient: "glow",
    arabic: true, showClock: true, showLogo: true,
    ticker: { on: true, messages: ["Fresh every morning", "Order on the delivery apps", "Ask about cakes for your celebration"], seconds: 30 },
  };
}

export function newSlide(layout: Layout, data?: PlayData | null): Slide {
  const base: Slide = { id: newId(), layout, enabled: true, seconds: 10, animation: "rise", speed: "normal", schedule: null, background: { kind: "theme" } };
  // Starting points from the menu: priced items (with a photo first, then today's best sellers), and categories that have them.
  const priced = data ? data.items.filter((i) => i.price > 0 && !i.soldOut) : [];
  const top = [...priced].sort((a, b) => Number(!!b.imageAt) - Number(!!a.imageAt) || b.soldToday - a.soldToday);
  const first = top[0] ?? null;
  const second = top.find((i) => i.categoryId !== first?.categoryId) ?? top[1] ?? first;
  const cats = data ? data.categories.map((c) => ({ c, n: priced.filter((i) => i.categoryId === c.id).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).map((x) => x.c) : [];
  switch (layout) {
    case "hero":
      return { ...base, kicker: "Our favourite", itemId: first?.id ?? null, badge: "No. 1", words: ["Made fresh", "Every day"], showSoldToday: true };
    case "offer":
      return { ...base, kicker: "Today's deal", title: second?.name ?? "Breakfast deal", itemId: second?.id ?? null, price: null, oldPrice: null, endsAt: null, text: "", animation: "zoom" };
    case "grid":
      return { ...base, title: cats[0]?.name ?? "Our menu", titleAr: cats[0]?.nameAr ?? "", source: "category", categoryId: cats[0]?.id ?? null, itemIds: [], spotlight: true, showPhotos: true, columns: 3, seconds: 12, tags: {} };
    case "list":
      return { ...base, title: (cats[1] ?? cats[0])?.name ?? "Menu", titleAr: (cats[1] ?? cats[0])?.nameAr ?? "", source: "category", categoryId: (cats[1] ?? cats[0])?.id ?? null, itemIds: [], seconds: 12 };
    case "fresh":
      return { ...base, kicker: "Fresh batch just out", title: "Warm from the oven", words: ["Flaky.", "Buttery.", "Still warm."], nextAt: null, upsell: "Add one to any coffee", upsellPrice: null, itemId: (top[2] ?? first)?.id ?? null };
    case "media":
      return { ...base, mediaId: null, title: "", animation: "fade", seconds: 8 };
    case "zoom":
      return { ...base, kicker: "Baked this morning", itemId: first?.id ?? null, seconds: 9 };
    case "kinetic":
      return { ...base, words: ["Fresh.", "Flaky.", "Buttery."], itemId: first?.id ?? null, text: "", seconds: 9 };
    case "flash":
      return { ...base, title: "FLASH SALE", itemId: second?.id ?? null, price: null, oldPrice: null, endsAt: null, seconds: 9 };
    case "top5":
      return { ...base, title: "TODAY'S TOP 5", itemIds: [], seconds: 10 };
    case "combo":
      return { ...base, title: "Build your breakfast", itemIds: top.slice(0, 3).map((i) => i.id), price: null, oldPrice: null, seconds: 10 };
    case "neon":
      return { ...base, title: "Tonight", source: "category", categoryId: cats[0]?.id ?? null, itemIds: [], badge: "", seconds: 10 };
    case "polaroid":
      return { ...base, title: "Fresh from our kitchen", itemIds: top.slice(0, 4).map((i) => i.id), seconds: 10 };
    case "versus":
      return { ...base, title: "WHICH TEAM ARE YOU?", itemIds: top.slice(0, 2).map((i) => i.id), badge: "VS", seconds: 9 };
    case "story":
      return { ...base, itemIds: top.slice(0, 3).map((i) => i.id), seconds: 12 };
  }
}

export function starterDesign(data?: PlayData | null): DesignContent {
  return { version: 1, theme: defaultTheme(), slides: [newSlide("zoom", data), newSlide("kinetic", data), newSlide("grid", data), newSlide("polaroid", data), newSlide("versus", data)] };
}

/** Fills anything an older or hand-made design lacks, so the TV never meets a missing field. */
export function normalize(c: Partial<DesignContent> | null | undefined): DesignContent {
  const t = defaultTheme();
  const theme: Theme = { ...t, ...(c?.theme ?? {}), colors: { ...t.colors, ...(c?.theme?.colors ?? {}) }, ticker: { ...t.ticker, ...(c?.theme?.ticker ?? {}) } };
  const slides = (c?.slides ?? []).map((s) => ({ ...newSlide(s.layout ?? "media"), ...s, background: { ...(s.background ?? {}), kind: s.background?.kind ?? "theme" } }));
  return { version: 1, theme, slides };
}

/** The time in the branch: weekday (0 = Sunday) and minutes since midnight. */
export function branchClock(timeZone: string, at = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
    const day = DAY_NAMES.indexOf(get("weekday"));
    return { day: day < 0 ? at.getDay() : day, minutes: Number(get("hour")) * 60 + Number(get("minute")), seconds: Number(get("second")) };
  } catch {
    return { day: at.getDay(), minutes: at.getHours() * 60 + at.getMinutes(), seconds: at.getSeconds() };
  }
}

const mins = (hhmm: string | null | undefined) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Seconds until an offer's end time today (null: no end; 0 or less: over). */
export function secondsLeft(endsAt: string | null | undefined, clock: { minutes: number; seconds: number }) {
  const end = mins(endsAt);
  return end === null ? null : end * 60 - (clock.minutes * 60 + clock.seconds);
}

/** Whether a slide plays now: switched on, inside its schedule, and an offer not past its end. */
export function playsNow(s: Slide, clock: { day: number; minutes: number; seconds: number }) {
  if (!s.enabled) return false;
  if (s.layout === "offer") { const left = secondsLeft(s.endsAt, clock); if (left !== null && left <= 0) return false; }
  if (!s.schedule) return true;
  if (s.schedule.days.length && !s.schedule.days.includes(clock.day)) return false;
  const from = mins(s.schedule.from) ?? 0, to = mins(s.schedule.to) ?? 24 * 60;
  return from <= to ? clock.minutes >= from && clock.minutes < to : clock.minutes >= from || clock.minutes < to;
}

/** The items a grid or list shows. */
export function slideItems(s: Slide, data: PlayData | null, max: number) {
  if (!data) return [];
  const pick = s.source === "items" ? (s.itemIds ?? []).map((id) => data.items.find((i) => i.id === id)).filter((i): i is PlayItem => !!i)
    : data.items.filter((i) => i.categoryId === s.categoryId);
  return pick.filter((i) => !(s.hideSoldOut && i.soldOut)).slice(0, max);
}

export const fmtPrice = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
