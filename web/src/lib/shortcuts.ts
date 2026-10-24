/**
 * The one list of keyboard shortcuts (as AWS One's lib/shortcuts.ts): the shortcuts sheet (? key), button tooltips (shortcutTitle)
 * and the global key handler (components/app-shell.tsx: matches) all read it, so what is shown and what happens can't drift apart.
 * A page shortcut presses the visible button marked data-shortcut="<id>"; nothing happens when the screen has none.
 */

export type ShortcutGroup = "Everywhere" | "Lists" | "Register";

export type Shortcut = {
  id: string;
  /** Keys as shown, separated by two spaces for separate keys ("↑ ↓  Enter"); one key combo is "Alt R". */
  keys: string;
  description: string;
  group: ShortcutGroup;
  /** Applies to the current screen (path, and what is on it); absent = everywhere. */
  scope?: (path: string, doc: Document) => boolean;
};

const has = (doc: Document, sel: string) => !!doc.querySelector(sel);
const onButton = (id: string) => (_: string, doc: Document) => has(doc, `[data-shortcut=${id}]`);

export const SHORTCUTS: Shortcut[] = [
  { id: "help", keys: "?", description: "Keyboard shortcuts (this list)", group: "Everywhere" },
  { id: "reportProblem", keys: "Alt R", description: "Report a problem on this screen (with a screenshot)", group: "Everywhere" },
  { id: "cancel", keys: "Esc", description: "Close a dialog, cancel editing", group: "Everywhere" },
  { id: "search", keys: "/", description: "Search the list or menu on screen", group: "Lists", scope: (_, doc) => has(doc, "[data-list-search]") },
  { id: "new", keys: "Alt N", description: "New order (on the register: a takeaway)", group: "Register", scope: onButton("new") },
  { id: "send", keys: "F8", description: "Send the new items to the kitchen", group: "Register", scope: onButton("send") },
  { id: "bill", keys: "F7", description: "Print the bill", group: "Register", scope: onButton("bill") },
  { id: "pay", keys: "F9", description: "Pay the order", group: "Register", scope: onButton("pay") },
];

export const SHORTCUT_GROUPS: ShortcutGroup[] = ["Everywhere", "Lists", "Register"];

export const shortcut = (id: string) => SHORTCUTS.find((s) => s.id === id);

/** A button's tooltip with its shortcut: "Pay the order · F9". */
export function shortcutTitle(id: string, label?: string) {
  const s = shortcut(id);
  return s ? `${label ?? s.description} · ${s.keys}` : label ?? "";
}

const ARROWS: Record<string, string> = { "↑": "ArrowUp", "↓": "ArrowDown", "←": "ArrowLeft", "→": "ArrowRight" };

/** True when the key event is this shortcut (single combos only: "Alt R", "F9", "?", "/"). */
export function matches(id: string, e: KeyboardEvent) {
  const s = shortcut(id);
  if (!s) return false;
  const parts = s.keys.split(" ");
  const key = parts[parts.length - 1];
  const ctrl = parts.includes("Ctrl"), alt = parts.includes("Alt"), shift = parts.includes("Shift");
  if (ctrl !== (e.ctrlKey || e.metaKey) || alt !== e.altKey) return false;
  // Shift is part of the combo for letters, arrows and named keys ("Alt N" is not "Alt Shift N"); typed symbols like "?" carry their own Shift.
  const letter = key.length === 1 && /[a-z]/i.test(key);
  if ((letter || key.length > 1 || key in ARROWS) && shift !== e.shiftKey) return false;
  if (letter) return e.key.toLowerCase() === key.toLowerCase() || e.code === `Key${key.toUpperCase()}`;
  return e.key === (ARROWS[key] ?? key);
}
