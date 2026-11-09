"use client";

import { withBase } from "@/lib/base-path";
import type { PlayData } from "@/lib/signage";
import type { MediaUrls } from "@/components/signage/stage";

/** Picture addresses for a signed-in manager's preview (the session, with the company in the address). */
export function previewUrls(data: PlayData | null | undefined, videos: string[]): MediaUrls {
  const co = data?.companyId ?? "";
  const set = new Set(videos);
  return {
    media: (id) => withBase(`/api/public/signage/media/${id}?co=${co}`),
    isVideo: (id) => set.has(id),
    item: (i) => (i.imageAt ? withBase(`/api/menu/images/${co}/${i.id}?v=${encodeURIComponent(i.imageAt)}`) : null),
    logo: data?.logoAt ? withBase(`/api/public/signage/logo/${data.branchId}?co=${co}&v=${encodeURIComponent(data.logoAt)}`) : null,
  };
}
