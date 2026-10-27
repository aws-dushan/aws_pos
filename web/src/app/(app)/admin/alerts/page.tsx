"use client";

import { useState } from "react";
import { MailIcon, NewspaperIcon, SendIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { useSession } from "@/components/session";
import { ErrorNote, Field, FieldGroup, LoadingRows, PageHeader, Switch } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Settings = {
  emailEnabled: boolean; emails: string[]; voidsOver: number | null; refundsOver: number | null; noSalesOver: number | null;
  discountPctOver: number | null; varianceAlerts: boolean; notCountedAlerts: boolean;
  approvalReminders: boolean; reminderHours: number; reminderFrom: string; reminderUntil: string;
};
type Smtp = { host: string; port: number; ssl: boolean; user: string | null; from: string; fromName: string | null; hasPassword: boolean } | null;

const num = (s: string) => (s.trim() === "" ? null : Number(s));

/**
 * Daily summary and alerts (REQ DAY-10), Administration. Off by default. On: when each branch closes its day, a summary and any
 * alerts over these limits go under the newspaper icon (to people with reports) and, where email is set up, to the list below.
 */
export default function AlertsPage() {
  const { me, company } = useSession();
  const cur = company?.currency ?? "AED";
  const data = useApi<{ settings: Settings; smtp: Smtp }>("/notices/settings");
  const [f, setF] = useState<Record<string, string | boolean> | null>(null);
  const [seen, setSeen] = useState<unknown>(null);
  const [mail, setMail] = useState({ host: "", port: "587", ssl: true, user: "", password: "", from: "", fromName: "" });
  const [testTo, setTestTo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  if (data.data && data.data !== seen) {
    setSeen(data.data);
    const s = data.data.settings, m = data.data.smtp;
    setF({
      emailEnabled: s.emailEnabled, emails: s.emails.join("\n"), voidsOver: s.voidsOver?.toString() ?? "", refundsOver: s.refundsOver?.toString() ?? "",
      noSalesOver: s.noSalesOver?.toString() ?? "", discountPctOver: s.discountPctOver?.toString() ?? "", varianceAlerts: s.varianceAlerts, notCountedAlerts: s.notCountedAlerts,
      approvalReminders: s.approvalReminders, reminderHours: String(s.reminderHours), reminderFrom: s.reminderFrom, reminderUntil: s.reminderUntil,
    });
    setMail({ host: m?.host ?? "", port: String(m?.port ?? 587), ssl: m?.ssl ?? true, user: m?.user ?? "", password: "", from: m?.from ?? "", fromName: m?.fromName ?? "" });
  }
  const set = (k: string, v: string | boolean) => setF((x) => ({ ...x!, [k]: v }));

  async function run(name: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(name);
    try { await fn(); toast.success(ok); data.reload(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  const save = () => run("save", () => api("/notices/settings", "PUT", {
    emailEnabled: f!.emailEnabled, emails: String(f!.emails).split(/[\s,;]+/).filter(Boolean),
    voidsOver: num(String(f!.voidsOver)), refundsOver: num(String(f!.refundsOver)), noSalesOver: num(String(f!.noSalesOver)), discountPctOver: num(String(f!.discountPctOver)),
    varianceAlerts: f!.varianceAlerts, notCountedAlerts: f!.notCountedAlerts,
    approvalReminders: f!.approvalReminders, reminderHours: Number(f!.reminderHours) || 12, reminderFrom: String(f!.reminderFrom), reminderUntil: String(f!.reminderUntil),
  }), "Saved.");

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Daily summary & alerts" icon={NewspaperIcon} module="appr"
        description="When each branch closes its day: a summary of the day, and alerts where something is over your limits." />
      <ErrorNote message={data.error} />
      {!f ? <LoadingRows rows={4} /> : <>
        <FieldGroup title="Daily summary and alerts" className="space-y-4 p-5">
          <p className="text-sm text-muted-foreground">
            Each closed day makes a summary (sales against the same day last week, orders, cash variance, discounts, refunds, voids, no-sales, wastage, best sellers) and alerts over these limits. Leave a limit empty for no alert.
          </p>
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={`Alert when voided orders are over (${cur})`}><Input value={String(f.voidsOver)} inputMode="decimal" onChange={(e) => set("voidsOver", e.target.value)} placeholder="No alert" /></Field>
              <Field label={`Alert when refunds are over (${cur})`}><Input value={String(f.refundsOver)} inputMode="decimal" onChange={(e) => set("refundsOver", e.target.value)} placeholder="No alert" /></Field>
              <Field label="Alert when no-sales are over"><Input value={String(f.noSalesOver)} inputMode="numeric" onChange={(e) => set("noSalesOver", e.target.value)} placeholder="No alert" /></Field>
              <Field label="Alert when discounts are over (% of sales)"><Input value={String(f.discountPctOver)} inputMode="decimal" onChange={(e) => set("discountPctOver", e.target.value)} placeholder="No alert" /></Field>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5"><span className="text-sm">Cash variance beyond the branch&apos;s tolerance</span><Switch on={!!f.varianceAlerts} onChange={(v) => set("varianceAlerts", v)} label="Cash variance alerts" /></div>
              <div className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5"><span className="text-sm">A shift closed without a count</span><Switch on={!!f.notCountedAlerts} onChange={(v) => set("notCountedAlerts", v)} label="Not counted alerts" /></div>
            </div>
            <div className="space-y-2 rounded-xl border p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm"><span className="font-medium">Email them too</span> <span className="text-muted-foreground">· needs the email server below</span></span>
                <Switch on={!!f.emailEnabled} onChange={(v) => set("emailEnabled", v)} label="Email" />
              </div>
              {f.emailEnabled && <Field label="Send to" hint="One address per line (owner, head office…)."><Textarea rows={3} value={String(f.emails)} onChange={(e) => set("emails", e.target.value)} placeholder="owner@company.ae" /></Field>}
              {f.emailEnabled && !data.data?.smtp && <p className="text-xs text-warning">No email server yet: summaries show in One POS only until one is set up.</p>}
            </div>
          </>
          <div className="flex justify-end"><Button className="h-11" disabled={busy === "save"} onClick={() => void save()}>Save</Button></div>
        </FieldGroup>

        <FieldGroup title="Approval reminders" className="space-y-4 p-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Wastage, marketing give-aways, returns and stock requests still waiting for their approver after these hours are emailed to the approver, all in one
              email, again every so many hours until decided. Only within the sending hours (branch time): one due at night goes in the morning.
            </p>
            <Switch on={!!f.approvalReminders} onChange={(v) => set("approvalReminders", v)} label="Approval reminders" />
          </div>
          {f.approvalReminders && (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Remind after (hours)"><Input value={String(f.reminderHours)} inputMode="numeric" onChange={(e) => set("reminderHours", e.target.value.replace(/\D/g, ""))} /></Field>
              <Field label="Send from"><Input type="time" value={String(f.reminderFrom)} onChange={(e) => set("reminderFrom", e.target.value)} /></Field>
              <Field label="Until"><Input type="time" value={String(f.reminderUntil)} onChange={(e) => set("reminderUntil", e.target.value)} /></Field>
            </div>
          )}
          {f.approvalReminders && !data.data?.smtp && <p className="text-xs text-warning">No email server yet: reminders show under the bell only until one is set up.</p>}
          <div className="flex justify-end"><Button className="h-11" disabled={busy === "save"} onClick={() => void save()}>Save</Button></div>
        </FieldGroup>

        {me.user.isAdmin && (
          <FieldGroup title="Email server (SMTP)" className="space-y-4 p-5"
            description={data.data?.smtp ? `Set up: ${data.data.smtp.host}:${data.data.smtp.port}, from ${data.data.smtp.from}` : "For emailed summaries and alerts. Administrators only; the password is kept protected and never shown."}>
            <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
              <Field label="Server"><Input value={mail.host} onChange={(e) => setMail({ ...mail, host: e.target.value })} placeholder="smtp.office365.com" /></Field>
              <Field label="Port"><Input value={mail.port} inputMode="numeric" onChange={(e) => setMail({ ...mail, port: e.target.value })} /></Field>
              <Field label="User"><Input value={mail.user} onChange={(e) => setMail({ ...mail, user: e.target.value })} autoComplete="off" /></Field>
              <Field label="Password" hint={data.data?.smtp?.hasPassword ? "Saved. Leave empty to keep it." : undefined}>
                <Input type="password" value={mail.password} onChange={(e) => setMail({ ...mail, password: e.target.value })} autoComplete="new-password" />
              </Field>
              <Field label="From address"><Input value={mail.from} onChange={(e) => setMail({ ...mail, from: e.target.value })} placeholder="pos@company.ae" /></Field>
              <div className="flex items-end"><div className="flex h-10 w-full items-center justify-between gap-2 rounded-xl border px-3"><span className="text-sm">TLS</span><Switch on={mail.ssl} onChange={(v) => setMail({ ...mail, ssl: v })} label="TLS" /></div></div>
              <Field label="From name" hint="The sender people see. Empty = One POS."><Input value={mail.fromName} maxLength={80} onChange={(e) => setMail({ ...mail, fromName: e.target.value })} placeholder="e.g. European Bakery POS" /></Field>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button className="h-11" disabled={!!busy || !mail.host || !mail.from} onClick={() => void run("smtp", () => api("/notices/smtp", "PUT",
                { host: mail.host, port: Number(mail.port), ssl: mail.ssl, user: mail.user || null, password: mail.password === "" ? null : mail.password, from: mail.from, fromName: mail.fromName.trim() || null }), "Email server saved.")}>
                <MailIcon /> Save email server
              </Button>
              {data.data?.smtp && <>
                <Input className="h-11 w-56" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="Send a test to…" />
                <Button variant="outline" className="h-11" disabled={!!busy || !testTo} onClick={() => void run("test", () => api("/notices/smtp/test", "POST", { to: testTo }), `Test email sent to ${testTo}.`)}><SendIcon /> Test</Button>
                <Button variant="ghost" className="ml-auto h-11 text-danger" disabled={!!busy} onClick={() => void run("del", () => api("/notices/smtp", "DELETE"), "Email server removed.")}><Trash2Icon /> Remove</Button>
              </>}
            </div>
          </FieldGroup>
        )}
      </>}
    </div>
  );
}
