"use client";

import { useRef, useState } from "react";
import { KeyRoundIcon, PlusIcon, UsersRoundIcon } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useSession } from "@/components/session";
import { Avatar, EmptyState, ErrorNote, Field, LoadingRows, ObjectStatus, PageHeader, Pill, SearchField, Segmented, Switch, TablePanel, TONE } from "@/components/kit";
import { useEnterRows } from "@/components/motion";
import { confirmDialog } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type User = { id: string; username: string; displayName: string; isActive: boolean; isAdmin: boolean; roleId: string; roleName: string; hasPin: boolean; hasPassword: boolean; branchIds: string[];
  /** The user's own limits over the role's: a number, or null for no limit; a key not there follows the role. */
  limits: Record<string, number | null> };
type Role = { id: string; name: string; limits: Record<string, number> };
type LimitMode = "role" | "own" | "none";
/** The limits a user can have of their own (the role's keys). */
const LIMITS: { key: string; label: string; unit: "%" | "AED" }[] = [
  { key: "maxDiscountPct", label: "Discount", unit: "%" },
  { key: "maxRefund", label: "Refund", unit: "AED" },
  { key: "maxCashOut", label: "Cash out", unit: "AED" },
];
const limitState = (u: User | null) => Object.fromEntries(LIMITS.map((l) => {
  const has = !!u && Object.prototype.hasOwnProperty.call(u.limits ?? {}, l.key);
  const v = has ? u!.limits[l.key] : undefined;
  return [l.key, { mode: (!has ? "role" : v === null ? "none" : "own") as LimitMode, value: typeof v === "number" ? String(v) : "" }];
})) as Record<string, { mode: LimitMode; value: string }>;

