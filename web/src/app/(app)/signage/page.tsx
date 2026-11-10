"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CopyIcon, Loader2Icon, PencilIcon, PlusIcon, Trash2Icon, TvIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { withBase } from "@/lib/base-path";
import { normalize, starterDesign, type DesignContent, type PlayData } from "@/lib/signage";
import { useLiveEvent } from "@/components/live";
import { confirmDialog } from "@/components/confirm";
import { EmptyState, ErrorNote, LoadingRows, ObjectStatus, PageHeader, Switch, TONE, selectClass } from "@/components/kit";
import { TvFrame } from "@/components/signage/tv-frame";
import { MediaThumb, UploadButton, type MediaRow } from "@/components/signage/media";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Screen = {
  id: string; detected: string | null; name: string; isOn: boolean;
  designId: string | null; designName: string | null; width: number | null; height: number | null; lastSeen: string | null; online: boolean;
};
type DesignRow = { id: string; branchId: string | null; name: string; updatedAt: string; screens: number };
type Overview = { enabled: boolean; screens: Screen[]; designs: DesignRow[]; media: MediaRow[] };

/**
 * TV screens: switch them on for the branch, link TVs by the code each shows (name, on/off, what each plays), the designs and the
 * pictures and videos they use. Designs are built on their own page (Design).
 */
export default function SignagePage() {
  const { data, error, loading, reload } = useApi<Overview>("/signage");
  const preview = useApi<PlayData>(data?.enabled ? "/signage/preview-data" : null);
  useLiveEvent(["signage.changed"], () => reload());
  // TVs ask the server every few seconds (online or not): keep the page current while it is open.
  useEffect(() => { if (!data?.enabled) return; const t = window.setInterval(reload, 10_000); return () => window.clearInterval(t); }, [data?.enabled, reload]);

  const setEnabled = async (on: boolean) => {
    try { await api("/signage/enabled", "PUT", { on }); toast.success(on ? "TV screens are on for this branch." : "TV screens are off for this branch."); reload(); }
    catch (e) { toast.error((e as Error).message); }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-10">
      <PageHeader title="TV screens" icon={TvIcon} module="admin"
        description="Menus and offers on this branch's TVs, from each TV's own browser."
        actions={data && (
          <label className="flex items-center gap-2 text-sm font-medium">
            <Switch on={data.enabled} onChange={(on) => void setEnabled(on)} label="TV screens at this branch" />
            {data.enabled ? "On at this branch" : "Off at this branch"}
          </label>
        )} />
      <ErrorNote message={error} />
      {loading && !data ? <LoadingRows /> : data && !data.enabled ? (
        <EmptyState icon={TvIcon} title="TV screens are off at this branch">
          Switch them on above. Then open <b>{tvAddress()}</b> in the TV&apos;s web browser and type the code it shows under TVs here.
        </EmptyState>
      ) : data && (
        <>
          <Tvs screens={data.screens} designs={data.designs} reload={reload} />
          <Designs designs={data.designs} preview={preview.data ?? null} reload={reload} />
          <Media media={data.media} companyId={preview.data?.companyId ?? null} reload={reload} />
        </>
      )}
    </div>
  );
}

