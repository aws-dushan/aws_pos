/* eslint-disable @next/next/no-img-element -- TV pictures are this server's own (menu photos, uploads), sized by the layout */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bebas_Neue, Bricolage_Grotesque, Fraunces, Instrument_Sans, Noto_Kufi_Arabic, Playfair_Display, Poppins } from "next/font/google";
import { cn } from "@/lib/utils";
import {
  branchClock, fmtPrice, playsNow, secondsLeft, slideItems,
  type DesignContent, type FontKey, type PlayData, type PlayItem, type Slide,
} from "@/lib/signage";

const bricolage = Bricolage_Grotesque({ subsets: ["latin"], weight: ["500", "700", "800"], variable: "--sgf-bricolage", display: "swap" });
const fraunces = Fraunces({ subsets: ["latin"], weight: ["600", "800"], variable: "--sgf-fraunces", display: "swap" });
const bebas = Bebas_Neue({ subsets: ["latin"], weight: "400", variable: "--sgf-bebas", display: "swap" });
const playfair = Playfair_Display({ subsets: ["latin"], weight: ["700", "800"], variable: "--sgf-playfair", display: "swap" });
const poppins = Poppins({ subsets: ["latin"], weight: ["500", "700", "800"], variable: "--sgf-poppins", display: "swap" });
const body = Instrument_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--sgf-body", display: "swap" });
const kufi = Noto_Kufi_Arabic({ subsets: ["arabic"], weight: ["500", "700", "800"], variable: "--sgf-ar", display: "swap" });
const FONT_VARS = [bricolage, fraunces, bebas, playfair, poppins, body, kufi].map((f) => f.variable).join(" ");
const DISPLAY: Record<FontKey, string> = {
  bricolage: "var(--sgf-bricolage)", fraunces: "var(--sgf-fraunces)", bebas: "var(--sgf-bebas)", playfair: "var(--sgf-playfair)", poppins: "var(--sgf-poppins)",
};

export type MediaUrls = { media: (id: string) => string; isVideo: (id: string) => boolean; item: (i: PlayItem) => string | null; logo: string | null };

const SPEED = { slow: 1.3, normal: 0.85, fast: 0.5 };

/**
 * A TV screen: plays a design's slides in turn (those switched on, in their schedule, offers not ended), each with its layout and
 * animation, the menu's names, photos and prices, sold-out items and today's counts; ticker, logo and clock along the bottom.
 * `lock` shows one slide only (the designer's preview); `replay` restarts its animation.
 */
