"use client";

import { useMemo, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, FilterIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchField } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

type Cell = string | number;
/** A column's filter: the values ticked (text), or from / to (amounts). */
export type ColumnFilter = { values?: string[]; min?: number | null; max?: number | null };

/** A cell as a number, where it is one ("1,234.50", "12.5%", "-20.00", "#12"); else null (dates, names and "—" are not). */
export function cellNumber(v: Cell): number | null {
  if (typeof v === "number") return v;
  const t = v.trim();
  return /^#?-?\d[\d,]*(\.\d+)?%?$/.test(t) ? Number(t.replace(/[#,%]/g, "")) : null;
}
const text = (v: Cell) => String(v ?? "");

/**
 * Search, sort and per-column filters for a report table: the rows shown (as their indexes in the table, so a row's own links still
 * work), in order. Everything starts again when `resetKey` changes (another tab, other dates).
 */
export function useTableView(head: string[] | undefined, rows: Cell[][] | undefined, resetKey: string) {
  const [state, setState] = useState<{ key: string; search: string; sort: { col: number; dir: 1 | -1 } | null; filters: Record<number, ColumnFilter> }>(
    { key: resetKey, search: "", sort: null, filters: {} });
  const s = state.key === resetKey ? state : { key: resetKey, search: "", sort: null, filters: {} };
  if (s !== state) setState(s);
  const numeric = useMemo(() => (head ?? []).map((_, i) => !!rows?.length && rows.every((r) => cellNumber(r[i]) !== null || r[i] === "—" || r[i] === "")), [head, rows]);

  const shown = useMemo(() => {
    if (!rows) return [];
    const q = s.search.trim().toLowerCase();
    let idx = rows.map((_, i) => i).filter((i) => {
      const r = rows[i];
      if (q && !r.some((v) => text(v).toLowerCase().includes(q))) return false;
      return Object.entries(s.filters).every(([c, f]) => {
        const v = r[Number(c)];
        if (f.values) return f.values.includes(text(v));
        const n = cellNumber(v);
        if (f.min != null && (n === null || n < f.min)) return false;
        if (f.max != null && (n === null || n > f.max)) return false;
        return true;
      });
    });
    if (s.sort) {
      const { col, dir } = s.sort;
      idx = [...idx].sort((a, b) => {
        const x = rows[a][col], y = rows[b][col];
        const nx = cellNumber(x), ny = cellNumber(y);
        const c = numeric[col] && nx !== null && ny !== null ? nx - ny : text(x).localeCompare(text(y), "en", { numeric: true });
        return c * dir;
      });
    }
    return idx;
  }, [rows, s.search, s.filters, s.sort, numeric]);

  const set = (patch: Partial<typeof s>) => setState({ ...s, ...patch });
  return {
    search: s.search, sort: s.sort, filters: s.filters, numeric, shown,
    setSearch: (search: string) => set({ search }),
    /** Heading clicked: lowest first, then highest first, then as it came. */
    toggleSort: (col: number) => set({ sort: s.sort?.col !== col ? { col, dir: numeric[col] ? -1 : 1 } : s.sort.dir === (numeric[col] ? -1 : 1) ? { col, dir: numeric[col] ? 1 : -1 } : null }),
    setFilter: (col: number, f: ColumnFilter | null) => { const filters = { ...s.filters }; if (f) filters[col] = f; else delete filters[col]; set({ filters }); },
    clear: () => set({ search: "", filters: {} }),
    active: !!s.search.trim() || Object.keys(s.filters).length > 0,
  };
}