function Tvs({ screens, designs, reload }: { screens: Screen[]; designs: DesignRow[]; reload: () => void }) {
  const save = async (s: Screen, body: Record<string, unknown>) => {
    try { await api(`/signage/screens/${s.id}`, "PUT", body); reload(); } catch (e) { toast.error((e as Error).message); }
  };
  const remove = async (s: Screen) => {
    if (!(await confirmDialog({ title: `Remove ${s.name}?`, message: "The TV stops showing menus and shows a new code. Type that code here to link it again.", confirmLabel: "Remove", tone: "danger" }))) return;
    await api(`/signage/screens/${s.id}`, "DELETE").then(reload, (e: Error) => toast.error(e.message));
  };
  return (
    <section className="surface">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-3">
        <div>
          <h2 className="font-heading text-[0.95rem] font-semibold">TVs</h2>
          <p className="text-xs text-muted-foreground">On the TV, open <b className="text-foreground">{tvAddress()}</b> in its web browser and type the code it shows. A new TV plays the first design until you choose another.</p>
        </div>
      </div>
      <AddTv reload={reload} />
      {screens.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted-foreground">
          No TVs yet. Then add the page to the TV&apos;s home screen (for example <b>Add to launcher</b> or <b>Add to Home</b> in its browser), so staff only press that icon.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b"><th className="px-5 py-2 font-medium">TV</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 font-medium">Plays</th><th className="px-3 py-2 font-medium">On</th><th /></tr>
            </thead>
            <tbody>
              {screens.map((s) => (
                <tr key={s.id} className="border-b last:border-0">
                  <td className="px-5 py-2.5">
                    <NameCell value={s.name} onSave={(name) => void save(s, { name })} />
                    <div className="text-xs text-muted-foreground">{s.detected ?? "TV"}{s.width ? ` · ${s.width}×${s.height}` : ""}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    {!s.online ? <ObjectStatus className={TONE.muted} title={s.lastSeen ? `Last seen ${new Date(s.lastSeen).toLocaleString()}` : undefined}>Not showing</ObjectStatus>
                      : s.isOn && s.designId ? <ObjectStatus className={TONE.done}>Showing</ObjectStatus>
                      : <ObjectStatus className={TONE.warn}>Black</ObjectStatus>}
                  </td>
                  <td className="px-3 py-2.5">
                    <select className={selectClass} value={s.designId ?? ""} aria-label={`What ${s.name} plays`}
                      onChange={(e) => void save(s, e.target.value ? { designId: e.target.value } : { clearDesign: true })}>
                      <option value="">Nothing (black)</option>
                      {designs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2.5"><Switch on={s.isOn} onChange={(on) => void save(s, { isOn: on })} label={`${s.name} on`} /></td>
                  <td className="px-3 py-2.5 text-right"><Button variant="ghost" size="icon-sm" aria-label={`Remove ${s.name}`} onClick={() => void remove(s)}><Trash2Icon /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The address a TV opens (this installation's TV page). */
function tvAddress() {
  return typeof window === "undefined" ? "/tv" : `${window.location.host}${withBase("/tv")}`;
}

function AddTv({ reload }: { reload: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/signage/screens", "POST", { code, name: name.trim() || null });
      toast.success("TV added. It shows the menu in a few seconds.");
      setCode(""); setName(""); reload();
    } catch (err) { toast.error((err as Error).message); }
    setBusy(false);
  };
  return (
    <form onSubmit={(e) => void add(e)} className="flex flex-wrap items-end gap-3 border-b bg-muted/30 px-5 py-3">
      <label className="grid gap-1 text-xs font-medium">Code on the TV
        <Input value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))} inputMode="numeric" placeholder="123456"
          className="h-8 w-32 font-mono text-base tracking-widest" aria-label="Code on the TV" />
      </label>
      <label className="grid gap-1 text-xs font-medium">Name (optional)
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Counter TV" className="h-8 w-44" />
      </label>
      <Button type="submit" disabled={busy || code.length !== 6}>{busy ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}Add TV</Button>
    </form>
  );
}

function NameCell({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  return (
    <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={60} className="h-7 w-44 font-medium" aria-label="TV name"
      onBlur={() => { const t = text.trim(); if (t && t !== value) onSave(t); else setText(value); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
}

function Designs({ designs, preview, reload }: { designs: DesignRow[]; preview: PlayData | null; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const { id } = await api<{ id: string }>("/signage/designs", "POST", { name: `Design ${designs.length + 1}`, content: starterDesign(preview) });
      window.location.href = withBase(`/signage/design?id=${id}`);
    } catch (e) { toast.error((e as Error).message); setBusy(false); }
  };
  const copy = async (d: DesignRow) => {
    try {
      const full = await api<{ content: DesignContent; branchId: string | null }>(`/signage/designs/${d.id}`);
      await api("/signage/designs", "POST", { name: `${d.name} (copy)`.slice(0, 80), content: full.content, allBranches: full.branchId === null });
      reload();
    } catch (e) { toast.error((e as Error).message); }
  };
  const remove = async (d: DesignRow) => {
    if (!(await confirmDialog({ title: `Delete ${d.name}?`, message: d.screens ? `${d.screens} TV${d.screens > 1 ? "s" : ""} playing it will go black.` : undefined, confirmLabel: "Delete", tone: "danger" }))) return;
    await api(`/signage/designs/${d.id}`, "DELETE").then(reload, (e: Error) => toast.error(e.message));
  };
  return (
    <section className="surface">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-3">
        <div>
          <h2 className="font-heading text-[0.95rem] font-semibold">Designs</h2>
          <p className="text-xs text-muted-foreground">Slides of menus, offers and pictures, with animations. Prices and photos come from the menu.</p>
        </div>
        <Button onClick={() => void create()} disabled={busy}>{busy ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}New design</Button>
      </div>
      {designs.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted-foreground">No designs yet. <b>New design</b> starts one with five ready-made slides from your menu.</p>
      ) : (
        <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
          {designs.map((d) => <DesignCard key={d.id} d={d} preview={preview} onCopy={() => void copy(d)} onDelete={() => void remove(d)} />)}
        </div>
      )}
    </section>
  );
}

function DesignCard({ d, preview, onCopy, onDelete }: { d: DesignRow; preview: PlayData | null; onCopy: () => void; onDelete: () => void }) {
  const full = useApi<{ content: DesignContent }>(`/signage/designs/${d.id}?v=${encodeURIComponent(d.updatedAt)}`);
  const content = useMemo(() => (full.data ? normalize(full.data.content) : null), [full.data]);
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <Link href={`/signage/design?id=${d.id}`} className="block bg-black">
        <TvFrame content={content} data={preview} />
      </Link>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{d.name}</div>
          <div className="text-xs text-muted-foreground">{d.branchId ? "This branch" : "All branches"} · {d.screens ? `${d.screens} TV${d.screens > 1 ? "s" : ""}` : "Not on a TV"}</div>
        </div>
        <Button variant="outline" size="sm" nativeButton={false} render={<Link href={`/signage/design?id=${d.id}`} />}><PencilIcon />Edit</Button>
        <Button variant="ghost" size="icon-sm" aria-label={`Copy ${d.name}`} onClick={onCopy}><CopyIcon /></Button>
        <Button variant="ghost" size="icon-sm" aria-label={`Delete ${d.name}`} onClick={onDelete}><Trash2Icon /></Button>
      </div>
    </div>
  );
}

function Media({ media, companyId, reload }: { media: MediaRow[]; companyId: string | null; reload: () => void }) {
  return (
    <section className="surface">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-3">
        <div>
          <h2 className="font-heading text-[0.95rem] font-semibold">Pictures and videos</h2>
          <p className="text-xs text-muted-foreground">For backgrounds, offers and full-screen slides. Pictures up to 5 MB, MP4 or WebM videos up to 25 MB.</p>
        </div>
        <UploadButton onDone={reload} />
      </div>
      {media.length === 0 ? <p className="px-5 py-6 text-sm text-muted-foreground">None yet.</p> : (
        <div className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-4 lg:grid-cols-6">
          {media.map((m) => <MediaThumb key={m.id} m={m} companyId={companyId} onDeleted={reload} />)}
        </div>
      )}
    </section>
  );
}
