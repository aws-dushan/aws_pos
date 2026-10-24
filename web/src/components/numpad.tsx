"use client";

import { useEffect, useRef } from "react";
import { DeleteIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The on-screen number pad of the touch tills (REQ UX-04): amounts, quantities, PINs. Large keys with press feedback. The
 * keyboard works too (digits, ".", Backspace, Delete clears, Enter = onEnter) unless typing is in a text field.
 * `decimals`: allow one "." and at most that many digits after it. `max`: the longest value (characters).
 * `pristine`: the value shown was filled in for the cashier (e.g. the amount due), so the first key replaces it (onTouch then).
 */
export function Numpad({ value, onChange, decimals = 2, max = 9, size = "md", className, keyboard = true, onEnter, pristine, onTouch }: {
  value: string; onChange: (v: string) => void; decimals?: number; max?: number; size?: "md" | "lg"; className?: string;
  keyboard?: boolean; onEnter?: () => void; pristine?: boolean; onTouch?: () => void;
}) {
  // What the pad holds right now: keys pressed faster than the screen updates (a quick typist, a USB keypad) build on each other.
  const cur = useRef({ value, pristine });
  useEffect(() => { cur.current = { value, pristine }; }, [value, pristine]);
  const set = (v: string) => { cur.current = { value: v, pristine: false }; onChange(v); };
  const press = (k: string) => {
    const base = cur.current.pristine ? "" : cur.current.value;
    if (cur.current.pristine) onTouch?.();
    if (k === "back") return set(base.slice(0, -1));
    if (k === "clear") return set("");
    if (k === ".") {
      if (!decimals || base.includes(".")) return;
      return set((base || "0") + ".");
    }
    if (base.length >= max) return;
    const dot = base.indexOf(".");
    if (dot >= 0 && base.length - dot > decimals) return;
    set(base === "0" ? k : base + k);
  };
  // The keyboard (and a USB keypad): the latest press/onEnter, so the listener never works on an old value.
  const latest = useRef({ press, onEnter });
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { latest.current = { press, onEnter }; });
  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Two pads on screen (e.g. a manager's PIN over a refund amount): only the one in the front-most window takes the keys.
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs.length && box.current && !dialogs[dialogs.length - 1].contains(box.current)) return;
      let k: string | null = null;
      if (/^[0-9]$/.test(e.key)) k = e.key;
      else if (e.key === "." || e.key === ",") k = ".";
      else if (e.key === "Backspace") k = "back";
      else if (e.key === "Delete") k = "clear";
      else if (e.key === "Enter") {
        // Enter is the screen's main button (Add, Pay, Approve…), never a key of the pad again.
        if (t?.tagName === "BUTTON" && box.current?.contains(t)) t.blur();
        if (latest.current.onEnter) { e.preventDefault(); latest.current.onEnter(); }
        return;
      }
      if (k) { e.preventDefault(); latest.current.press(k); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keyboard]);

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", decimals ? "." : "clear", "0", "back"];
  return (
    <div ref={box} className={cn("grid grid-cols-3 gap-2", className)}>
      {keys.map((k) => (
        <button key={k} type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => press(k)} aria-label={k === "back" ? "Delete" : k === "clear" ? "Clear" : k}
          className={cn("flex items-center justify-center rounded-xl border bg-card font-heading font-medium shadow-soft transition-[transform,background-color] duration-100 select-none hover:bg-muted active:scale-[0.94]",
            size === "lg" ? "h-16 text-2xl" : "h-13 text-xl", (k === "back" || k === "clear") && "text-base font-normal text-muted-foreground")}>
          {k === "back" ? <DeleteIcon className="size-5" /> : k === "clear" ? "Clear" : k}
        </button>
      ))}
    </div>
  );
}