/** The company's people (REQ USR-01 … USR-04): role, branches, till PIN and back-office password. */
export default function UsersPage() {
  const { company, me } = useSession();
  const users = useApi<User[]>(company ? `/companies/${company.id}/users` : null);
  const roles = useApi<Role[]>(company ? `/companies/${company.id}/roles` : null);
  const [edit, setEdit] = useState<User | "new" | null>(null);
  const [q, setQ] = useState("");
  const tableRef = useRef<HTMLDivElement>(null);
  useEnterRows(tableRef);

  if (!company) return <EmptyState icon={UsersRoundIcon} title="Choose a company first" module="bp">Pick a company in the top bar.</EmptyState>;
  const term = q.trim().toLowerCase();
  const list = (users.data ?? []).filter((u) => !term || `${u.displayName} ${u.username} ${u.roleName}`.toLowerCase().includes(term));
  const branchName = (id: string) => company.branches.find((b) => b.id === id)?.code ?? "?";

  return (
    <div>
      <PageHeader title="Users" icon={UsersRoundIcon} module="bp" count={users.data?.length}
        description={`${company.name}: who works where, with which role. Cashiers sign in at the till with their PIN.`}
        actions={<Button size="lg" onClick={() => setEdit("new")} disabled={!roles.data?.length}><PlusIcon /> New user</Button>} />
      <ErrorNote message={users.error ?? roles.error} />
      <div className="mb-3 flex items-center gap-2">
        <SearchField value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, username or role" className="w-full max-w-sm [&_input]:h-10" />
      </div>
      {users.loading && !users.data ? <LoadingRows /> : list.length ? (
        <div ref={tableRef}>
          <TablePanel>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">Name</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Branches</TableHead>
                  <TableHead>Sign-in</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((u) => (
                  <TableRow key={u.id} className="h-14 cursor-pointer" onClick={() => setEdit(u)}>
                    <TableCell className="pl-5">
                      <div className="flex items-center gap-3">
                        <Avatar name={u.displayName} size="md" />
                        <div>
                          <div className="font-medium">{u.displayName}{u.id === me.user.id && <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>}</div>
                          <div className="font-mono text-xs text-muted-foreground">{u.username}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>{u.isAdmin ? <Pill className={TONE.violet}>Administrator</Pill> : u.roleName}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">{u.branchIds.length ? u.branchIds.map((b) => <Pill key={b}>{branchName(b)}</Pill>) : <span className="text-xs text-muted-foreground">None</span>}</div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {u.hasPin && <Pill className={TONE.done} dot>PIN</Pill>}
                        {u.hasPassword && <Pill className={TONE.open} dot>Password</Pill>}
                        {!u.hasPin && !u.hasPassword && <span className="text-xs text-warning">Can’t sign in yet</span>}
                      </div>
                    </TableCell>
                    <TableCell>{u.isActive ? <ObjectStatus className={TONE.done}>Active</ObjectStatus> : <ObjectStatus className={TONE.muted}>Switched off</ObjectStatus>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TablePanel>
        </div>
      ) : users.data?.length ? (
        <EmptyState compact icon={UsersRoundIcon} title="Nobody matches" module="bp">Try another name.</EmptyState>
      ) : (
        <EmptyState icon={UsersRoundIcon} title="No users yet" module="bp" action={<Button size="lg" onClick={() => setEdit("new")}><PlusIcon /> New user</Button>}>
          Add cashiers, waiters and managers. Give each a role, their branches and a till PIN.
        </EmptyState>
      )}
      <UserDialog value={edit} roles={roles.data ?? []} onClose={() => setEdit(null)} onSaved={() => users.reload()} />
    </div>
  );
}

function UserDialog({ value, roles, onClose, onSaved }: { value: User | "new" | null; roles: Role[]; onClose: () => void; onSaved: () => void }) {
  const { company, me } = useSession();
  const isNew = value === "new";
  const blank = { username: "", displayName: "", password: "", roleId: "", branchIds: [] as string[], pin: "", clearPin: false, isActive: true };
  const [f, setF] = useState(blank);
  const [seen, setSeen] = useState<typeof value>(null);
  const [busy, setBusy] = useState(false);
  const [pinPad, setPinPad] = useState(false);
  const [limits, setLimits] = useState(limitState(null));
  if (value !== seen) {
    setSeen(value);
    setPinPad(false);
    setLimits(limitState(value && value !== "new" ? value : null));
    if (value && value !== "new") setF({ username: value.username, displayName: value.displayName, password: "", roleId: value.roleId, branchIds: value.branchIds, pin: "", clearPin: false, isActive: value.isActive });
    else setF({ ...blank, roleId: roles.find((r) => r.name === "Cashier")?.id ?? roles[0]?.id ?? "", branchIds: company?.branches.length === 1 ? [company.branches[0].id] : [] });
  }
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const toggleBranch = (id: string) => set("branchIds", f.branchIds.includes(id) ? f.branchIds.filter((b) => b !== id) : [...f.branchIds, id]);
  const existing = value && value !== "new" ? value : null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!company) return;
    setBusy(true);
    try {
      const own = Object.fromEntries(LIMITS.filter((l) => limits[l.key].mode !== "role").map((l) => [l.key, limits[l.key].mode === "none" ? null : Number(limits[l.key].value || 0)]));
      const body = { ...f, password: f.password || null, pin: f.pin || null, limits: own };
      if (isNew) await api(`/companies/${company.id}/users`, "POST", body);
      else if (existing) await api(`/companies/${company.id}/users/${existing.id}`, "PUT", body);
      toast.success(isNew ? `${f.displayName} added.` : "User saved.");
      onSaved();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!company || !existing) return;
    if (!(await confirmDialog({ title: `Remove ${existing.displayName} from ${company.name}?`, message: "They lose their role, branches and PIN here. Their history stays.", confirmLabel: "Remove", tone: "danger" }))) return;
    try {
      await api(`/companies/${company.id}/users/${existing.id}`, "DELETE");
      toast.success(`${existing.displayName} removed.`);
      onSaved();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <Dialog open={!!value} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={save} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{isNew ? "New user" : existing?.displayName}</DialogTitle>
            <DialogDescription>{company?.name}: role, branches and how they sign in.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required><Input value={f.displayName} onChange={(e) => set("displayName", e.target.value)} /></Field>
            <Field label="Username" required hint={isNew ? "Lower case, e.g. sara.ahmed" : "Can't change."}>
              <Input value={f.username} disabled={!isNew} onChange={(e) => set("username", e.target.value.toLowerCase())} autoCapitalize="none" />
            </Field>
            <Field label="Role" span>
              <div className="flex flex-wrap gap-1.5">
                {roles.map((r) => (
                  <button key={r.id} type="button" onClick={() => set("roleId", r.id)} aria-pressed={f.roleId === r.id}
                    className={cn("h-10 rounded-xl border px-3.5 text-sm font-medium transition-[background-color,transform] active:scale-[0.97]",
                      f.roleId === r.id ? "border-primary bg-primary text-primary-foreground shadow-soft" : "bg-card hover:bg-muted")}>{r.name}</button>
                ))}
              </div>
            </Field>
            <Field label="Branches" span hint="They can sign in and work only at these.">
              <div className="flex flex-wrap gap-1.5">
                {company?.branches.map((b) => (
                  <button key={b.id} type="button" onClick={() => toggleBranch(b.id)} aria-pressed={f.branchIds.includes(b.id)}
                    className={cn("h-10 rounded-xl border px-3.5 text-sm transition-[background-color,transform] active:scale-[0.97]",
                      f.branchIds.includes(b.id) ? "border-primary bg-primary/10 font-medium text-primary" : "bg-card hover:bg-muted")}>
                    {b.name} <span className="font-mono text-xs opacity-70">{b.code}</span>
                  </button>
                ))}
                {!company?.branches.length && <span className="text-sm text-muted-foreground">Add a branch first.</span>}
              </div>
            </Field>
          </div>

          <div className="rounded-2xl border p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium"><KeyRoundIcon className="size-4 text-primary" /> Till PIN</div>
                <p className="text-xs text-muted-foreground">
                  {f.pin ? `${f.pin.length} digits entered` : existing?.hasPin && !f.clearPin ? "A PIN is set. Enter a new one to change it." : "4–6 digits, unique in the company."}
                </p>
              </div>
              <div className="flex gap-1.5">
                {existing?.hasPin && !f.pin && (
                  <Button type="button" variant={f.clearPin ? "secondary" : "ghost"} onClick={() => set("clearPin", !f.clearPin)}>{f.clearPin ? "Will remove" : "Remove PIN"}</Button>
                )}
                <Button type="button" variant="outline" onClick={() => setPinPad((p) => !p)}>{pinPad ? "Done" : f.pin ? "Change" : "Set PIN"}</Button>
              </div>
            </div>
            {pinPad && <PinEntry value={f.pin} onChange={(v) => { set("pin", v); set("clearPin", false); }} />}
          </div>

          <div className="rounded-2xl border p-4">
            <div className="text-sm font-medium">Limits for this user</div>
            <p className="mb-3 text-xs text-muted-foreground">What they can give without a manager. &ldquo;As role&rdquo; follows the role ({roles.find((r) => r.id === f.roleId)?.name ?? "role"}); set an own limit or no limit for this person only.</p>
            <div className="grid gap-2">
              {LIMITS.map((l) => {
                const s = limits[l.key];
                const roleVal = roles.find((r) => r.id === f.roleId)?.limits?.[l.key];
                const roleText = roleVal === undefined ? "no limit" : l.unit === "%" ? `${roleVal}%` : `AED ${roleVal}`;
                return (
                  <div key={l.key} className="flex flex-wrap items-center gap-2">
                    <span className="w-20 text-sm">{l.label}</span>
                    <Segmented id={`lim-${l.key}`} size="sm" value={s.mode} onChange={(m) => setLimits((x) => ({ ...x, [l.key]: { ...x[l.key], mode: m } }))}
                      options={[{ value: "role", label: `As role (${roleText})` }, { value: "own", label: "Own limit" }, { value: "none", label: "No limit" }]} />
                    {s.mode === "own" && (
                      <span className="flex items-center gap-1.5">
                        <Input className="h-9 w-24 text-right" inputMode="decimal" value={s.value} aria-label={`${l.label} limit`}
                          onChange={(e) => setLimits((x) => ({ ...x, [l.key]: { ...x[l.key], value: e.target.value.replace(",", ".") } }))} />
                        <span className="text-sm text-muted-foreground">{l.unit}</span>
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <Field label={existing?.hasPassword ? "New back-office password" : "Back-office password"} hint="Only for people who use the back office. At least 8 characters, letters and digits.">
            <Input type="password" autoComplete="new-password" value={f.password} onChange={(e) => set("password", e.target.value)} placeholder={existing?.hasPassword ? "Leave empty to keep it" : "Optional"} />
          </Field>

          {existing && existing.id !== me.user.id && (
            <div className="flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5">
              <span className="text-sm">Active <span className="text-muted-foreground">· a switched-off user can’t sign in anywhere</span></span>
              <Switch on={f.isActive} onChange={(v) => set("isActive", v)} label="Active" />
            </div>
          )}
          <DialogFooter>
            {existing && existing.id !== me.user.id && <Button type="button" variant="destructive" className="sm:mr-auto" onClick={remove}>Remove from company</Button>}
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || !f.displayName || !f.username || !f.roleId}>{isNew ? "Add user" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A touch number pad for setting a PIN (the same keys as the till's PIN pad). The digits stay hidden. */
function PinEntry({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const press = (k: string) => {
    if (k === "back") onChange(value.slice(0, -1));
    else if (k === "clear") onChange("");
    else if (value.length < 6) onChange(value + k);
  };
  return (
    <div className="animate-rise-in mt-4 space-y-3">
      <div className="flex justify-center gap-2.5">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className={cn("size-3 rounded-full border-2 transition-all duration-150", i < value.length ? "scale-110 border-primary bg-primary" : i < 4 ? "border-muted-foreground/40" : "border-dashed border-muted-foreground/25")} />
        ))}
      </div>
      <div className="mx-auto grid max-w-64 grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"].map((k) => (
          <button key={k} type="button" onClick={() => press(k)}
            className={cn("flex h-12 items-center justify-center rounded-xl border bg-card font-heading text-lg font-medium shadow-soft transition-transform active:scale-[0.94] select-none hover:bg-muted",
              (k === "clear" || k === "back") && "text-sm font-normal text-muted-foreground")}>
            {k === "back" ? "⌫" : k === "clear" ? "Clear" : k}
          </button>
        ))}
      </div>
    </div>
  );
}