/** A column heading: click to sort; ▾ opens its filter (tick values, or from / to for amounts). */
export function FilterHeading({ label, col, view, rows, align }: {
  label: string; col: number; view: ReturnType<typeof useTableView>; rows: Cell[][]; align?: "right";
}) {
  const f = view.filters[col];
  const sorted = view.sort?.col === col ? view.sort.dir : 0;
  return (
    <span className={cn("inline-flex items-center gap-1", align === "right" && "flex-row-reverse")}>
      <button type="button" onClick={() => view.toggleSort(col)} className="inline-flex items-center gap-1 hover:text-foreground" title="Sort">
        {label}{sorted === 1 ? <ArrowUpIcon className="size-3" /> : sorted === -1 ? <ArrowDownIcon className="size-3" /> : null}
      </button>
      <Popover>
        <PopoverTrigger render={<button type="button" aria-label={`Filter ${label}`} className={cn("rounded p-0.5 hover:bg-muted", f ? "text-primary" : "text-muted-foreground/60")} />}>
          {f ? <FilterIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
        </PopoverTrigger>
        <PopoverContent align={align === "right" ? "end" : "start"} className="w-72 p-3">
          {view.numeric[col] ? <RangeFilter label={label} value={f} onChange={(v) => view.setFilter(col, v)} />
            : <ValuesFilter label={label} values={rows.map((r) => text(r[col]))} value={f} onChange={(v) => view.setFilter(col, v)} />}
        </PopoverContent>
      </Popover>
    </span>
  );
}

function ValuesFilter({ label, values, value, onChange }: { label: string; values: string[]; value?: ColumnFilter; onChange: (f: ColumnFilter | null) => void }) {
  const counts = useMemo(() => { const m = new Map<string, number>(); for (const v of values) m.set(v, (m.get(v) ?? 0) + 1); return [...m].sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true })); }, [values]);
  const [q, setQ] = useState("");
  const ticked = new Set(value?.values ?? counts.map(([v]) => v));
  const list = counts.filter(([v]) => !q.trim() || v.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (v: string) => {
    const n = new Set(ticked); if (n.has(v)) n.delete(v); else n.add(v);
    onChange(n.size === counts.length ? null : { values: [...n] });
  };
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      {counts.length > 8 && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a value" className="h-8" />}
      <div className="flex gap-2 text-xs">
        <button type="button" className="text-primary hover:underline" onClick={() => onChange(null)}>All</button>
        <button type="button" className="text-primary hover:underline" onClick={() => onChange({ values: [] })}>None</button>
        {q.trim() && <button type="button" className="text-primary hover:underline" onClick={() => onChange({ values: list.map(([v]) => v) })}>Only these</button>}
      </div>
      <div className="max-h-64 space-y-0.5 overflow-y-auto">
        {list.map(([v, n]) => (
          <label key={v} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted">
            <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={ticked.has(v)} onChange={() => toggle(v)} />
            <span className="min-w-0 flex-1 truncate">{v === "" ? "(empty)" : v}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{n}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function RangeFilter({ label, value, onChange }: { label: string; value?: ColumnFilter; onChange: (f: ColumnFilter | null) => void }) {
  const [min, setMin] = useState(value?.min?.toString() ?? "");
  const [max, setMax] = useState(value?.max?.toString() ?? "");
  const apply = (a: string, b: string) => {
    const lo = a.trim() === "" ? null : Number(a), hi = b.trim() === "" ? null : Number(b);
    onChange(lo === null && hi === null ? null : { min: lo, max: hi });
  };
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2">
        <Input value={min} inputMode="decimal" placeholder="From" className="h-8" onChange={(e) => { setMin(e.target.value); apply(e.target.value, max); }} />
        <span className="text-muted-foreground">–</span>
        <Input value={max} inputMode="decimal" placeholder="To" className="h-8" onChange={(e) => { setMax(e.target.value); apply(min, e.target.value); }} />
      </div>
      {(min || max) && <button type="button" className="text-xs text-primary hover:underline" onClick={() => { setMin(""); setMax(""); onChange(null); }}>Clear</button>}
    </div>
  );
}

/** Above the table: the search, what's filtered (each removable), and how many rows show. */
export function FilterBar({ view, head, total, search = true }: { view: ReturnType<typeof useTableView>; head: string[]; total: number; search?: boolean }) {
  const chips = Object.entries(view.filters).map(([c, f]) => {
    const name = head[Number(c)];
    const what = f.values ? (f.values.length === 0 ? "none" : f.values.length <= 2 ? f.values.map((v) => v || "(empty)").join(", ") : `${f.values.length} values`)
      : f.min != null && f.max != null ? `${f.min} – ${f.max}` : f.min != null ? `≥ ${f.min}` : `≤ ${f.max}`;
    return { col: Number(c), label: `${name}: ${what}` };
  });
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {search && <SearchField value={view.search} onChange={(e) => view.setSearch(e.target.value)} placeholder="Search this table" className="h-9 w-64" />}
      {chips.map((c) => (
        <span key={c.col} className="inline-flex h-8 items-center gap-1 rounded-full border bg-primary/5 pr-1 pl-3 text-xs text-primary">
          {c.label}
          <button type="button" aria-label={`Remove filter ${c.label}`} className="rounded-full p-0.5 hover:bg-primary/10" onClick={() => view.setFilter(c.col, null)}><XIcon className="size-3.5" /></button>
        </span>
      ))}
      {view.active && <Button variant="ghost" size="sm" onClick={view.clear}>Clear all</Button>}
      {view.active && <span className="text-xs text-muted-foreground">{view.shown.length} of {total} rows</span>}
    </div>
  );
}
