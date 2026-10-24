"use client";

import { useState } from "react";
import { CheckIcon, PlusIcon, ShieldCheckIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useSession } from "@/components/session";
import { EmptyState, ErrorNote, Field, LoadingRows, PageHeader, Pill } from "@/components/kit";
import { Stagger, StaggerItem } from "@/components/motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Role = { id: string; name: string; permissions: string[]; limits: Record<string, number>; users: number };
type Defs = { permissions: { key: string; group: string; label: string }[]; limits: { key: string; label: string }[] };

/**
 * Roles (REQ USR-02, USR-03): what each role may do and up to which limits. This is where an admin decides who sees the
 * register's sales and who sees the whole branch's (Dashboard permissions).
 */
export default function RolesPage() {
  const { company } = useSession();
  const roles = useApi<Role[]>(company ? `/companies/${company.id}/roles` : null);
  const defs = useApi<Defs>("/permissions");
  const [edit, setEdit] = useState<Role | "new" | null>(null);
  if (!company) return <EmptyState icon={ShieldCheckIcon} title="Choose a company first" module="appr">Pick a company in the top bar.</EmptyState>;
  const label = (k: string) => defs.data?.permissions.find((p) => p.key === k)?.label ?? k;

  return (
    <div>
      <PageHeader title="Roles" icon={ShieldCheckIcon} module="appr" count={roles.data?.length}
        description={`${company.name}: what each role may do, including who sees register and branch sales on the dashboard.`}
        actions={<Button size="lg" onClick={() => setEdit("new")} disabled={!defs.data}><PlusIcon /> New role</Button>} />
      <ErrorNote message={roles.error ?? defs.error} />
      {roles.loading && !roles.data ? <LoadingRows rows={4} /> : (
        <Stagger className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {roles.data?.map((r) => (
            <StaggerItem key={r.id} className="h-full">
              <button type="button" onClick={() => setEdit(r)} data-module="appr" className="group surface card-lift flex h-full w-full flex-col p-5 text-left">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-heading text-base font-semibold">{r.name}</div>
                    <div className="text-xs text-muted-foreground">{r.users} user{r.users === 1 ? "" : "s"} · {r.permissions.length} permission{r.permissions.length === 1 ? "" : "s"}</div>
                  </div>
                  <span className="hover-hop flex size-10 items-center justify-center rounded-xl bg-mod-grad text-white shadow-[0_6px_16px_-6px_var(--mod)]"><ShieldCheckIcon className="size-[1.1rem]" /></span>
                </div>
                <div className="mt-3 flex flex-wrap gap-1">
                  {r.permissions.includes("dashboard.branch") ? <Pill dot className="text-mod-sales">Branch sales</Pill>
                    : r.permissions.includes("dashboard.register") ? <Pill dot className="text-mod-fin">Register sales</Pill> : null}
                  {r.limits.maxDiscountPct !== undefined && <Pill>Discount ≤ {r.limits.maxDiscountPct}%</Pill>}
                </div>
                <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                  {r.permissions.slice(0, 4).map((p) => <li key={p} className="flex items-center gap-1.5"><CheckIcon className="size-3 text-success" />{label(p)}</li>)}
                  {r.permissions.length > 4 && <li className="pl-4.5">and {r.permissions.length - 4} more</li>}
                </ul>
              </button>
            </StaggerItem>
          ))}
        </Stagger>
      )}
      {defs.data && <RoleDialog value={edit} defs={defs.data} onClose={() => setEdit(null)} onSaved={() => roles.reload()} />}
    </div>
  );
}

function RoleDialog({ value, defs, onClose, onSaved }: { value: Role | "new" | null; defs: Defs; onClose: () => void; onSaved: () => void }) {
  const { company } = useSession();
  const isNew = value === "new";
  const [name, setName] = useState("");
  const [perms, setPerms] = useState<string[]>([]);
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [seen, setSeen] = useState<typeof value>(null);
  const [busy, setBusy] = useState(false);
  if (value !== seen) {
    setSeen(value);
    const r = value && value !== "new" ? value : null;
    setName(r?.name ?? "");
    setPerms(r?.permissions ?? ["pos.sell", "dashboard.register"]);
    setLimits(Object.fromEntries(defs.limits.map((l) => [l.key, r?.limits[l.key] !== undefined ? String(r.limits[l.key]) : ""])));
  }
  const toggle = (k: string) => setPerms((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));
  const groups = [...new Set(defs.permissions.map((p) => p.group))];

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!company) return;
    setBusy(true);
    try {
      const body = { name, permissions: perms, limits: Object.fromEntries(Object.entries(limits).filter(([, v]) => v.trim() !== "").map(([k, v]) => [k, Number(v)])) };
      if (isNew) await api(`/companies/${company.id}/roles`, "POST", body);
      else if (value) await api(`/companies/${company.id}/roles/${value.id}`, "PUT", body);
      toast.success(isNew ? `Role ${name} created.` : "Role saved.");
      onSaved();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!value} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={save} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{isNew ? "New role" : `Role · ${name}`}</DialogTitle>
            <DialogDescription>Tap a permission to give or take it. Changes apply at each user&apos;s next action.</DialogDescription>
          </DialogHeader>
          <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <div className="space-y-4">
            {groups.map((g) => (
              <div key={g}>
                <div className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g}</div>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {defs.permissions.filter((p) => p.group === g).map((p) => {
                    const on = perms.includes(p.key);
                    return (
                      <button key={p.key} type="button" role="checkbox" aria-checked={on} onClick={() => toggle(p.key)}
                        className={cn("flex min-h-12 items-center gap-3 rounded-xl border px-3 py-2 text-left text-sm transition-[background-color,transform] active:scale-[0.98]",
                          on ? "border-primary/40 bg-primary/8" : "bg-card hover:bg-muted")}>
                        <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors", on ? "border-primary bg-primary text-primary-foreground" : "border-input")}>
                          {on && <CheckIcon className="size-3.5" />}
                        </span>
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <div>
            <div className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Limits</div>
            <div className="grid gap-3 sm:grid-cols-3">
              {defs.limits.map((l) => (
                <Field key={l.key} label={l.label}>
                  <Input inputMode="decimal" value={limits[l.key] ?? ""} onChange={(e) => setLimits((x) => ({ ...x, [l.key]: e.target.value }))} placeholder="No limit set" />
                </Field>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !name.trim()}>{isNew ? "Create role" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
