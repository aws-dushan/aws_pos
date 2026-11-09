"use client";

import { useState } from "react";
import { CastIcon, Loader2Icon, MonitorCheckIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { ObjectStatus, TONE } from "@/components/kit";
import { Button } from "@/components/ui/button";

export type Till = {
  id: string; machine: string | null; online: boolean;
  nearby: { name: string; connected: boolean }[] | null; nearbyAt: string | null;
  connectName: string | null; connectAt: string | null; connectOk: boolean | null; connectMessage: string | null; connectDoneAt: string | null;
};

/**
 * The wireless TVs each till can see. Connect asks that till to connect the TV (it drives Windows' Cast panel, extends the
 * desktop onto the TV and plays); the till reports back within a few seconds and remembers the TV for its next start.
 */
export function NearbyTvs({ tills, reload }: { tills: Till[]; reload: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const connect = async (t: Till, name: string) => {
    setBusy(`${t.id}|${name}`);
    try { await api(`/signage/devices/${t.id}/connect`, "POST", { name }); toast.success(`${t.machine ?? "The till"} is connecting ${name}…`); reload(); }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(null); }
  };
  const cancel = async (t: Till) => { await api(`/signage/devices/${t.id}/connect`, "DELETE").then(reload, (e: Error) => toast.error(e.message)); };

  return (
    <section className="surface">
      <div className="border-b px-5 py-3">
        <h2 className="font-heading text-[0.95rem] font-semibold">Nearby TVs</h2>
        <p className="text-xs text-muted-foreground">Wireless TVs each till can see. Turn the TV on with Screen Mirroring open, then tap Connect.</p>
      </div>
      {tills.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted-foreground">No tills yet. Open One POS once on a till that has the One POS Device Service 1.4.1 or later.</p>
      ) : (
        <div className="divide-y">
          {tills.map((t) => {
            const near = t.nearby ?? [];
            return (
              <div key={t.id} className="space-y-2 px-5 py-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{t.machine ?? "Till"}</span>
                  {t.online ? <ObjectStatus className={TONE.done}>Online</ObjectStatus> : <ObjectStatus className={TONE.muted}>Offline</ObjectStatus>}
                </div>
                {t.connectName && (
                  <div className="flex items-center gap-2 text-sm">
                    <Loader2Icon className="size-4 animate-spin text-primary" />
                    Connecting <b>{t.connectName}</b>{t.online ? "…" : " when the till comes online…"}
                    <Button variant="ghost" size="xs" onClick={() => void cancel(t)}><XIcon />Cancel</Button>
                  </div>
                )}
                {!t.connectName && t.connectDoneAt && t.connectMessage && (
                  <p className={`text-xs ${t.connectOk ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"}`}>{t.connectMessage}</p>
                )}
                {t.nearby === null ? (
                  <p className="text-xs text-muted-foreground">This till doesn&apos;t list wireless TVs yet (Device Service 1.4.1 or later needed).</p>
                ) : near.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No wireless TVs in reach. Check the TV is on with Screen Mirroring open.</p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {near.map((n) => (
                      <li key={n.name} className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm">
                        <CastIcon className="size-4 text-muted-foreground" />
                        <span className="font-medium">{n.name}</span>
                        {n.connected ? (
                          <span className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400"><MonitorCheckIcon className="size-3.5" />Connected</span>
                        ) : (
                          <Button size="xs" disabled={!t.online || !!t.connectName || busy !== null} onClick={() => void connect(t, n.name)}>
                            {busy === `${t.id}|${n.name}` ? <Loader2Icon className="animate-spin" /> : null}Connect
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
