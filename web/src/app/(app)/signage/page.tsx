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
import { SignageStage } from "@/components/signage/stage";
import { previewUrls } from "@/components/signage/preview";
import { MediaThumb, UploadButton, type MediaRow } from "@/components/signage/media";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Screen = {
  id: string; deviceId: string; machine: string | null; monitorKey: string; detectedName: string | null; name: string; isOn: boolean;
  designId: string | null; designName: string | null; width: number | null; height: number | null; lastSeen: string | null; online: boolean;
};
type DesignRow = { id: string; branchId: string | null; name: string; updatedAt: string; screens: number };
type Overview = { enabled: boolean; screens: Screen[]; designs: DesignRow[]; media: MediaRow[] };

/**
 * TV screens: switch them on for the branch, see the TVs the tills found (name, on/off, what each plays), the designs and the
 * pictures and videos they use. Designs are built on their own page (Design).
 */
export default function SignagePage() {
  const { data, error, loading, reload } = useApi<Overview>("/signage");
  const preview = useApi<PlayData>(data?.enabled ? "/signage/preview-data" : null);
  useLiveEvent(["signage.changed"], () => reload());
  // Tills report every few seconds (TVs found, online): keep the page current while it is open.
  useEffect(() => { if (!data?.enabled) return; const t = window.setInterval(reload, 4000); return () => window.clearInterval(t); }, [data?.enabled, reload]);

  const setEnabled = async (on: boolean) => {
    try { await api("/signage/enabled", "PUT", { on }); toast.success(on ? "TV screens are on for this branch." : "TV screens are off for this branch."); reload(); }
    catch (e) { toast.error((e as Error).message); }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-10">
      <PageHeader title="TV screens" icon={TvIcon} module="admin"
        description="Menus and offers on the TVs connected to this branch's tills."
        actions={data && (
          <label className="flex items-center gap-2 text-sm font-medium">
            <Switch on={data.enabled} onChange={(on) => void setEnabled(on)} label="TV screens at this branch" />
            {data.enabled ? "On at this branch" : "Off at this branch"}
          </label>
        )} />
      <ErrorNote message={error} />
      {loading && !data ? <LoadingRows /> : data && !data.enabled ? (
        <EmptyState icon={TvIcon} title="TV screens are off at this branch">
          Switch them on above. Then connect a TV to a till as a second screen (cable, or wireless display with Win+K, set to Extend): the till finds it by itself and it shows up here.
        </EmptyState>
      ) : data && (
        <>
          <Tvs screens={data.screens} designs={data.designs} reload={reload} />
          <Designs designs={data.designs} preview={preview.data ?? null} media={data.media} reload={reload} />
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
    if (!(await confirmDialog({ title: `Remove ${s.name}?`, message: "If the TV is still connected to its till, it comes back as a new TV.", confirmLabel: "Remove", tone: "danger" }))) return;
    await api(`/signage/screens/${s.id}`, "DELETE").then(reload, (e: Error) => toast.error(e.message));
  };
  return (
    <section className="surface">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-3">
        <div>
          <h2 className="font-heading text-[0.95rem] font-semibold">TVs</h2>
          <p className="text-xs text-muted-foreground">Found by the tills. A new TV plays the first design until you choose another.</p>
        </div>
      </div>
      {screens.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted-foreground">
          No TVs yet. Connect a TV to a till as a second screen (Extend). With the One POS Device Service 1.4 or later on that till, it appears here within a few seconds.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr className="border-b"><th className="px-5 py-2 font-medium">TV</th><th className="px-3 py-2 font-medium">Till</th><th className="px-3 py-2 font-medium">Status</th><th className="px-3 py-2 font-medium">Plays</th><th className="px-3 py-2 font-medium">On</th><th /></tr>
            </thead>
            <tbody>
              {screens.map((s) => (
                <tr key={s.id} className="border-b last:border-0">
                  <td className="px-5 py-2.5">
                    <NameCell value={s.name} onSave={(name) => void save(s, { name })} />
                    <div className="text-xs text-muted-foreground">{s.detectedName ?? "TV"}{s.width ? ` · ${s.width}×${s.height}` : ""}</div>
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">{s.machine ?? "—"}</td>
                  <td className="px-3 py-2.5">
                    {!s.online ? <ObjectStatus className={TONE.muted}>Not connected</ObjectStatus>
                      : s.isOn && s.designId ? <ObjectStatus className={TONE.done}>Playing</ObjectStatus>
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

function NameCell({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  return (
    <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={60} className="h-7 w-44 font-medium" aria-label="TV name"
      onBlur={() => { const t = text.trim(); if (t && t !== value) onSave(t); else setText(value); }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
}

function Designs({ designs, preview, media, reload }: { designs: DesignRow[]; preview: PlayData | null; media: MediaRow[]; reload: () => void }) {
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
        <p className="px-5 py-6 text-sm text-muted-foreground">No designs yet. <b>New design</b> starts one with four ready-made slides from your menu.</p>
      ) : (
        <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
          {designs.map((d) => <DesignCard key={d.id} d={d} preview={preview} media={media} onCopy={() => void copy(d)} onDelete={() => void remove(d)} />)}
        </div>
      )}
    </section>
  );
}

function DesignCard({ d, preview, media, onCopy, onDelete }: { d: DesignRow; preview: PlayData | null; media: MediaRow[]; onCopy: () => void; onDelete: () => void }) {
  const full = useApi<{ content: DesignContent }>(`/signage/designs/${d.id}?v=${encodeURIComponent(d.updatedAt)}`);
  const content = useMemo(() => (full.data ? normalize(full.data.content) : null), [full.data]);
  const urls = useMemo(() => previewUrls(preview, media.filter((m) => m.kind === "video").map((m) => m.id)), [preview, media]);
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <Link href={`/signage/design?id=${d.id}`} className="block bg-black">
        {content ? <SignageStage content={content} data={preview} urls={urls} /> : <div className="aspect-video" />}
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
