"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appStorage, withBase } from "@/lib/base-path";
import { normalize, type DesignContent, type PlayData } from "@/lib/signage";
import { SignageStage, type MediaUrls } from "@/components/signage/stage";

type Play =
  | { linked: false; code: string; expiresAt: string }
  | {
      linked: true;
      screen: { id: string; name: string; isOn: boolean };
      design: { id: string; name: string; content: DesignContent; updatedAt: string } | null;
      data: PlayData;
    };

const KEY = "signage.tv";

/** What kind of TV this is, for the TVs list ("Hisense VIDAA", "Samsung Tizen"…). */
function detectTv() {
  const ua = navigator.userAgent || "";
  return /VIDAA|Hisense|HiBrowser/i.test(ua) ? "Hisense VIDAA" : /Tizen/i.test(ua) ? "Samsung Tizen" : /Web0S|webOS/i.test(ua) ? "LG webOS"
    : /Android/i.test(ua) ? "Android TV" : /Windows/i.test(ua) ? "Windows PC" : /Macintosh/i.test(ua) ? "Mac" : "TV browser";
}

const screenSize = () => ({ w: Math.round(window.screen.width * (window.devicePixelRatio || 1)), h: Math.round(window.screen.height * (window.devicePixelRatio || 1)) });

function goFullScreen() {
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  const d = document as Document & { webkitFullscreenElement?: Element };
  if (document.fullscreenElement || d.webkitFullscreenElement) return;
  try {
    const p = el.requestFullscreen ? el.requestFullscreen() : el.webkitRequestFullscreen?.();
    if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch(() => {});
  } catch { /* the TV's browser needs a button press first: any key on the remote tries again */ }
}

/**
 * A TV (opened in the TV's own web browser: /tv; staff open it from an icon on the TV's home screen). The first time it gets a
 * key and shows a 6-digit code; a manager types the code on TV screens and the TV is linked to that branch. Then it asks the server
 * every 10 seconds what to show: off is plain black; on plays its design with the branch's menu, prices and counts. Keeps the last
 * answer when the server can't be reached, so a short internet drop doesn't blank the TV. Goes full screen by itself where the TV
 * allows it, otherwise at the first press of a remote key.
 */
