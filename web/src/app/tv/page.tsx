"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { withBase } from "@/lib/base-path";
import { normalize, type DesignContent, type PlayData } from "@/lib/signage";
import { SignageStage, type MediaUrls } from "@/components/signage/stage";

type Play = {
  screen: { id: string; name: string; isOn: boolean };
  design: { id: string; name: string; content: DesignContent; updatedAt: string } | null;
  data: PlayData;
};

/**
 * One TV (opened full screen by the till's tray app: /tv?screen=…&t=…). Asks the server every 10 seconds what this TV shows:
 * off is plain black; on plays its design with the branch's menu, prices and counts. Keeps the last answer when the
 * server can't be reached, so a short internet drop doesn't blank the TV.
 */
export default function TvPage() {
  return <Suspense fallback={null}><Tv /></Suspense>;
}

function Tv() {
  const params = useSearchParams();
  const screen = params.get("screen"), token = params.get("t");
  const q = useMemo(() => (screen && token ? { screen, token } : null), [screen, token]);
  const [play, setPlay] = useState<Play | null>(null);
  const [error, setError] = useState<string | null>(q ? null : "This TV page needs its screen and key. The One POS tray app opens it.");
  const failures = useRef(0);

  useEffect(() => {
    if (!q) return;
    let stop = false;
    const load = async () => {
      try {
        const res = await fetch(withBase(`/api/public/signage/play/${q.screen}`), { headers: { "X-Signage-Token": q.token }, cache: "no-store" });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `The server answered ${res.status}.`);
        const next = (await res.json()) as Play;
        next.data.serverTime = "";   // changes every time; not a reason to redraw
        if (stop) return;
        failures.current = 0;
        setError(null);
        setPlay((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      } catch (e) {
        failures.current += 1;
        // Keep playing what we have; say so only when there's nothing to show.
        if (!stop) setError((e as Error).message);
      }
    };
    void load();
    const t = window.setInterval(load, 10_000);
    return () => { stop = true; window.clearInterval(t); };
  }, [q]);

  // Pictures change address when the design is saved again, so a TV never shows a stale picture.
  const designJson = play?.design ? JSON.stringify(play.design.content) : null;
  const content = useMemo(() => (designJson ? normalize(JSON.parse(designJson) as DesignContent) : null), [designJson]);
  const urls = useMemo<MediaUrls | null>(() => {
    if (!q || !play) return null;
    const t = encodeURIComponent(q.token);
    const d = play.data;
    const videos = new Set(d.videos ?? []);
    return {
      media: (id) => withBase(`/api/public/signage/media/${id}?t=${t}`),
      isVideo: (id) => videos.has(id),
      item: (i) => (i.imageAt ? withBase(`/api/public/signage/items/${i.id}?t=${t}&v=${encodeURIComponent(i.imageAt)}`) : null),
      logo: d.logoAt ? withBase(`/api/public/signage/logo/${d.branchId}?t=${t}&v=${encodeURIComponent(d.logoAt)}`) : null,
    };
  }, [q, play]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000", display: "grid", placeItems: "center", overflow: "hidden", cursor: "none" }}>
      {play?.screen.isOn && content && urls ? (
        <div style={{ width: "min(100vw, calc(100vh * 16 / 9))" }}>
          <SignageStage content={content} data={play.data} urls={urls} key={play.design!.id + play.design!.updatedAt} />
        </div>
      ) : !play && error ? (
        <p style={{ color: "#777", font: "500 18px system-ui", textAlign: "center", maxWidth: 600 }}>{error}</p>
      ) : null}
    </div>
  );
}
