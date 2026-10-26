"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, setApiScope, SIGNED_OUT_EVENT } from "@/lib/api";
import { appStorage, withBase } from "@/lib/base-path";
import { fmtIn } from "@/lib/num";
import { FirstPasswordScreen } from "@/components/first-password";

export type Branch = { id: string; code: string; name: string; tableService: boolean; kitchenEnabled: boolean; returnsEnabled: boolean; dayControl: "manual" | "automatic" | "cashier"; isActive: boolean };
export type Company = {
  id: string; code: string; name: string; currency: string; vatRate: number; pricesIncludeVat: boolean; erpConnector: "none" | "awsone" | "facts";
  role: string | null; permissions: string[]; branches: Branch[];
  /** Switched on by an administrator (Companies & branches). */
  vouchersEnabled: boolean; loyaltyEnabled: boolean;
  /** Marketing give-aways on Stock: a FACTS marketing expense account is set (FACTS posting). */
  marketingEnabled: boolean;
};
export type Me = {
  user: { id: string; username: string; displayName: string; isAdmin: boolean; mustChangePassword?: boolean };
  till: { companyId: string; branchId: string; registerId: string | null; registerName: string | null } | null;
  companies: Company[];
};

type Session = {
  me: Me;
  company: Company | null;
  branch: Branch | null;
  /** True when this browser is a till signed in by PIN (fixed to one branch). */
  isTill: boolean;
  can: (perm: string) => boolean;
  money: (n: number) => string;
  switchTo: (companyId: string, branchId: string | null) => void;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}

const SCOPE_KEY = "onepos.scope";

/** Where this browser's PIN pad points (set once per till by a manager): its branch id. */
export const TILL_KEY = "onepos.till.branch";
/** Why the till was locked (e.g. the day closed by itself): shown once on the PIN pad (sessionStorage). */
export const LOCK_NOTE_KEY = "onepos.till.lock-note";
/** The register (Till 1, Till 2 …) this browser is, within that branch. */
export const TILL_REGISTER_KEY = "onepos.till.register";

/**
 * Loads who is signed in (/me) and keeps the chosen Company › Branch (remembered in this browser; a till is fixed to its own).
 * Not signed in: sends the user to the till's PIN pad when this browser is a till, else to the back-office sign-in.
 */
export function SessionProvider({ children, fallback }: { children: React.ReactNode; fallback: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [scope, setScope] = useState<{ companyId: string | null; branchId: string | null }>({ companyId: null, branchId: null });

  const goSignIn = useCallback(() => {
    let till: string | null = null;
    try { till = appStorage.getItem(TILL_KEY); } catch { /* storage unavailable */ }
    router.replace(till ? "/till" : "/login");
  }, [router]);

  /** Takes a fresh /me: picks the scope (the till's own, else the remembered one if still allowed, else the first company and branch). */
  const apply = useCallback((m: Me) => {
    setMe(m);
    let saved: { companyId?: string; branchId?: string | null } = {};
    try { saved = JSON.parse(appStorage.getItem(SCOPE_KEY) ?? "{}"); } catch { /* none */ }
    const company = m.till ? m.companies.find((c) => c.id === m.till!.companyId) : m.companies.find((c) => c.id === saved.companyId) ?? m.companies[0];
    const branch = m.till ? company?.branches.find((b) => b.id === m.till!.branchId)
      : company?.branches.find((b) => b.id === saved.branchId) ?? company?.branches[0];
    setScope({ companyId: company?.id ?? null, branchId: branch?.id ?? null });
    setApiScope(company?.id ?? null, branch?.id ?? null);
  }, []);

  const load = useCallback(() => api<Me>("/me").then(apply, goSignIn), [apply, goSignIn]);

  useEffect(() => {
    api<Me>("/me").then(apply, goSignIn);
    const onOut = () => goSignIn();
    window.addEventListener(SIGNED_OUT_EVENT, onOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onOut);
  }, [apply, goSignIn]);

  const value = useMemo<Session | null>(() => {
    if (!me) return null;
    const company = me.companies.find((c) => c.id === scope.companyId) ?? null;
    const branch = company?.branches.find((b) => b.id === scope.branchId) ?? null;
    const perms = new Set(company?.permissions ?? []);
    return {
      me, company, branch,
      isTill: !!me.till,
      can: (p) => me.user.isAdmin || perms.has(p),
      money: (n) => fmtIn(n, 2),
      switchTo: (companyId, branchId) => {
        if (me.till) return;
        setScope({ companyId, branchId });
        setApiScope(companyId, branchId);
        try { appStorage.setItem(SCOPE_KEY, JSON.stringify({ companyId, branchId })); } catch { /* storage unavailable */ }
      },
      refresh: load,
      signOut: async () => {
        await api("/auth/logout", "POST").catch(() => {});
        // A full page load on purpose: nothing of the previous user's state survives.
        window.location.href = withBase(me.till ? "/till" : "/login");
      },
    };
  }, [me, scope, load]);

  if (!value) return <>{fallback}</>;
  // A password someone else set: nothing opens until its owner has chosen their own.
  if (value.me.user.mustChangePassword) return <FirstPasswordScreen name={value.me.user.displayName} onDone={() => void load()} />;
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
