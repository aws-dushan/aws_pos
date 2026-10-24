"use client";

import { useSyncExternalStore } from "react";
import { appStorage } from "@/lib/base-path";

/*
 * Browser-only values read without a setState-in-effect: the server renders the fallback (null), the browser the real value,
 * and React re-renders when it changes (React's useSyncExternalStore).
 */

const STORAGE_EVENT = "onepos:storage";

function readStored(key: string): string | null {
  try {
    return appStorage.getItem(key);
  } catch {
    return null; // storage unavailable (private window, blocked site data)
  }
}

/** A value in this browser's storage (per installation); changes made with setStored or in another tab show at once. */
export function useStored(key: string): string | null {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener("storage", onChange);
      window.addEventListener(STORAGE_EVENT, onChange);
      return () => {
        window.removeEventListener("storage", onChange);
        window.removeEventListener(STORAGE_EVENT, onChange);
      };
    },
    () => readStored(key),
    () => null,
  );
}

/** Writes (or with null, removes) a stored value and tells every useStored reader. */
export function setStored(key: string, value: string | null) {
  try {
    if (value === null) appStorage.removeItem(key);
    else appStorage.setItem(key, value);
  } catch {
    // storage unavailable: the value just isn't remembered
  }
  window.dispatchEvent(new Event(STORAGE_EVENT));
}

/** The current time, updated every `stepMs` (rounded down to the step); null while rendering on the server. */
export function useNow(stepMs = 15000): Date | null {
  const tick = useSyncExternalStore(
    (onChange) => {
      const t = window.setInterval(onChange, Math.min(stepMs, 5000));
      return () => window.clearInterval(t);
    },
    () => Math.floor(Date.now() / stepMs),
    () => 0,
  );
  return tick ? new Date(tick * stepMs) : null;
}

/** Whether a CSS media query matches now (and follows it as the window changes). False while rendering on the server. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", onChange);
      return () => m.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
