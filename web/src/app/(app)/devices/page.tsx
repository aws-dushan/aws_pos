"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRingIcon, ChefHatIcon, CupSodaIcon, CheckCircle2Icon, DownloadIcon, InboxIcon, Loader2Icon, MonitorIcon, MonitorSmartphoneIcon, PrinterIcon, RefreshCwIcon, XCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { api, newKey, useApi } from "@/lib/api";
import { printReceipt } from "@/lib/device";
import { withBase } from "@/lib/base-path";
import { checkUpdate, DEVICE_URL, deviceStatus, openDrawer, printTest, saveDeviceSettings, setAutoUpdate, type DeviceStatus } from "@/lib/device";
import { openCustomerDisplay } from "@/lib/customer-display";
import { useSession } from "@/components/session";
import { BranchDevices } from "@/components/branch-devices";
import { Field, FieldGroup, PageHeader, Segmented, Switch } from "@/components/kit";
import { Button } from "@/components/ui/button";

/**
 * This till's devices (REQ HW-01 … HW-08): whether the One POS Device Service runs here, which printer prints receipts, paper width,
 * the cash drawer, a pole display; test print and open-drawer tests; the customer display on the second screen.
 */
export default function DevicesPage() {
  const { me, branch, isTill, can } = useSession();
  const [status, setStatus] = useState<DeviceStatus | null | undefined>(undefined);
  const [form, setForm] = useState({ receiptPrinter: "", paperWidth: 80, drawerOnCash: true, poleDisplayPort: "" });
  const [busy, setBusy] = useState<string | null>(null);
  // The latest installer on this server, offered where no Device Service answers.
  const [installer, setInstaller] = useState<{ version: string; file: string } | null>(null);
  useEffect(() => {
    if (status !== null) return;
    fetch(withBase("/api/public/device-service/latest")).then((r) => (r.ok ? r.json() : null)).then(setInstaller, () => {});
  }, [status]);

  const check = useCallback(async () => {
    const s = await deviceStatus();
    setStatus(s);
    if (s) setForm({ receiptPrinter: s.receiptPrinter ?? "", paperWidth: s.paperWidth, drawerOnCash: s.drawerOnCash, poleDisplayPort: s.poleDisplayPort ?? "" });
  }, []);
  useEffect(() => { deviceStatus().then((s) => {
    setStatus(s);
    if (s) setForm({ receiptPrinter: s.receiptPrinter ?? "", paperWidth: s.paperWidth, drawerOnCash: s.drawerOnCash, poleDisplayPort: s.poleDisplayPort ?? "" });
  }); }, []);

  async function act(name: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(name);
    try { await fn(); toast.success(ok); await check(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }

  const online = !!status;
  return (
    <div className="max-w-4xl">
      <PageHeader title="Devices" icon={PrinterIcon} module="admin"
        description={`This till${isTill && me.till?.registerName ? ` (${me.till.registerName}, ${branch?.name})` : ""}: receipt printer, cash drawer and customer display.`}
        actions={<Button variant="outline" className="h-10" onClick={() => { setStatus(undefined); void check(); }}><RefreshCwIcon /> Check again</Button>} />

      <div className="space-y-5">
        <section className={cn("surface flex items-center gap-4 p-5", status === undefined && "animate-pulse")}>
          <span className={cn("flex size-12 shrink-0 items-center justify-center rounded-2xl text-white", online ? "bg-success" : status === null ? "bg-danger" : "bg-muted")}>
            {status === undefined ? <Loader2Icon className="size-6 animate-spin" /> : online ? <CheckCircle2Icon className="size-6" /> : <XCircleIcon className="size-6" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-heading text-base font-semibold">
              {status === undefined ? "Looking for the Device Service…" : online ? "One POS Device Service is running" : "The Device Service isn't running on this PC"}
            </div>
            <div className="text-sm text-muted-foreground">
              {online ? `Version ${status.version} on ${status.machine}${status.lastPrintAt ? ` · last print ${new Date(status.lastPrintAt).toLocaleTimeString("en-GB")}` : ""}`
                : status === null ? "Receipts open the browser's print dialog until it's installed. Install it once per till (Windows), then check again." : `Checking ${DEVICE_URL}`}
            </div>
            {status?.lastError && <div className="mt-1 text-sm text-danger">Last problem: {status.lastError}</div>}
          </div>
          {status === null && (installer
            ? <Button className="h-11" nativeButton={false} render={<a href={withBase(`/api/public/device-service/files/${installer.file}`)} />}><DownloadIcon /> Download the installer ({installer.version})</Button>
            : <Button className="h-11" nativeButton={false} render={<a href={withBase("/downloads/OnePos.DeviceService-setup.md")} target="_blank" rel="noreferrer" />}><DownloadIcon /> How to install</Button>)}
        </section>

        {online && status.update && (
          <FieldGroup title="Updates" className="flex flex-wrap items-center gap-3 p-5"
            description="The Device Service updates itself from this One POS server (the installer's checksum is checked first). Off on a PC to update it by hand.">
            <div className="min-w-56 flex-1 text-sm">
              <div>Version {status.version}{status.update.latest && status.update.latest !== status.version ? <span className="font-medium text-primary"> · {status.update.latest} available</span> : ""}</div>
              <div className="text-xs text-muted-foreground">{status.update.result ?? (status.update.paired ? "Not checked yet." : "Not paired with this server yet.")}{status.update.lastCheck ? ` · checked ${new Date(status.update.lastCheck).toLocaleString("en-GB")}` : ""}</div>
            </div>
            <div className="flex items-center gap-2 rounded-xl border px-3 py-2"><span className="text-sm">Update by itself</span>
              <Switch on={status.update.autoUpdate} onChange={(v) => void act("auto", () => setAutoUpdate(v), v ? "This PC updates itself." : "Automatic updates off on this PC.")} label="Update by itself" /></div>
            <Button variant="outline" className="h-11" disabled={!!busy} onClick={() => void act("check", async () => toast.message((await checkUpdate(false)).result), "Checked.")}>Check for updates</Button>
            {status.update.latest && status.update.latest !== status.version && (
              <Button className="h-11" disabled={!!busy} onClick={() => void act("install", async () => toast.message((await checkUpdate(true)).result), "Update started.")}><DownloadIcon /> Update now</Button>
            )}
          </FieldGroup>
        )}

        {online && (
          <FieldGroup title="Receipt printer" description="Any printer with a Windows driver: USB, network or Bluetooth. The cash drawer plugs into it." className="grid gap-4 p-5">
            <Field label="Printer">
              <div className="grid gap-2 sm:grid-cols-2">
                {status.printers.map((p) => (
                  <button key={p} type="button" onClick={() => setForm({ ...form, receiptPrinter: p })} aria-pressed={form.receiptPrinter === p}
                    className={cn("flex h-12 items-center gap-2 rounded-xl border px-3 text-left text-sm transition-[background-color,transform] active:scale-[0.98]",
                      form.receiptPrinter === p ? "border-primary bg-primary/10 font-medium text-primary" : "bg-card hover:bg-muted")}>
                    <PrinterIcon className="size-4 shrink-0" /><span className="truncate">{p}</span>
                  </button>
                ))}
                {!status.printers.length && <p className="text-sm text-muted-foreground">No printers installed on this PC. Install the receipt printer&apos;s Windows driver first.</p>}
              </div>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Paper width">
                <Segmented id="paper" value={String(form.paperWidth)} onChange={(v) => setForm({ ...form, paperWidth: Number(v) })} className="w-full"
                  options={[{ value: "80", label: "80 mm" }, { value: "58", label: "58 mm" }]} />
              </Field>
              <Field label="Pole display (serial port)">
                <select value={form.poleDisplayPort} onChange={(e) => setForm({ ...form, poleDisplayPort: e.target.value })}
                  className="h-10 w-full rounded-xl border border-input bg-card px-3 text-sm dark:bg-input/30">
                  <option value="">None</option>
                  {status.ports.map((p) => <option key={p}>{p}</option>)}
                </select>
              </Field>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-xl border px-4 py-3">
              <span className="flex items-center gap-2 text-sm"><InboxIcon className="size-4 text-muted-foreground" /> Open the cash drawer whenever cash is taken or given back</span>
              <Switch on={form.drawerOnCash} onChange={(v) => setForm({ ...form, drawerOnCash: v })} label="Drawer on cash" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button className="h-11" disabled={!!busy} onClick={() => act("save", () => saveDeviceSettings({ ...form, receiptPrinter: form.receiptPrinter || null, poleDisplayPort: form.poleDisplayPort || null }), "Saved on this till.")}>
                {busy === "save" && <Loader2Icon className="animate-spin" />} Save
              </Button>
              <Button variant="outline" className="h-11" disabled={!!busy || !status.receiptPrinter} onClick={() => act("test", printTest, "Test page sent.")}><PrinterIcon /> Test print</Button>
              <Button variant="outline" className="h-11" disabled={!!busy || !status.receiptPrinter} onClick={() => act("drawer", () => openDrawer(newKey()), "Drawer opened.")}><InboxIcon /> Open drawer</Button>
            </div>
          </FieldGroup>
        )}

        <StationsGroup printers={status?.printers ?? []} />

        <FieldGroup title="Customer display" description="A second monitor or rear screen facing the customer: items as they're added, the total, and the change." className="flex flex-wrap items-center gap-3 p-5">
          <Button variant="outline" className="h-11" onClick={() => void openCustomerDisplay(withBase("/display"))}><MonitorIcon /> Open on the second screen</Button>
          <p className="text-sm text-muted-foreground">Chrome or Edge asks once to place windows on other screens. Tap the display once to make it full screen.</p>
        </FieldGroup>

        <FieldGroup title="Order-ready screen" description="A TV by the counter: takeaway and delivery numbers being prepared, and the ready ones large with a chime. Switch it on per branch (Companies & branches): automatic, or the cashier taps a number on the register when it's ready." className="flex flex-wrap items-center gap-3 p-5">
          <Button variant="outline" className="h-11" onClick={() => window.open(withBase("/pickup"), "onepos-pickup")}><BellRingIcon /> Open the order-ready screen</Button>
          <p className="text-sm text-muted-foreground">Open it on the PC driving the TV, signed in to this branch. Tap it once for full screen and sound.</p>
        </FieldGroup>

        {can("branch.manage") && <BranchDevices />}

        {!isTill && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><MonitorSmartphoneIcon className="size-4" /> These settings belong to the PC you&apos;re on. Open this screen on each till.</p>
        )}
      </div>
    </div>
  );
}

/**
 * The branch's kitchen and bar (REQ KIT-01, KIT-03): their names and the printer their tickets print on. Stored for the branch;
 * the printer must be installed (same name) on the tills that send orders. No printer: the kitchen display only.
 */
function StationsGroup({ printers }: { printers: string[] }) {
  const board = useApi<{ stations: { kind: string; name: string; printerName: string | null }[] }>("/kitchen");
  return (
    <FieldGroup title="Kitchen & bar" description="Where tickets go when a till sends an order. Without a printer, tickets show on the kitchen display only." className="grid gap-3 p-5">
      {(["kitchen", "bar"] as const).map((kind) => {
        const st = board.data?.stations.find((x) => x.kind === kind);
        return <StationRow key={`${kind}-${st?.printerName ?? ""}-${st?.name ?? ""}`} kind={kind} name={st?.name ?? (kind === "bar" ? "Bar" : "Kitchen")}
          printer={st?.printerName ?? ""} printers={printers} onSaved={() => board.reload()} />;
      })}
    </FieldGroup>
  );
}

function StationRow({ kind, name: initialName, printer: initialPrinter, printers, onSaved }: {
  kind: "kitchen" | "bar"; name: string; printer: string; printers: string[]; onSaved: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [printer, setPrinter] = useState(initialPrinter);
  const Icon = kind === "bar" ? CupSodaIcon : ChefHatIcon;
  const options = [...new Set([...printers, ...(initialPrinter ? [initialPrinter] : [])])];
  async function save() {
    try { await api("/kitchen/stations", "PUT", { kind, name, printerName: printer || null }); toast.success(`${name} saved.`); onSaved(); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function test() {
    try {
      await printReceipt(`station-test-${Date.now()}`, [
        { text: name.toUpperCase(), align: "center", bold: true, size: "large" }, { text: "Test ticket", align: "center" }, { rule: true },
        { text: "2 x Hummus", bold: true, size: "large" }, { text: "   !! no garlic", bold: true }, { rule: true },
      ], false, printer);
      toast.success("Test ticket sent.");
    } catch (e) { toast.error((e as Error).message); }
  }
  return (
    <div className="grid items-end gap-2 rounded-xl border p-3 sm:grid-cols-[auto_1fr_1.3fr_auto]">
      <span className="flex size-11 items-center justify-center rounded-xl bg-muted"><Icon className="size-5 text-muted-foreground" /></span>
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} className="h-11 w-full rounded-xl border border-input bg-card px-3 text-sm dark:bg-input/30" /></Field>
      <Field label="Ticket printer">
        <select value={printer} onChange={(e) => setPrinter(e.target.value)} className="h-11 w-full rounded-xl border border-input bg-card px-3 text-sm dark:bg-input/30">
          <option value="">No printer (display only)</option>
          {options.map((p) => <option key={p}>{p}</option>)}
        </select>
      </Field>
      <div className="flex gap-2">
        <Button variant="outline" className="h-11" disabled={!printer} onClick={test}><PrinterIcon /> Test</Button>
        <Button className="h-11" onClick={save}>Save</Button>
      </div>
    </div>
  );
}
