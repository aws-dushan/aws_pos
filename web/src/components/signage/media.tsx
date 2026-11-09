/* eslint-disable @next/next/no-img-element -- the company's own uploads, same origin */
"use client";

import { useRef, useState } from "react";
import { FilmIcon, ImagePlusIcon, Loader2Icon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { api, apiUpload } from "@/lib/api";
import { withBase } from "@/lib/base-path";
import { confirmDialog } from "@/components/confirm";
import { Button } from "@/components/ui/button";

export type MediaRow = { id: string; kind: "image" | "video"; name: string | null; bytes: number; createdAt: string };

/** A picture or video of the TV screens' library; `onPick` makes it choosable (the designer), `onDeleted` removable. */
export function MediaThumb({ m, companyId, onDeleted, onPick, picked }: { m: MediaRow; companyId: string | null; onDeleted?: () => void; onPick?: () => void; picked?: boolean }) {
  const src = withBase(`/api/public/signage/media/${m.id}?co=${companyId ?? ""}`);
  const remove = async () => {
    if (!(await confirmDialog({ title: "Remove this picture?", message: "Slides using it show without it.", confirmLabel: "Remove", tone: "danger" }))) return;
    await api(`/signage/media/${m.id}`, "DELETE").then(() => onDeleted?.(), (e: Error) => toast.error(e.message));
  };
  return (
    <div className={`group relative overflow-hidden rounded-lg border bg-muted ${picked ? "ring-2 ring-primary" : ""}`}>
      <button type="button" className="block aspect-video w-full" onClick={onPick} disabled={!onPick} aria-label={m.name ?? "Picture"}>
        {companyId && (m.kind === "video" ? <video src={src} muted className="size-full object-cover" /> : <img src={src} alt="" className="size-full object-cover" />)}
      </button>
      {m.kind === "video" && <FilmIcon className="absolute top-1.5 left-1.5 size-4 text-white drop-shadow" />}
      {onDeleted && (
        <Button variant="secondary" size="icon-xs" className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100" aria-label="Remove" onClick={() => void remove()}><Trash2Icon /></Button>
      )}
    </div>
  );
}

export function UploadButton({ onDone, label = "Add picture or video" }: { onDone: (row: MediaRow) => void; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (file: File) => {
    setBusy(true);
    try {
      // Pictures are shrunk to full-HD width before sending; videos go as they are.
      const blob = file.type.startsWith("image/") ? await shrinkForTv(file) : file;
      const row = await apiUpload<MediaRow>("/signage/media", blob, file.name);
      onDone(row);
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); if (input.current) input.current.value = ""; }
  };
  return (
    <>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
      <Button variant="outline" onClick={() => input.current?.click()} disabled={busy}>
        {busy ? <Loader2Icon className="animate-spin" /> : <ImagePlusIcon />}{label}
      </Button>
    </>
  );
}

async function shrinkForTv(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", 0.86));
  return blob ?? file;
}