export default function TvPage() {
  const [token, setToken] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try { return appStorage.getItem(KEY); } catch { return null; }
  });
  const [play, setPlay] = useState<Play | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const pairing = useRef(false);

  const pair = useCallback(async () => {
    if (pairing.current) return;
    pairing.current = true;
    try {
      const { w, h } = screenSize();
      const res = await fetch(withBase("/api/public/signage/pair"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ detected: detectTv(), width: w, height: h }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `The server answered ${res.status}.`);
      const r = (await res.json()) as { token: string; code: string; expiresAt: string };
      try { appStorage.setItem(KEY, r.token); } catch { /* storage blocked: linked until the page is closed */ }
      setToken(r.token);
      setPlay({ linked: false, code: r.code, expiresAt: r.expiresAt });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      window.setTimeout(() => setRetry((n) => n + 1), 15_000);   // no internet yet: try again
    } finally {
      pairing.current = false;
    }
  }, []);

  // No key yet: get one (and a code to show).
  useEffect(() => {
    if (token) return;
    const t = window.setTimeout(() => void pair(), 0);
    return () => window.clearTimeout(t);
  }, [token, pair, retry]);

  useEffect(() => {
    if (!token) return;
    let stop = false;
    const load = async () => {
      try {
        const { w, h } = screenSize();
        const res = await fetch(withBase(`/api/public/signage/play?w=${w}&h=${h}`), { headers: { "X-Signage-Token": token }, cache: "no-store" });
        if (res.status === 401) {
          // Removed, or its code ran out before anyone typed it: start again with a new code.
          try { appStorage.removeItem(KEY); } catch { /* none */ }
          if (!stop) { setPlay(null); setToken(null); }
          return;
        }
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `The server answered ${res.status}.`);
        const next = (await res.json()) as Play;
        if (next.linked) next.data.serverTime = "";   // changes every time; not a reason to redraw
        if (stop) return;
        setError(null);
        setPlay((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      } catch (e) {
        // Keep playing what we have; say so only when there's nothing to show.
        if (!stop) setError((e as Error).message);
      }
    };
    void load();
    const t = window.setInterval(load, 10_000);
    return () => { stop = true; window.clearInterval(t); };
  }, [token, pair]);

  // Full screen now if the TV allows it, else at the first remote key or click; keep the TV from dimming; pick up a new One POS
  // version every 6 hours.
  useEffect(() => {
    goFullScreen();
    const again = () => goFullScreen();
    window.addEventListener("keydown", again);
    window.addEventListener("click", again);
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<unknown> } };
    const lock = () => { void nav.wakeLock?.request("screen").catch(() => {}); };
    lock();
    document.addEventListener("visibilitychange", lock);
    const reload = window.setTimeout(() => window.location.reload(), 6 * 60 * 60_000);
    return () => {
      window.removeEventListener("keydown", again); window.removeEventListener("click", again);
      document.removeEventListener("visibilitychange", lock); window.clearTimeout(reload);
    };
  }, []);

  const linked = play?.linked ? play : null;
  // Pictures change address when the design is saved again, so a TV never shows a stale picture.
  const designJson = linked?.design ? JSON.stringify(linked.design.content) : null;
  const content = useMemo(() => (designJson ? normalize(JSON.parse(designJson) as DesignContent) : null), [designJson]);
  const urls = useMemo<MediaUrls | null>(() => {
    if (!token || !linked) return null;
    const t = encodeURIComponent(token);
    const d = linked.data;
    const videos = new Set(d.videos ?? []);
    return {
      media: (id) => withBase(`/api/public/signage/media/${id}?t=${t}`),
      isVideo: (id) => videos.has(id),
      item: (i) => (i.imageAt ? withBase(`/api/public/signage/items/${i.id}?t=${t}&v=${encodeURIComponent(i.imageAt)}`) : null),
      logo: d.logoAt ? withBase(`/api/public/signage/logo/${d.branchId}?t=${t}&v=${encodeURIComponent(d.logoAt)}`) : null,
    };
  }, [token, linked]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", display: "grid", placeItems: "center", overflow: "hidden", cursor: "none" }}>
      {linked ? (
        linked.screen.isOn && content && urls ? (
          <div style={{ width: "min(100vw, calc(100vh * 16 / 9))" }}>
            <SignageStage content={content} data={linked.data} urls={urls} key={linked.design!.id + linked.design!.updatedAt} />
          </div>
        ) : null
      ) : play && !play.linked ? (
        <PairingCode code={play.code} />
      ) : error ? (
        <p style={{ color: "#888", font: "500 2.4vh system-ui, sans-serif", textAlign: "center", maxWidth: "70vw" }}>
          Can&apos;t reach One POS: {error}<br />Trying again…
        </p>
      ) : null}
    </div>
  );
}

function PairingCode({ code }: { code: string }) {
  return (
    <div style={{ color: "#fff", textAlign: "center", fontFamily: "system-ui, Arial, sans-serif" }}>
      <div style={{ fontSize: "3.4vh", opacity: 0.75 }}>One POS · TV screens</div>
      <div style={{ fontSize: "4.6vh", fontWeight: 600, marginTop: "4vh" }}>Link this TV</div>
      <div style={{ fontSize: "16vh", fontWeight: 700, letterSpacing: "2vh", margin: "3vh 0", fontVariantNumeric: "tabular-nums" }}>
        {code.slice(0, 3)}&nbsp;{code.slice(3)}
      </div>
      <div style={{ fontSize: "3vh", lineHeight: 1.6, opacity: 0.85 }}>
        In One POS open <b>TV screens</b>, type this code under <b>TVs</b> and press <b>Add TV</b>.<br />
        The menu shows here by itself a few seconds later.
      </div>
    </div>
  );
}