export function SignageStage({ content, data, urls, lock, replay = 0, className }: {
  content: DesignContent; data: PlayData | null; urls: MediaUrls; lock?: string | null; replay?: number; className?: string;
}) {
  const { theme } = content;
  const tz = data?.timeZone ?? "Asia/Dubai";
  const [clock, setClock] = useState(() => branchClock(tz));
  useEffect(() => {
    const t = window.setInterval(() => setClock(branchClock(tz)), 1000);
    return () => window.clearInterval(t);
  }, [tz]);

  // Which slides play: re-checked each minute (schedules), not every second, so the loop doesn't jump.
  const minuteKey = `${clock.day}-${clock.minutes}`;
  const playing = useMemo(() => {
    if (lock) return content.slides.filter((s) => s.id === lock);
    const c = branchClock(tz);
    return content.slides.filter((s) => playsNow(s, c));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content.slides, lock, tz, minuteKey]);

  const [index, setIndex] = useState(0);
  const [round, setRound] = useState(0);
  const current = playing.length ? playing[index % playing.length] : null;
  useEffect(() => {
    if (lock || !current) return;
    const t = window.setTimeout(() => { setIndex((i) => (i + 1) % Math.max(1, playing.length)); setRound((r) => r + 1); }, Math.max(3, current.seconds) * 1000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart only when the slide changes, not when its data refreshes
  }, [current?.id, current?.seconds, lock, playing.length, round]);

  const style = {
    "--sg-bg": theme.colors.bg, "--sg-bg2": theme.colors.bg2, "--sg-text": theme.colors.text, "--sg-accent": theme.colors.accent,
    "--sg-hot": theme.colors.hot, "--sg-muted": theme.colors.muted, "--sg-display": DISPLAY[theme.font] ?? DISPLAY.bricolage,
  } as React.CSSProperties;

  const bar = theme.ticker.on || theme.showClock || theme.showLogo;
  const time = new Intl.DateTimeFormat("en-AE", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date());

  return (
    <div className={cn("sg", FONT_VARS, className)} style={style} data-ambient={theme.ambient} data-bar={bar ? "1" : "0"}>
      <style>{CSS}</style>
      <div className="sg-ambient" />
      {current ? (
        <SlideView key={`${current.id}-${lock ? replay : round}`} slide={current} content={content} data={data} urls={urls} clock={clock} transition={lock ? "none" : theme.transition} />
      ) : (
        <div className="sg-idle">
          {urls.logo ? <img src={urls.logo} alt="" /> : <div className="sg-idle-name">{data?.branch ?? ""}</div>}
        </div>
      )}
      {!lock && theme.transition === "flash" && <div key={round} className="sg-flash" />}
      {current && !lock && <div key={`p${round}`} className="sg-progress" style={{ animationDuration: `${Math.max(3, current.seconds)}s` }} />}
      {bar && (
        <div className="sg-bar">
          {theme.showLogo && (
            <div className="sg-brand">
              {urls.logo ? <img src={urls.logo} alt="" /> : null}
              <span>{data?.branch ?? ""}</span>
            </div>
          )}
          <div className="sg-ticker">
            {theme.ticker.on && theme.ticker.messages.filter(Boolean).length > 0 && (
              <div className="sg-track" style={{ animationDuration: `${Math.max(10, theme.ticker.seconds)}s` }}>
                {[0, 1].map((k) => (
                  <span key={k}>{theme.ticker.messages.filter(Boolean).map((m, i) => <span key={i}>{m}<i>●</i></span>)}</span>
                ))}
              </div>
            )}
          </div>
          {theme.showClock && <div className="sg-clock">{time}</div>}
        </div>
      )}
    </div>
  );
}

function SlideView({ slide, content, data, urls, clock, transition }: {
  slide: Slide; content: DesignContent; data: PlayData | null; urls: MediaUrls; clock: ReturnType<typeof branchClock>; transition: string;
}) {
  const bg = slide.background;
  const vars = { "--sg-speed": `${SPEED[slide.speed] ?? 0.85}s` } as React.CSSProperties;
  return (
    <section className="sg-slide" data-anim={slide.animation} data-t={transition} style={vars}>
      {bg.kind === "color" && bg.color && <div className="sg-bgfill" style={{ background: bg.color }} />}
      {bg.kind === "media" && bg.mediaId && (
        <>
          <MediaFill id={bg.mediaId} urls={urls} />
          <div className="sg-bgfill" style={{ background: `rgba(0,0,0,${(bg.dim ?? 40) / 100})` }} />
        </>
      )}
      {slide.layout === "hero" && <Hero s={slide} content={content} data={data} urls={urls} />}
      {slide.layout === "offer" && <Offer s={slide} content={content} data={data} urls={urls} clock={clock} />}
      {slide.layout === "grid" && <Grid s={slide} content={content} data={data} urls={urls} />}
      {slide.layout === "list" && <List s={slide} content={content} data={data} />}
      {slide.layout === "fresh" && <Fresh s={slide} content={content} data={data} urls={urls} />}
      {slide.layout === "media" && <MediaSlide s={slide} urls={urls} />}
    </section>
  );
}

/** A picture or a video (muted, looping) covering its box. */
function MediaFill({ id, urls, contain }: { id: string; urls: MediaUrls; contain?: boolean }) {
  const cls = cn("sg-media", contain && "sg-contain");
  const src = urls.media(id);
  return urls.isVideo(id) ? <video className={cls} src={src} autoPlay muted loop playsInline /> : <img className={cls} src={src} alt="" />;
}

/** Long titles get smaller so they never run off the slide. */
const fit = (t: string | null | undefined) => { const n = (t ?? "").length; return n > 34 ? "sg-fit3" : n > 22 ? "sg-fit2" : n > 14 ? "sg-fit1" : ""; };

const itemOf = (data: PlayData | null, id: string | null | undefined) => (id && data ? data.items.find((i) => i.id === id) ?? null : null);

function Price({ value, currency, className }: { value: number; currency?: string; className?: string }) {
  return <span className={cn("sg-price", className)}><b>{fmtPrice(value)}</b><small>{currency ?? "AED"}</small></span>;
}

function Photo({ item, urls, className }: { item: PlayItem | null; urls: MediaUrls; className?: string }) {
  const src = item ? urls.item(item) : null;
  const [ok, setOk] = useState(true);
  if (src && ok) return <img className={cn("sg-photo", className)} src={src} alt="" onError={() => setOk(false)} />;
  return <div className={cn("sg-photo sg-nophoto", className)}><span>{(item?.name ?? "?").slice(0, 1)}</span></div>;
}

/** A number that bounces when it goes up (today's count). */
function LiveCount({ value }: { value: number }) {
  const prev = useRef(value);
  const [bump, setBump] = useState(0);
  useEffect(() => { if (value > prev.current) setBump((b) => b + 1); prev.current = value; }, [value]);
  return <span key={bump} className={cn("sg-count", bump > 0 && "sg-bump")}>{fmtPrice(value)}</span>;
}

function Hero({ s, content, data, urls }: { s: Slide; content: DesignContent; data: PlayData | null; urls: MediaUrls }) {
  const item = itemOf(data, s.itemId);
  const title = s.title?.trim() || item?.name || "Our favourite";
  const words = title.split(/\s+/);
  const ar = s.titleAr?.trim() || item?.nameAr;
  return (
    <div className="sg-hero">
      <div className="sg-col">
        {s.kicker && <div className="sg-kicker sg-in">{s.kicker}</div>}
        <h2 className={cn("sg-h1", fit(title))}>{words.map((w, i) => <span key={i} className={cn("sg-in sg-word", i === words.length - 1 && "sg-shine")} style={{ "--i": i + 1 } as React.CSSProperties}>{w} </span>)}</h2>
        {content.theme.arabic && ar && <div className="sg-ar sg-in" style={{ "--i": words.length + 1 } as React.CSSProperties}>{ar}</div>}
        {(s.words?.length ?? 0) > 0 && <div className="sg-chips sg-in" style={{ "--i": words.length + 2 } as React.CSSProperties}>{s.words!.filter(Boolean).map((w, i) => <span key={i}>{w}</span>)}</div>}
        {item && item.price > 0 && <div className="sg-in sg-pop-late" style={{ "--i": words.length + 3 } as React.CSSProperties}><Price value={item.price} currency={data?.currency} className="sg-price-xl" /></div>}
      </div>
      <div className="sg-stage">
        <div className="sg-rays" />
        <div className="sg-in sg-hero-photo" style={{ "--i": 1 } as React.CSSProperties}><Photo item={item} urls={urls} className="sg-photo-xl sg-float" /></div>
        {s.badge && <div className="sg-badge"><span>{s.badge}</span></div>}
        {s.showSoldToday && item && item.soldToday > 0 && (
          <div className="sg-live sg-in" style={{ "--i": 6 } as React.CSSProperties}><i /> <LiveCount value={item.soldToday} /> sold today</div>
        )}
        {item?.soldOut && <div className="sg-soldout-stamp">Sold out</div>}
      </div>
    </div>
  );
}

function Countdown({ left }: { left: number }) {
  const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60), sec = left % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    <div className="sg-countdown">
      <span className="sg-lbl">Ends in</span>
      <div>{h > 0 && <span><b>{p(h)}</b><small>HRS</small></span>}<span><b>{p(m)}</b><small>MIN</small></span><span><b>{p(sec)}</b><small>SEC</small></span></div>
    </div>
  );
}

