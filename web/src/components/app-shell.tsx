"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDeviceHeartbeat } from "@/components/device-heartbeat";
import { NoticeBell } from "@/components/notice-bell";
import { AnimatePresence, motion } from "motion/react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import {
  BellRingIcon, CircleHelpIcon, InboxIcon, MessageSquareWarningIcon,
  CheckIcon, ChevronRightIcon, ScaleIcon, ChevronsUpDownIcon, KeyRoundIcon, LockIcon, LogOutIcon, MonitorSmartphoneIcon, MonitorXIcon, MoonIcon,
  PanelLeftCloseIcon, PanelLeftOpenIcon, SunIcon, WifiOffIcon, ZapOffIcon,
} from "lucide-react";
import { api, pickRegister, useApi } from "@/lib/api";
import { setStored, useMedia, useNow, useStored } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { matches, shortcut, shortcutTitle, SHORTCUT_GROUPS, SHORTCUTS } from "@/lib/shortcuts";
import { openReportProblem, ReportProblemHost } from "@/components/feedback";
import { LOCK_NOTE_KEY, TILL_KEY, TILL_REGISTER_KEY, useSession } from "@/components/session";
import { useLiveEvent, useOnline } from "@/components/live";
import { Logo, PRODUCT } from "@/components/logo";
import { ActiveIndicator, useMotionPref } from "@/components/motion";
import { ModuleIcon, SCREENS, screenOf, type Screen } from "@/components/modules";
import { Field } from "@/components/kit";
import { confirmDialog } from "@/components/confirm";
import { DayClosing } from "@/components/day-closing";
import { goCloseShift } from "@/components/my-shift";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Screens that use the whole window (no page width limit): the register and kitchen, from phase 1. */
const FULL_BLEED = ["/register", "/kitchen"];
const GROUPS = ["Service", "Back office", "Administration"] as const;

