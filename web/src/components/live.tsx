"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { HubConnectionBuilder, HubConnectionState, LogLevel, type HubConnection } from "@microsoft/signalr";
import { withBase } from "@/lib/base-path";
import { CONNECTION_EVENT } from "@/lib/api";
import { useSession } from "@/components/session";

/*
 * Live updates (REQ NFR-02): one connection per browser to /hubs/live, joined to the current branch. Screens subscribe to event
 * kinds with useLiveEvent and re-read what they show. The connection state feeds the "Reconnecting…" banner (REQ ONL-03).
 */

export type LiveEvent = { kind: string; data?: unknown; at: string };
type Listener = (e: LiveEvent) => void;

const LiveContext = createContext<{ subscribe: (l: Listener) => () => void; online: boolean }>({ subscribe: () => () => {}, online: true });

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const { branch, refresh } = useSession();
  const listeners = useRef(new Set<Listener>());
  const conn = useRef<HubConnection | null>(null);
  const [online, setOnline] = useState(true);
  // Bumped on every successful (re)connect, so the branch is joined again.
  const [connected, setConnected] = useState(0);

  useEffect(() => {
    const c = new HubConnectionBuilder().withUrl(withBase("/hubs/live")).withAutomaticReconnect([0, 1000, 2000, 5000, 10000, 15000])
      .configureLogging(LogLevel.Warning).build();
    conn.current = c;
    c.on("event", (e: LiveEvent) => listeners.current.forEach((l) => l(e)));
    c.onreconnecting(() => setOnline(false));
    c.onreconnected(() => { setOnline(true); setConnected((n) => n + 1); listeners.current.forEach((l) => l({ kind: "reconnected", at: new Date().toISOString() })); });
    c.onclose(() => setOnline(false));
    let stopped = false;
    const started = c.start().then(() => { if (!stopped) { setOnline(true); setConnected((n) => n + 1); } }).catch(() => { if (!stopped) setOnline(false); });
    // Stop only once the start has settled: stopping mid-negotiation (React's double mount in development) logs an error.
    return () => { stopped = true; void started.finally(() => c.stop()); };
  }, []);

  // Join the current branch's group, again after every (re)connect and on a branch switch.
  useEffect(() => {
    const c = conn.current;
    if (!c || !branch || !connected) return;
    c.invoke("JoinBranch", branch.id).catch(() => {});
    return () => { if (c.state === HubConnectionState.Connected) c.invoke("LeaveBranch", branch.id).catch(() => {}); };
  }, [branch, connected]);

  // Company-wide changes that alter what the session shows (branches added or renamed): reload /me.
  useEffect(() => {
    const set = listeners.current;
    const l: Listener = (e) => { if (e.kind === "branches.changed" || e.kind === "branch.changed") void refresh(); };
    set.add(l);
    return () => { set.delete(l); };
  }, [refresh]);

  // Plain requests failing to connect count too.
  useEffect(() => {
    const on = (e: Event) => setOnline((e as CustomEvent).detail === "up");
    window.addEventListener(CONNECTION_EVENT, on);
    return () => window.removeEventListener(CONNECTION_EVENT, on);
  }, []);

  const subscribe = useCallback((l: Listener) => { listeners.current.add(l); return () => { listeners.current.delete(l); }; }, []);
  const value = useMemo(() => ({ subscribe, online }), [subscribe, online]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

/** Runs `handler` for live events whose kind is in `kinds` (prefix match with "*", e.g. "order.*"). */
export function useLiveEvent(kinds: string[], handler: (e: LiveEvent) => void) {
  const { subscribe } = useContext(LiveContext);
  const h = useRef(handler);
  useEffect(() => { h.current = handler; });
  const key = kinds.join("|");
  useEffect(() => subscribe((e) => {
    if (key.split("|").some((k) => (k.endsWith("*") ? e.kind.startsWith(k.slice(0, -1)) : e.kind === k))) h.current(e);
  }), [subscribe, key]);
}

export const useOnline = () => useContext(LiveContext).online;