function Offer({ s, content, data, urls, clock }: { s: Slide; content: DesignContent; data: PlayData | null; urls: MediaUrls; clock: ReturnType<typeof branchClock> }) {
  const item = itemOf(data, s.itemId);
  const price = s.price ?? item?.price ?? null;
  const old = s.oldPrice ?? null;
  const left = secondsLeft(s.endsAt, clock);
  const save = price !== null && old !== null && old > price ? old - price : null;
  return (
    <div className="sg-offer">
      <div className="sg-col">
        {s.kicker && <div className="sg-kicker sg-in">{s.kicker}</div>}
        <h2 className={cn("sg-h1 sg-h1-md sg-in", fit(s.title || item?.name))} style={{ "--i": 1 } as React.CSSProperties}>{s.title || item?.name || "Today's deal"}</h2>
        {content.theme.arabic && (s.titleAr || item?.nameAr) && <div className="sg-ar sg-in" style={{ "--i": 2 } as React.CSSProperties}>{s.titleAr || item?.nameAr}</div>}
        {s.text && <div className="sg-text sg-in" style={{ "--i": 3 } as React.CSSProperties}>{s.text}</div>}
        <div className="sg-deal sg-in" style={{ "--i": 4 } as React.CSSProperties}>
          {price !== null && price > 0 && <Price value={price} currency={data?.currency} className="sg-price-xl" />}
          <div>
            {old !== null && <div className="sg-was">{fmtPrice(old)} {data?.currency ?? "AED"}</div>}
            {save !== null && <div className="sg-save">Save {fmtPrice(save)} {data?.currency ?? "AED"}</div>}
          </div>
        </div>
        {left !== null && left > 0 && <div className="sg-in" style={{ "--i": 5 } as React.CSSProperties}><Countdown left={left} /></div>}
      </div>
      <div className="sg-stage">
        <div className="sg-rays" />
        <div className="sg-in sg-hero-photo" style={{ "--i": 1 } as React.CSSProperties}>
          {s.mediaId ? <div className="sg-photo-xl sg-offer-media"><MediaFill id={s.mediaId} urls={urls} /></div> : <Photo item={item} urls={urls} className="sg-photo-xl sg-float" />}
        </div>
        {save !== null && <div className="sg-badge sg-badge-hot"><span>-{Math.round((save / old!) * 100)}%</span></div>}
        <Confetti />
      </div>
    </div>
  );
}

function Confetti() {
  const bits = useMemo(() => Array.from({ length: 22 }, (_, i) => ({ left: (i * 37) % 100, dur: 3 + ((i * 7) % 5), delay: -((i * 13) % 7), c: i % 3 })), []);
  return <div className="sg-confetti">{bits.map((b, i) => <i key={i} data-c={b.c} style={{ left: `${b.left}%`, animationDuration: `${b.dur}s`, animationDelay: `${b.delay}s` }} />)}</div>;
}

function Title({ s, content }: { s: Slide; content: DesignContent }) {
  return (
    <div className="sg-title sg-in">
      <h2>{s.title}</h2>
      {content.theme.arabic && s.titleAr && <span className="sg-ar">{s.titleAr}</span>}
    </div>
  );
}

