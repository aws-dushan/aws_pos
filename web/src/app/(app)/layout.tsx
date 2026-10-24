"use client";

import { SessionProvider, useSession } from "@/components/session";
import { LiveProvider } from "@/components/live";
import { AppShell } from "@/components/app-shell";
import { ApprovalHost } from "@/components/approval";
import { Logo } from "@/components/logo";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider fallback={<Starting />}>
      <LiveProvider>
        <AppShell>
          <ScopeKey>{children}</ScopeKey>
        </AppShell>
        <ApprovalHost />
      </LiveProvider>
    </SessionProvider>
  );
}

/** Remounts the page when the company or branch changes, so no data from the previous one lingers on screen (as AWS One). */
function ScopeKey({ children }: { children: React.ReactNode }) {
  const { company, branch } = useSession();
  return <div key={`${company?.id ?? "none"}:${branch?.id ?? "none"}`}>{children}</div>;
}

function Starting() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="animate-pulse">
        <Logo variant="full" className="h-16" />
      </div>
    </div>
  );
}