/** The AWS One shell: slim top bar, collapsible side menu with the sliding active highlight, bottom bar on phones. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { me, can, company, branch, isTill, signOut } = useSession();
  const online = useOnline();
  useDeviceHeartbeat(branch?.id);
  // The day closed by itself (automatic day control): a till locks back to its PIN pad, so nobody stays signed in overnight.
  useLiveEvent(["day.autoclosed"], (e) => {
    if (!isTill) return;
    const at = (e.data as { at?: string } | undefined)?.at;
    try { sessionStorage.setItem(LOCK_NOTE_KEY, `The day was closed at ${at ?? "closing time"}. Sign in again when the next day starts.`); } catch { /* storage unavailable */ }
    void signOut();
  });
  const screens = SCREENS.filter((s) => (!s.admin || me.user.isAdmin) && (!s.perm || s.perm.split("|").some(can)) && (!s.tableOnly || branch?.tableService) && (!s.kitchenOnly || branch?.kitchenEnabled)
    && (!s.rewardsOnly || company?.vouchersEnabled || company?.loyaltyEnabled) && (!s.factsOnly || company?.erpConnector === "facts"));
  const active = screenOf(pathname);
  const full = FULL_BLEED.some((p) => pathname.startsWith(p));

  // Side navigation collapsed to an icon rail: remembered in this browser. Not chosen yet: an icon rail on screens narrower than
  // 1280 px (a 1024 x 768 till keeps its width for the work), the full menu on wider ones.
  const railPick = useStored("onepos.sidebar.collapsed");
  const narrow = useMedia("(max-width: 1279px)");
  const collapsed = railPick === null ? narrow : railPick === "1";
  const toggleRail = () => setStored("onepos.sidebar.collapsed", collapsed ? "0" : "1");
  const [keysOpen, setKeysOpen] = useState(false);

  // Global keyboard (keys from lib/shortcuts.ts, as AWS One): Alt R report a problem, F7 bill, F8 send, F9 pay, Alt N new order, "/" search, "?" shortcuts.
  useEffect(() => {
    const visible = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)].find((el) => el.offsetParent !== null && !el.closest("[aria-hidden=true]"));
    const typing = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.("input,textarea,select,[role=combobox],[contenteditable=true]");
    // A screen's button: not while a dialog is open over it (no second payment from behind the payment dialog).
    const press = (e: KeyboardEvent, id: string) => {
      if (document.querySelector("[role=dialog]")) return;
      const b = visible(`[data-shortcut=${id}]`) as HTMLButtonElement | undefined;
      if (b && !b.disabled) { e.preventDefault(); b.click(); }
    };
    const onKey = (e: KeyboardEvent) => {
      // Report a problem from any screen, even while typing (the screenshot shows the half-filled form).
      if (matches("reportProblem", e)) { e.preventDefault(); openReportProblem(); return; }
      for (const id of ["pay", "send", "bill", "new"]) if (matches(id, e)) return press(e, id);
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (matches("search", e)) { const s = visible("[data-list-search]"); if (s) { e.preventDefault(); s.focus(); } }
      else if (matches("help", e)) { e.preventDefault(); setKeysOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex min-h-screen flex-col overflow-x-clip">
      <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center gap-3 border-b bg-card px-3 md:px-4">
        <Link href="/" className="flex shrink-0 items-center pr-2" aria-label={`${PRODUCT} home`}>
          <Logo className="h-8 md:h-10" />
        </Link>
        <div className="hidden h-6 w-px bg-border md:block" />
        <ScopeSwitcher />
        <div className="mx-auto hidden items-center gap-2 lg:flex"><Clock /></div>
        <div className="ml-auto flex items-center gap-1.5 lg:ml-0">
          <NoticeBell />
          <ApprovalBell />
          <Button variant="ghost" size="icon" aria-label="Report a problem" title={shortcutTitle("reportProblem", "Report a problem")} data-testid="report-problem-button"
            className="size-10 rounded-xl text-muted-foreground hover:text-foreground" onClick={() => openReportProblem()}>
            <MessageSquareWarningIcon className="size-5" />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Keyboard shortcuts and help" title={shortcutTitle("help", "Keyboard shortcuts")}
            className="hidden size-10 rounded-xl text-muted-foreground hover:text-foreground md:inline-flex" onClick={() => setKeysOpen(true)}>
            <CircleHelpIcon className="size-5" />
          </Button>
          <UserMenu />
        </div>
      </header>

      <AnimatePresence initial={false}>
        {!online && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="sticky top-14 z-30 overflow-hidden border-b border-warning/30 bg-warning/12 text-warning" role="status">
            <div className="flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium">
              <WifiOffIcon className="size-4" /> Reconnecting to {PRODUCT}… Wait before taking payments; nothing you send is lost or doubled.
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex min-h-0 flex-1">
        <aside data-collapsed={collapsed || undefined}
          className={cn("sticky top-14 hidden h-[calc(100vh-3.5rem)] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex", collapsed ? "w-[4.25rem]" : "w-60")}>
          <nav aria-label="Main menu" className={cn("scrollbar-thin flex-1 space-y-4 overflow-x-hidden overflow-y-auto py-3", collapsed ? "px-2" : "px-3")}>
            {collapsed ? (
              <div className="flex flex-col items-center gap-1">
                {screens.map((s) => <RailButton key={s.href} screen={s} active={active.href === s.href} />)}
              </div>
            ) : (
              GROUPS.map((g) => {
                const list = screens.filter((s) => s.group === g);
                if (!list.length) return null;
                return (
                  <div key={g} className="space-y-0.5">
                    <SectionLabel>{g}</SectionLabel>
                    {list.map((s) => <MenuLink key={s.href} screen={s} active={active.href === s.href} />)}
                  </div>
                );
              })
            )}
          </nav>
          <div className={cn("border-t border-sidebar-border py-2", collapsed ? "flex justify-center px-2" : "px-3")}>
            <button type="button" onClick={toggleRail} aria-label={collapsed ? "Expand the menu" : "Collapse the menu"} title={collapsed ? "Expand the menu" : "Collapse the menu"}
              className={cn("flex items-center gap-2 rounded-lg py-1.5 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground", collapsed ? "px-2" : "w-full px-2.5")}>
              {collapsed ? <PanelLeftOpenIcon className="size-4" /> : <><PanelLeftCloseIcon className="size-4" /> Collapse</>}
            </button>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <main className={cn("w-full flex-1 overflow-x-clip pb-20 md:pb-10", full ? "px-3 md:px-5 md:pb-0" : "mx-auto max-w-[1480px] px-4 md:px-8")}>
            <DayClosing />
            {children}
          </main>
        </div>
      </div>

      <BottomNav screens={screens} active={active.href} />
      <ShortcutsSheet open={keysOpen} onOpenChange={setKeysOpen} />
      <ReportProblemHost />
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-1.5 px-2.5 pt-1 pb-1.5 text-[0.68rem] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{children}</div>;
}

function MenuLink({ screen, active }: { screen: Screen; active: boolean }) {
  return (
    <div className="group relative" data-module={screen.module}>
      {active && <ActiveIndicator id="nav-main" className="rounded-lg bg-[linear-gradient(90deg,color-mix(in_oklab,var(--mod)_13%,var(--sidebar-accent)),var(--sidebar-accent))] shadow-[0_1px_2px_oklch(0.2_0.012_275/0.06),0_4px_12px_-4px_oklch(0.2_0.012_275/0.12)] ring-1 ring-sidebar-border" />}
      {active && <ActiveIndicator id="nav-main-bar" className="inset-y-2 right-auto left-0 w-[3px] rounded-full bg-mod-grad" />}
      <Link href={screen.href} aria-current={active ? "page" : undefined}
        className={cn("relative flex items-center gap-2.5 rounded-lg py-[0.45rem] pr-2 pl-2.5 text-[0.8125rem] transition-colors",
          active ? "font-medium text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground")}>
        <ModuleIcon module={screen.module} icon={screen.icon} size="xs" solid={active} className="-my-0.5 size-6 transition-transform duration-200 group-hover:scale-110 [&_svg]:size-3.5" />
        <span className="min-w-0 flex-1">{screen.label}</span>
      </Link>
    </div>
  );
}

function RailButton({ screen, active }: { screen: Screen; active: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger render={
        <Link href={screen.href} aria-label={screen.label}
          className={cn("relative flex size-11 items-center justify-center rounded-xl transition-colors hover:bg-sidebar-accent hover:shadow-soft", active && "bg-sidebar-accent shadow-soft")}>
          <ModuleIcon module={screen.module} icon={screen.icon} size="sm" solid={active} />
        </Link>
      } />
      <TooltipContent side="right">{screen.label}</TooltipContent>
    </Tooltip>
  );
}

/** Phones: the screens as a bottom bar (the side menu is hidden there). */
function BottomNav({ screens, active }: { screens: Screen[]; active: string }) {
  const list = screens.slice(0, 5);
  return (
    <nav aria-label="Main menu" className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-card/95 px-1 pb-[env(safe-area-inset-bottom)] md:hidden">
      {list.map((s) => {
        const on = s.href === active;
        return (
          <Link key={s.href} href={s.href} data-module={s.module} aria-current={on ? "page" : undefined}
            className={cn("relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[0.62rem] font-medium", on ? "text-mod" : "text-muted-foreground")}>
            {on && <ActiveIndicator id="nav-bottom" className="inset-x-3 top-0 bottom-auto h-[3px] rounded-full bg-mod-grad" />}
            <s.icon className="size-5" />
            <span className="max-w-full truncate px-1">{s.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

const initials = (s: string) => s.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

/** Company › Branch, like AWS One's company switcher. A till shows its own branch, fixed. */
function ScopeSwitcher() {
  const { me, company, branch, switchTo, isTill } = useSession();
  const chip = (
    <span className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors hover:bg-muted">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-ink font-heading text-[0.62rem] font-semibold text-background">{initials(company?.name ?? "?")}</span>
      <span className="hidden min-w-0 md:block">
        <span className="flex min-w-0 items-center gap-1 text-[0.8125rem] leading-tight font-medium whitespace-nowrap">
          <span className="truncate">{company?.name ?? "No company yet"}</span>
          {branch && <><ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" /><span className="truncate">{branch.name}</span></>}
        </span>
        <span className="block truncate text-[0.7rem] leading-tight text-muted-foreground">
          {company ? `${company.code}${branch ? ` · ${branch.code}` : ""} · ${company.currency} · ${branch ? (branch.tableService ? "Table service" : "Quick service") : "No branch"}` : "Create one under Companies & branches"}
        </span>
      </span>
      {!isTill && <ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground" />}
    </span>
  );
  if (isTill || !me.companies.length) return <div className="min-w-0">{chip}</div>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<button type="button" className="min-w-0">{chip}</button>} />
      <DropdownMenuContent className="max-h-[70vh] w-72" align="start">
        {me.companies.map((c, i) => (
          <DropdownMenuGroup key={c.id}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="flex items-center gap-2">
              <span className="flex size-5 items-center justify-center rounded-md bg-muted text-[0.55rem] font-bold">{c.code.slice(0, 2)}</span>{c.name}
            </DropdownMenuLabel>
            {c.branches.length ? c.branches.map((b) => (
              <DropdownMenuItem key={b.id} onClick={() => switchTo(c.id, b.id)} className={b.isActive ? "" : "text-muted-foreground"}>
                <span className="flex-1 pl-7">{b.name} <span className="font-mono text-[0.7rem] text-muted-foreground">{b.code}</span></span>
                {b.id === branch?.id && <CheckIcon className="size-4 text-primary" />}
              </DropdownMenuItem>
            )) : (
              <DropdownMenuItem onClick={() => switchTo(c.id, null)}>
                <span className="flex-1 pl-7 text-muted-foreground">No branches yet</span>
                {c.id === company?.id && !branch && <CheckIcon className="size-4 text-primary" />}
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Clock() {
  const now = useNow(15000);
  if (!now) return null;
  return (
    <span className="text-[0.8125rem] text-muted-foreground tabular-nums">
      {now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
      <span className="mx-1.5 text-border">|</span>
      <span className="font-heading font-semibold text-foreground">{now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
    </span>
  );
}

function SwitchRow({ icon: Icon, label, on, onClick }: { icon: React.ComponentType<{ className?: string }>; label: string; on: boolean; onClick: () => void }) {
  return (
    <DropdownMenuItem closeOnClick={false} onClick={onClick}>
      <Icon className="size-4" /> <span className="flex-1">{label}</span>
      <span className={cn("relative h-4 w-7 rounded-full transition-colors", on ? "bg-primary" : "bg-muted-foreground/30")}>
        <span className={cn("absolute top-0.5 size-3 rounded-full bg-white shadow transition-transform", on ? "translate-x-3.5" : "translate-x-0.5")} />
      </span>
    </DropdownMenuItem>
  );
}

/** The user menu: theme, "Reduce animations", password, till set-up, sign out (a till: lock back to the PIN pad). */
/** For managers: how many requests wait for approval (all their branches), live, with a nudge when a new one arrives. */
function ApprovalBell() {
  const { can } = useSession();
  const show = can("day.manage") || can("pos.refund");
  const list = useApi<{ id: string; summary: string; requestedByName: string }[]>(show ? "/approvals?all=true" : null);
  const seen = useRef<Set<string> | null>(null);
  useLiveEvent(["approvals.changed"], () => list.reload());
  useEffect(() => {
    if (!list.data) return;
    if (seen.current) for (const a of list.data) if (!seen.current.has(a.id)) toast.message(`${a.requestedByName} asks: ${a.summary}`, { description: "Open Approvals to answer.", icon: <BellRingIcon className="size-4" /> });
    seen.current = new Set(list.data.map((a) => a.id));
  }, [list.data]);
  if (!show) return null;
  const n = list.data?.length ?? 0;
  return (
    <Link href="/approvals" aria-label={`Approvals${n ? `: ${n} waiting` : ""}`} className="relative flex size-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
      <BellRingIcon className={cn("size-5", n > 0 && "text-primary")} />
      {n > 0 && <span className="absolute top-1 right-1 flex min-w-4.5 items-center justify-center rounded-full bg-danger px-1 text-[0.65rem] font-semibold text-white tabular-nums animate-rise-in">{n}</span>}
    </Link>
  );
}

function UserMenu() {
  const { me, company, branch, isTill, can, signOut } = useSession();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const { reduced, setReduced } = useMotionPref();
  const [pwOpen, setPwOpen] = useState(false);
  const [tillOpen, setTillOpen] = useState(false);
  const tillBranch = useStored(TILL_KEY);
  const roleLabel = me.user.isAdmin ? "Administrator" : company?.role ?? "User";

  // Leaving with the shift still open: close it now (count the drawer), or keep it open (a break) and just go.
  async function leave() {
    const d = branch && can("day.shift") ? await api<{ myShiftId: string | null }>("/day").catch(() => null) : null;
    if (d?.myShiftId && await confirmDialog({
      title: "Your shift is still open",
      message: "Close it now and count the drawer, or keep it open (e.g. for a break) and come back to it.",
      confirmLabel: "Close my shift", cancelLabel: isTill ? "Just lock" : "Just sign out",
    })) { goCloseShift(router.push); return; }
    await signOut();
  }

  function unmakeTill() {
    setStored(TILL_KEY, null);
    setStored(TILL_REGISTER_KEY, null);
    toast.success("This device is no longer a till.");
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={
          <button type="button" aria-label="User menu" className="ml-1 flex items-center gap-2 rounded-full p-0.5 transition-colors hover:bg-muted md:rounded-lg md:pr-2">
            <span className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{initials(me.user.displayName)}</span>
            <span className="hidden text-left md:block">
              <span className="block text-[0.8125rem] leading-tight font-medium">{me.user.displayName}</span>
              <span className="block text-[0.7rem] leading-tight text-muted-foreground">{roleLabel}{isTill ? ` · ${me.till?.registerName ?? "Till"}` : ""}</span>
            </span>
          </button>
        } />
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuGroup><DropdownMenuLabel>{me.user.displayName} · {roleLabel}</DropdownMenuLabel></DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Display</DropdownMenuLabel>
            <SwitchRow icon={resolvedTheme === "dark" ? MoonIcon : SunIcon} label="Dark theme" on={resolvedTheme === "dark"} onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")} />
            <SwitchRow icon={ZapOffIcon} label="Reduce animations" on={reduced} onClick={() => setReduced(!reduced)} />
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          {!isTill && <DropdownMenuItem onClick={() => setPwOpen(true)}><KeyRoundIcon className="size-4" /> Change password</DropdownMenuItem>}
          {!isTill && branch && can("branch.manage") && tillBranch !== branch.id && (
            <DropdownMenuItem onClick={() => setTillOpen(true)}><MonitorSmartphoneIcon className="size-4" /> Use this device as a till for {branch.name}</DropdownMenuItem>
          )}
          {!isTill && tillBranch && can("branch.manage") && (
            <DropdownMenuItem onClick={unmakeTill}><MonitorXIcon className="size-4" /> Stop using this device as a till</DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => openReportProblem()}>
            <MessageSquareWarningIcon className="size-4" /> Report a problem <Keys keys={shortcut("reportProblem")!.keys} className="ml-auto" />
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push("/admin/feedback?mine=true")}><InboxIcon className="size-4" /> My problem reports</DropdownMenuItem>
          {branch && can("day.shift") && (
            <DropdownMenuItem onClick={() => goCloseShift(router.push)}><ScaleIcon className="size-4" /> Close my shift</DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => void leave()}>
            {isTill ? <><LockIcon className="size-4" /> Lock till</> : <><LogOutIcon className="size-4" /> Sign out</>}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <PasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
      {branch && <TillSetupDialog open={tillOpen} onOpenChange={setTillOpen} branchId={branch.id} branchName={branch.name} />}
    </>
  );
}

function PasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/me/password", "POST", { current, next });
      toast.success("Password changed.");
      onOpenChange(false);
      setCurrent(""); setNext("");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={save} className="grid gap-4">
          <DialogHeader><DialogTitle>Change password</DialogTitle></DialogHeader>
          <Field label="Current password"><Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
          <Field label="New password" hint="At least 8 characters, letters and digits."><Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !current || !next}>Change password</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Use this device as a till": which register of the branch this browser is (REQ HW-02). A register can be added here too. */
function TillSetupDialog({ open, onOpenChange, branchId, branchName }: { open: boolean; onOpenChange: (o: boolean) => void; branchId: string; branchName: string }) {
  const regs = useApi<{ id: string; code: string; name: string; isActive: boolean }[]>(open ? `/branches/${branchId}/registers` : null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  function pick(id: string, label: string) {
    setStored(TILL_KEY, branchId);
    setStored(TILL_REGISTER_KEY, id);
    // The same till for a password sign-in on this browser (the Dashboard's register), so the two never disagree.
    pickRegister(branchId, id);
    onOpenChange(false);
    toast.success(`This device is now ${label} at ${branchName}. Cashiers sign in here with their PIN.`);
  }
  async function add(e: React.FormEvent) {
    e.preventDefault();
    try {
      const r = await api<{ id: string }>(`/branches/${branchId}/registers`, "POST", { code, name });
      pick(r.id, name);
      setCode(""); setName("");
    } catch (err) {
      toast.error((err as Error).message);
    }
  }
  const active = regs.data?.filter((r) => r.isActive) ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Use this device as a till</DialogTitle></DialogHeader>
        <p className="-mt-2 text-sm text-muted-foreground">Which register of {branchName} is this? Its sales show as that register&apos;s.</p>
        <div className="grid gap-2">
          {active.map((r) => (
            <button key={r.id} type="button" onClick={() => pick(r.id, r.name)}
              className="flex h-14 items-center gap-3 rounded-xl border bg-card px-4 text-left transition-[background-color,transform] hover:bg-muted active:scale-[0.98]">
              <MonitorSmartphoneIcon className="size-5 text-primary" />
              <span className="flex-1 font-medium">{r.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{r.code}</span>
            </button>
          ))}
          {regs.data && !active.length && <p className="text-sm text-muted-foreground">No registers yet. Add the first one:</p>}
        </div>
        <form onSubmit={add} className="grid grid-cols-[6rem_1fr_auto] items-end gap-2 border-t pt-4">
          <Field label="Code"><Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="T3" maxLength={10} /></Field>
          <Field label="New register"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Till 3" /></Field>
          <Button type="submit" disabled={!code || !name}>Add</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Keys as <kbd>s: "↑ ↓  Enter" → [↑ ↓] [Enter]. */
export function Keys({ keys, className }: { keys: string; className?: string }) {
  return (
    <span className={cn("flex shrink-0 gap-1", className)}>
      {keys.split("  ").map((x) => <kbd key={x} className="rounded-md border bg-muted px-1.5 py-0.5 font-sans text-xs font-medium whitespace-nowrap">{x}</kbd>)}
    </span>
  );
}

/** Every shortcut (lib/shortcuts.ts), by group, with a search; the ones that work on the screen behind are marked "On this screen". */
function ShortcutsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const pathname = usePathname();
  const [q, setQ] = useState("");
  // Read once per opening: what the screen behind offers.
  const here = useMemo(() => new Set(open ? SHORTCUTS.filter((x) => x.scope?.(pathname, document)).map((x) => x.id) : []), [open, pathname]);
  const term = q.trim().toLowerCase();
  const list = SHORTCUTS.filter((x) => !term || `${x.keys} ${x.description} ${x.group}`.toLowerCase().includes(term));
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) setQ(""); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg" data-testid="shortcuts-sheet">
        <DialogHeader><DialogTitle>Keyboard shortcuts</DialogTitle></DialogHeader>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search shortcuts" aria-label="Search shortcuts"
          className="h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50" />
        {SHORTCUT_GROUPS.map((g) => {
          const rows = list.filter((x) => x.group === g);
          if (!rows.length) return null;
          return (
            <section key={g} data-shortcut-group={g}>
              <h3 className="mt-2 mb-1 font-heading text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g}</h3>
              <div className="divide-y">
                {rows.map((x) => (
                  <div key={x.id} data-shortcut-row={x.id} data-here={here.has(x.id) || undefined}
                    className={cn("flex items-center justify-between gap-4 rounded-md px-1 py-2 text-sm", here.has(x.id) && "bg-primary/6")}>
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      <span className="text-muted-foreground">{x.description}</span>
                      {here.has(x.id) && <span className="ml-2 rounded bg-primary/12 px-1.5 py-0.5 text-[0.7rem] font-medium text-primary">On this screen</span>}
                    </span>
                    <Keys keys={x.keys} />
                  </div>
                ))}
              </div>
            </section>
          );
        })}
        {!list.length && <p className="text-sm text-muted-foreground">No shortcut matches “{q}”.</p>}
      </DialogContent>
    </Dialog>
  );
}