function Grid({ s, content, data, urls }: { s: Slide; content: DesignContent; data: PlayData | null; urls: MediaUrls }) {
  const cols = s.columns ?? 3;
  const items = slideItems(s, data, cols * (cols === 4 ? 3 : 2));
  const [lit, setLit] = useState(-1);
  useEffect(() => {
    if (!s.spotlight || items.length < 2) return;
    let k = 0;
    const start = window.setTimeout(() => setLit(0), 1500);
    const t = window.setInterval(() => { k = (k + 1) % items.length; setLit(k); }, 1800);
    return () => { window.clearTimeout(start); window.clearInterval(t); };
  }, [s.spotlight, items.length]);
  return (
    <div className="sg-pad">
      <Title s={s} content={content} />
      <div className="sg-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }} data-cols={cols}>
        {items.map((it, i) => (
          <div key={it.id} className={cn("sg-card sg-in", lit === i && "sg-lit", it.soldOut && "sg-out")} style={{ "--i": i + 1 } as React.CSSProperties}>
            {s.tags?.[it.id] && <span className={cn("sg-tag", /new/i.test(s.tags[it.id]) && "sg-tag-new")}>{s.tags[it.id]}</span>}
            {s.showPhotos !== false && <Photo item={it} urls={urls} className="sg-photo-sm" />}
            <div className="sg-card-body">
              <div className="sg-name">{it.name}</div>
              {content.theme.arabic && it.nameAr && <div className="sg-name-ar">{it.nameAr}</div>}
              {it.soldOut ? <div className="sg-soldout">Sold out</div> : it.price > 0 && <div className="sg-in sg-pop-late" style={{ "--i": i + 1 } as React.CSSProperties}><Price value={it.price} currency={data?.currency} /></div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function List({ s, content, data }: { s: Slide; content: DesignContent; data: PlayData | null }) {
  const items = slideItems(s, data, 16);
  return (
    <div className="sg-pad">
      <Title s={s} content={content} />
      <div className="sg-list">
        {items.map((it, i) => (
          <div key={it.id} className={cn("sg-row sg-in", it.soldOut && "sg-out")} style={{ "--i": i + 1 } as React.CSSProperties}>
            <div className="sg-row-name">
              <span className="sg-name">{it.name}{s.tags?.[it.id] && <span className="sg-tag sg-tag-inline">{s.tags[it.id]}</span>}</span>
              {content.theme.arabic && it.nameAr && <span className="sg-name-ar">{it.nameAr}</span>}
            </div>
            <span className="sg-dots" />
            {it.soldOut ? <span className="sg-soldout">Sold out</span> : it.price > 0 ? <Price value={it.price} currency={data?.currency} /> : <span />}
          </div>
        ))}
      </div>
    </div>
  );
}

function Fresh({ s, content, data, urls }: { s: Slide; content: DesignContent; data: PlayData | null; urls: MediaUrls }) {
  const item = itemOf(data, s.itemId);
  const words = (s.words ?? []).filter(Boolean);
  return (
    <div className="sg-offer">
      <div className="sg-col">
        {s.kicker && <div className="sg-live sg-in"><i /> {s.kicker}</div>}
        <h2 className={cn("sg-h1 sg-h1-md sg-in", fit(s.title || item?.name))} style={{ "--i": 1 } as React.CSSProperties}>{s.title || item?.name}</h2>
        {content.theme.arabic && (s.titleAr || item?.nameAr) && <div className="sg-ar sg-in" style={{ "--i": 2 } as React.CSSProperties}>{s.titleAr || item?.nameAr}</div>}
        {words.length > 0 && (
          <div className="sg-roll sg-in" style={{ "--i": 3, "--n": words.length } as React.CSSProperties}>
            <div style={{ animationName: `sg-roll${Math.min(words.length, 5)}` }}>{[...words, words[0]].map((w, i) => <span key={i}>{w}</span>)}</div>
          </div>
        )}
        {s.nextAt && <div className="sg-text sg-in" style={{ "--i": 4 } as React.CSSProperties}>Next batch at <b>{s.nextAt}</b></div>}
        {s.upsell && (
          <div className="sg-upsell sg-in sg-pop-late" style={{ "--i": 5 } as React.CSSProperties}>
            {s.upsell}{s.upsellPrice != null && <b> +{fmtPrice(s.upsellPrice)} {data?.currency ?? "AED"}</b>}
          </div>
        )}
      </div>
      <div className="sg-stage">
        <div className="sg-warm" />
        <div className="sg-in sg-hero-photo" style={{ "--i": 1 } as React.CSSProperties}>
          {s.mediaId ? <div className="sg-photo-xl sg-offer-media"><MediaFill id={s.mediaId} urls={urls} /></div> : <Photo item={item} urls={urls} className="sg-photo-xl" />}
        </div>
        <div className="sg-steam"><i /><i /><i /></div>
      </div>
    </div>
  );
}

function MediaSlide({ s, urls }: { s: Slide; urls: MediaUrls }) {
  return (
    <div className="sg-full">
      {s.mediaId ? <div className="sg-in sg-full-media"><MediaFill id={s.mediaId} urls={urls} /></div> : <div className="sg-empty">Choose a picture or video</div>}
      {(s.title || s.text) && (
        <div className="sg-caption sg-in" style={{ "--i": 2 } as React.CSSProperties}>
          {s.title && <h2>{s.title}</h2>}
          {s.text && <p>{s.text}</p>}
        </div>
      )}
    </div>
  );
}

const CSS = `
.sg{position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;container-type:inline-size;background:var(--sg-bg);color:var(--sg-text);font-family:var(--sgf-body),system-ui,sans-serif;--stagger:.11s}
.sg *{box-sizing:border-box}
.sg img,.sg video{max-width:none}
.sg-ambient{position:absolute;inset:-10%;pointer-events:none}
.sg[data-ambient=glow] .sg-ambient,.sg[data-ambient=rays] .sg-ambient{background:radial-gradient(60% 70% at 70% 45%,var(--sg-bg2),transparent 70%),radial-gradient(40% 50% at 8% 92%,color-mix(in srgb,var(--sg-hot) 18%,transparent),transparent 70%);animation:sg-breathe 10s ease-in-out infinite}
@keyframes sg-breathe{50%{transform:scale(1.08) translate(-2%,1%)}}
.sg-slide{position:absolute;inset:0;bottom:var(--sg-barh,0)}
.sg[data-bar="1"]{--sg-barh:6.4cqw}
.sg-bgfill{position:absolute;inset:0}
.sg-media{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.sg-media.sg-contain{object-fit:contain}
.sg-idle{position:absolute;inset:0;bottom:var(--sg-barh,0);display:grid;place-items:center}
.sg-idle img{max-width:30cqw;max-height:30cqw;object-fit:contain;animation:sg-floaty 6s ease-in-out infinite}
.sg-idle-name{font-family:var(--sg-display);font-size:6cqw;font-weight:800}
.sg-col{display:flex;flex-direction:column;justify-content:center;min-width:0}
.sg-hero,.sg-offer{position:absolute;inset:0;display:grid;grid-template-columns:1fr 1.05fr;align-items:center;gap:2cqw;padding:0 4cqw 0 5cqw}
.sg-pad{position:absolute;inset:0;padding:3.2cqw 5cqw 0}
.sg-kicker{display:inline-flex;font-size:1.5cqw;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--sg-accent);margin-bottom:1cqw}
.sg-h1{font-family:var(--sg-display);font-weight:800;font-size:8.6cqw;line-height:.9;margin:0 0 1.4cqw;letter-spacing:-.02em;text-wrap:balance}
.sg-h1-md{font-size:6.6cqw}
.sg-h1.sg-fit1{font-size:6cqw}.sg-h1.sg-fit2{font-size:4.8cqw}.sg-h1.sg-fit3{font-size:3.9cqw;line-height:1}
.sg-grid{align-content:start}
.sg-word{display:inline-block;margin-right:.18em}
.sg-shine{background:linear-gradient(100deg,var(--sg-accent) 40%,#fff 50%,var(--sg-accent) 60%);background-size:250% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:sg-shine 3s linear infinite!important}
@keyframes sg-shine{from{background-position:120% 0}to{background-position:-120% 0}}
.sg-ar{font-family:var(--sgf-ar),sans-serif;direction:rtl;text-align:left;font-weight:800;font-size:2.6cqw;color:var(--sg-accent);margin-bottom:1.6cqw}
.sg-chips{display:flex;flex-wrap:wrap;gap:1cqw;margin-bottom:2cqw}
.sg-chips span{border:.15cqw solid color-mix(in srgb,var(--sg-text) 30%,transparent);border-radius:99px;padding:.5cqw 1.4cqw;font-size:1.7cqw;font-weight:600}
.sg-text{font-size:2cqw;color:var(--sg-muted);margin-bottom:1.6cqw;line-height:1.35}
.sg-text b{color:var(--sg-text)}
.sg-price{display:inline-flex;align-items:flex-end;gap:.5cqw;font-family:var(--sg-display);font-weight:800;color:var(--sg-accent);font-variant-numeric:tabular-nums}
.sg-price b{font-size:2.7cqw;line-height:1}
.sg-price small{font-size:1.2cqw;font-weight:600;color:var(--sg-muted);padding-bottom:.25cqw}
.sg-price-xl b{font-size:8cqw;line-height:.8;color:var(--sg-text)}
.sg-price-xl small{font-size:2cqw}
.sg-stage{position:relative;height:100%;display:grid;place-items:center}
.sg-rays{position:absolute;width:44cqw;height:44cqw;border-radius:50%;background:repeating-conic-gradient(color-mix(in srgb,var(--sg-accent) 14%,transparent) 0 8deg,transparent 8deg 22deg);animation:sg-spin 40s linear infinite;-webkit-mask:radial-gradient(circle,#000 30%,transparent 70%);mask:radial-gradient(circle,#000 30%,transparent 70%)}
.sg[data-ambient=none] .sg-rays{display:none}
@keyframes sg-spin{to{transform:rotate(360deg)}}
.sg-hero-photo{position:relative}
.sg-photo{display:block;object-fit:cover;border-radius:50%;background:color-mix(in srgb,var(--sg-text) 8%,transparent)}
.sg-photo-xl{width:30cqw;height:30cqw;box-shadow:0 2cqw 4cqw -1cqw #000a,0 0 0 .6cqw color-mix(in srgb,var(--sg-accent) 35%,transparent)}
.sg-offer-media{position:relative;overflow:hidden;border-radius:2cqw;width:34cqw;height:26cqw}
.sg-float{animation:sg-floaty 5s ease-in-out infinite}
@keyframes sg-floaty{50%{transform:translateY(-1.2cqw)}}
.sg-nophoto{display:grid;place-items:center;background:radial-gradient(circle at 35% 30%,color-mix(in srgb,var(--sg-accent) 55%,transparent),color-mix(in srgb,var(--sg-accent) 12%,transparent))}
.sg-nophoto span{font-family:var(--sg-display);font-weight:800;font-size:40%;color:var(--sg-bg)}
.sg-photo-xl.sg-nophoto span{font-size:12cqw}
.sg-photo-sm.sg-nophoto span{font-size:3cqw}
.sg-badge{position:absolute;right:3cqw;top:5cqw;width:13cqw;height:13cqw;display:grid;place-items:center;color:var(--sg-bg);font-family:var(--sg-display);font-weight:800;font-size:3cqw;text-align:center;line-height:1;animation:sg-slam .6s cubic-bezier(.3,1.6,.5,1) .9s both}
.sg-badge::before{content:"";position:absolute;inset:0;background:var(--sg-accent);clip-path:polygon(50% 0,61% 9%,75% 4%,79% 18%,93% 21%,90% 35%,100% 47%,91% 58%,97% 72%,83% 77%,80% 91%,66% 88%,55% 100%,45% 91%,32% 97%,26% 83%,12% 81%,14% 67%,2% 57%,10% 46%,3% 32%,17% 27%,19% 13%,33% 15%,42% 2%);animation:sg-spin 14s linear infinite}
.sg-badge span{position:relative;padding:0 1cqw}
.sg-badge-hot{color:#fff}.sg-badge-hot::before{background:var(--sg-hot)}
@keyframes sg-slam{from{opacity:0;transform:scale(3) rotate(-30deg)}}
.sg-live{display:inline-flex;align-items:center;gap:.8cqw;background:color-mix(in srgb,var(--sg-text) 10%,transparent);border-radius:99px;padding:.6cqw 1.4cqw;font-size:1.6cqw;font-weight:600;width:max-content;margin-bottom:1cqw}
.sg-stage .sg-live{position:absolute;left:2cqw;bottom:4cqw}
.sg-live i{width:1cqw;height:1cqw;border-radius:50%;background:var(--sg-hot);animation:sg-ping 1.6s infinite}
@keyframes sg-ping{0%{box-shadow:0 0 0 0 var(--sg-hot)}70%{box-shadow:0 0 0 1.2cqw transparent}100%{box-shadow:0 0 0 0 transparent}}
.sg-count{display:inline-block;font-variant-numeric:tabular-nums}
.sg-bump{animation:sg-bump .5s cubic-bezier(.3,1.8,.5,1)!important}
@keyframes sg-bump{40%{transform:scale(1.6);color:var(--sg-accent)}}
.sg-soldout-stamp{position:absolute;padding:1cqw 3cqw;border:.4cqw solid var(--sg-hot);color:var(--sg-hot);font-family:var(--sg-display);font-weight:800;font-size:3.4cqw;text-transform:uppercase;transform:rotate(-12deg);background:color-mix(in srgb,var(--sg-bg) 70%,transparent)}
.sg-deal{display:flex;align-items:center;gap:2cqw;margin-bottom:2cqw}
.sg-was{font-size:2.4cqw;color:var(--sg-muted);text-decoration:line-through;text-decoration-color:var(--sg-hot);text-decoration-thickness:.3cqw}
.sg-save{display:inline-block;margin-top:.6cqw;background:var(--sg-hot);color:#fff;font-weight:700;font-size:1.8cqw;padding:.6cqw 1.4cqw;border-radius:99px;animation:sg-wob 2s ease-in-out infinite}
@keyframes sg-wob{0%,80%,100%{transform:rotate(0)}85%{transform:rotate(-6deg)}90%{transform:rotate(6deg)}95%{transform:rotate(-3deg)}}
.sg-countdown{display:flex;align-items:center;gap:1.4cqw}
.sg-lbl{font-size:1.5cqw;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--sg-muted)}
.sg-countdown>div{display:flex;gap:.6cqw}
.sg-countdown span:not(.sg-lbl){display:block;background:color-mix(in srgb,var(--sg-text) 10%,transparent);border-radius:1cqw;padding:.8cqw 1.1cqw;text-align:center;min-width:6.4cqw}
.sg-countdown b{display:block;font-family:var(--sg-display);font-weight:800;font-size:3.4cqw;line-height:1;font-variant-numeric:tabular-nums}
.sg-countdown small{font-size:1cqw;letter-spacing:.14em;color:var(--sg-muted)}
.sg-confetti{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.sg-confetti i{position:absolute;top:-4%;width:1cqw;height:1.6cqw;border-radius:.2cqw;background:var(--sg-accent);animation:sg-fall linear infinite}
.sg-confetti i[data-c="1"]{background:var(--sg-hot)}.sg-confetti i[data-c="2"]{background:var(--sg-text)}
@keyframes sg-fall{to{transform:translateY(60cqw) rotate(540deg)}}
.sg-title{display:flex;align-items:baseline;justify-content:space-between;gap:2cqw;margin-bottom:2.2cqw}
.sg-title h2{font-family:var(--sg-display);font-weight:800;font-size:4.6cqw;line-height:1;margin:0}
.sg-title .sg-ar{font-size:3cqw;margin:0}
.sg-grid{display:grid;gap:1.6cqw}
.sg-card{position:relative;display:grid;grid-template-columns:auto 1fr;gap:1.4cqw;align-items:center;padding:1.4cqw;border-radius:1.6cqw;background:color-mix(in srgb,var(--sg-text) 6%,transparent);transition:transform .5s cubic-bezier(.3,1.4,.5,1),background .5s,box-shadow .5s}
.sg-grid[data-cols="4"] .sg-card{grid-template-columns:1fr;text-align:center;justify-items:center}
.sg-card.sg-lit{transform:scale(1.07);background:color-mix(in srgb,var(--sg-accent) 18%,transparent);box-shadow:0 0 0 .25cqw var(--sg-accent),0 2cqw 4cqw -1cqw #0009;z-index:1}
.sg-photo-sm{width:7.4cqw;height:7.4cqw}
.sg-lit .sg-photo-sm{animation:sg-wiggle .9s ease-in-out}
@keyframes sg-wiggle{30%{transform:rotate(-8deg) scale(1.12)}60%{transform:rotate(6deg) scale(1.08)}}
.sg-card-body{min-width:0}
.sg-name{font-family:var(--sg-display);font-weight:700;font-size:2.1cqw;line-height:1.1}
.sg-name-ar{display:block;font-family:var(--sgf-ar),sans-serif;direction:rtl;font-size:1.4cqw;color:var(--sg-muted);margin-top:.3cqw}
.sg-card .sg-name-ar{text-align:left}
.sg-grid[data-cols="4"] .sg-name-ar{text-align:center}
.sg-card .sg-price{margin-top:.5cqw}
.sg-tag{position:absolute;top:-1cqw;right:1.2cqw;background:var(--sg-hot);color:#fff;font-size:1.1cqw;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:.4cqw 1cqw;border-radius:99px}
.sg-tag-new{background:var(--sg-accent);color:var(--sg-bg)}
.sg-tag-inline{position:static;margin-left:1cqw;vertical-align:middle}
.sg-out{opacity:.4}
.sg-soldout{font-size:1.4cqw;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--sg-muted);margin-top:.5cqw}
.sg-list{display:grid;grid-template-columns:1fr 1fr;gap:.4cqw 5cqw}
.sg-row{display:grid;grid-template-columns:auto 1fr auto;align-items:baseline;gap:1.2cqw;padding:.9cqw 0;border-bottom:.12cqw dashed color-mix(in srgb,var(--sg-text) 18%,transparent)}
.sg-row-name{display:flex;flex-direction:column;min-width:0}
.sg-dots{border-bottom:.2cqw dotted color-mix(in srgb,var(--sg-text) 25%,transparent);transform:translateY(-.6cqw)}
.sg-roll{height:4cqw;overflow:hidden;font-family:var(--sg-display);font-weight:700;font-size:3.4cqw;color:var(--sg-accent);margin-bottom:1.6cqw}
.sg-roll>div{animation-duration:calc(var(--n) * 2s);animation-iteration-count:infinite;animation-timing-function:cubic-bezier(.7,0,.3,1)}
.sg-roll span{display:block;height:4cqw;line-height:4cqw}
@keyframes sg-roll1{to{transform:none}}
@keyframes sg-roll2{0%,40%{transform:translateY(0)}50%,90%{transform:translateY(-4cqw)}100%{transform:translateY(-8cqw)}}
@keyframes sg-roll3{0%,26%{transform:translateY(0)}33%,59%{transform:translateY(-4cqw)}66%,92%{transform:translateY(-8cqw)}100%{transform:translateY(-12cqw)}}
@keyframes sg-roll4{0%,20%{transform:translateY(0)}25%,45%{transform:translateY(-4cqw)}50%,70%{transform:translateY(-8cqw)}75%,95%{transform:translateY(-12cqw)}100%{transform:translateY(-16cqw)}}
@keyframes sg-roll5{0%,16%{transform:translateY(0)}20%,36%{transform:translateY(-4cqw)}40%,56%{transform:translateY(-8cqw)}60%,76%{transform:translateY(-12cqw)}80%,96%{transform:translateY(-16cqw)}100%{transform:translateY(-20cqw)}}
.sg-upsell{display:inline-flex;gap:1cqw;align-items:center;width:max-content;border:.2cqw dashed color-mix(in srgb,var(--sg-accent) 60%,transparent);border-radius:1.4cqw;padding:1.2cqw 1.8cqw;font-size:1.9cqw}
.sg-upsell b{color:var(--sg-accent);font-family:var(--sg-display);font-size:2.4cqw}
.sg-warm{position:absolute;width:40cqw;height:26cqw;border-radius:50%;background:radial-gradient(color-mix(in srgb,var(--sg-hot) 45%,transparent),transparent 65%);animation:sg-flicker 2.4s ease-in-out infinite}
@keyframes sg-flicker{50%{opacity:.6;transform:scale(1.05)}}
.sg-steam{position:absolute;top:8cqw;display:flex;gap:3cqw}
.sg-steam i{width:.6cqw;height:6cqw;border-radius:99px;background:linear-gradient(transparent,color-mix(in srgb,var(--sg-text) 60%,transparent));opacity:0;animation:sg-steam 3.4s ease-in-out infinite}
.sg-steam i:nth-child(2){animation-delay:1.1s}.sg-steam i:nth-child(3){animation-delay:2.2s}
@keyframes sg-steam{0%{opacity:0;transform:translateY(2cqw)}30%{opacity:.7}100%{opacity:0;transform:translateY(-5cqw) scaleX(1.6)}}
.sg-full{position:absolute;inset:0}
.sg-full-media{position:absolute;inset:0}
.sg-empty{position:absolute;inset:0;display:grid;place-items:center;font-size:2.4cqw;color:var(--sg-muted)}
.sg-caption{position:absolute;left:5cqw;right:5cqw;bottom:4cqw;padding:2cqw 2.6cqw;border-radius:1.6cqw;background:color-mix(in srgb,var(--sg-bg) 72%,transparent);backdrop-filter:blur(6px)}
.sg-caption h2{margin:0;font-family:var(--sg-display);font-weight:800;font-size:4.6cqw;line-height:1}
.sg-caption p{margin:.8cqw 0 0;font-size:2cqw;color:var(--sg-muted)}
.sg-bar{position:absolute;left:0;right:0;bottom:0;height:6.4cqw;display:flex;align-items:center;background:var(--sg-accent);color:var(--sg-bg);overflow:hidden;z-index:3}
.sg-brand{flex:none;height:100%;display:flex;align-items:center;gap:1cqw;padding:0 2.2cqw;background:var(--sg-bg);color:var(--sg-accent);font-family:var(--sg-display);font-weight:800;font-size:1.8cqw;letter-spacing:.02em;z-index:1}
.sg-brand img{height:4cqw;width:auto;object-fit:contain}
.sg-ticker{flex:1;min-width:0;overflow:hidden;height:100%;display:flex;align-items:center}
.sg-track{display:flex;white-space:nowrap;animation:sg-scroll linear infinite}
.sg-track>span{display:flex}
.sg-track span span{font-weight:700;font-size:1.9cqw;padding:0 2cqw}
.sg-track i{font-style:normal;opacity:.5;margin-left:4cqw}
@keyframes sg-scroll{to{transform:translateX(-50%)}}
.sg-clock{flex:none;height:100%;display:flex;align-items:center;padding:0 2.2cqw;background:var(--sg-bg);color:var(--sg-text);font-variant-numeric:tabular-nums;font-size:1.8cqw;font-weight:600;z-index:1}
.sg-flash{position:absolute;inset:0;background:var(--sg-text);opacity:0;pointer-events:none;z-index:4;animation:sg-flash .5s ease-out}
@keyframes sg-flash{0%{opacity:.35}100%{opacity:0}}
.sg-progress{position:absolute;left:0;bottom:var(--sg-barh,0);height:.35cqw;background:var(--sg-hot);width:0;z-index:4;animation:sg-prog linear forwards}
@keyframes sg-prog{to{width:100%}}
.sg-slide .sg-in{animation-duration:var(--sg-speed);animation-timing-function:cubic-bezier(.2,.9,.2,1);animation-fill-mode:both;animation-delay:calc(var(--i,0) * var(--stagger))}
.sg-slide .sg-pop-late{animation-name:sg-pop!important;animation-timing-function:cubic-bezier(.3,1.7,.5,1)!important;animation-delay:calc(var(--i,0) * var(--stagger) + .35s)!important}
.sg-slide[data-anim=rise] .sg-in{animation-name:sg-rise}
.sg-slide[data-anim=fade] .sg-in{animation-name:sg-fade}
.sg-slide[data-anim=zoom] .sg-in{animation-name:sg-zoom}
.sg-slide[data-anim=slide] .sg-in{animation-name:sg-slidein}
.sg-slide[data-anim=pop] .sg-in{animation-name:sg-pop;animation-timing-function:cubic-bezier(.3,1.7,.5,1)}
.sg-slide[data-anim=blur] .sg-in{animation-name:sg-blur}
.sg-slide[data-anim=none] .sg-in,.sg-slide[data-anim=none] .sg-pop-late{animation:none!important}
@keyframes sg-rise{from{opacity:0;transform:translateY(3cqw)}}
@keyframes sg-fade{from{opacity:0}}
@keyframes sg-zoom{from{opacity:0;transform:scale(.6)}}
@keyframes sg-slidein{from{opacity:0;transform:translateX(-7cqw) skewX(-8deg)}}
@keyframes sg-pop{from{opacity:0;transform:scale(.3)}}
@keyframes sg-blur{from{opacity:0;filter:blur(2cqw);transform:scale(1.06)}}
.sg-slide[data-t=fade]{animation:sg-fade .7s ease both}
.sg-slide[data-t=slide]{animation:sg-tslide .7s cubic-bezier(.2,.9,.2,1) both}
.sg-slide[data-t=zoom]{animation:sg-tzoom .8s cubic-bezier(.2,.9,.2,1) both}
@keyframes sg-tslide{from{transform:translateX(100%)}}
@keyframes sg-tzoom{from{opacity:0;transform:scale(1.15)}}
@media (prefers-reduced-motion:reduce){.sg *{animation-duration:.01s!important;animation-iteration-count:1!important}}
`;
