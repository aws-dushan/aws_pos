"use client";

import { useEffect } from "react";
import { api } from "@/lib/api";
import { appStorage } from "@/lib/base-path";
import { deviceStatus, pairServer } from "@/lib/device";
import { withBase } from "@/lib/base-path";

/** This PC's own id, kept in its browser: the Devices list shows each PC once. */
function deviceKey() {
  try {
    let k = appStorage.getItem("onepos.device.key");
    if (!k) { k = crypto.randomUUID(); appStorage.setItem("onepos.device.key", k); }
    return k;
  } catch { return "unknown"; }
}

/**
 * Device status (REQ HW-08): every minute this PC tells the server what its One POS Device Service says (or that none answers),
 * so the branch's Devices screen shows which tills are online and whether their printers are ready.
 */
export function useDeviceHeartbeat(branchId: string | null | undefined) {
  useEffect(() => {
    if (!branchId) return;
    let stop = false, paired = false;
    const beat = async () => {
      const s = await deviceStatus().catch(() => null);
      if (stop) return;
      // Once per page load: tell this PC's Device Service which One POS server we are (its updates come from here).
      if (s && !paired) { paired = true; void pairServer(`${window.location.origin}${withBase("/api")}`).catch(() => { paired = false; }); }
      await api("/devices/heartbeat", "POST", {
        // The PC's name (from its Device Service) is its id where there is one, so clearing the browser doesn't list it twice.
        deviceKey: s?.machine ? `pc:${s.machine}` : deviceKey(), machine: s?.machine ?? null, serviceVersion: s?.version ?? null, receiptPrinter: s?.receiptPrinter ?? null,
        printerState: s?.printerState ?? null, lastPrintAt: s?.lastPrintAt ?? null, lastError: s?.lastError ?? null,
      }).catch(() => {});
    };
    void beat();
    const t = window.setInterval(() => void beat(), 60_000);
    return () => { stop = true; window.clearInterval(t); };
  }, [branchId]);
}
