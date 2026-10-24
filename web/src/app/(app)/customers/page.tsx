"use client";

import { useEffect, useState } from "react";
import { ContactRoundIcon, PlusIcon } from "lucide-react";
import { useApi } from "@/lib/api";
import { cn, timeAgo } from "@/lib/utils";
import { fmtIn } from "@/lib/num";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { CustomerDialog, type Customer } from "@/components/customer";
import { EmptyState, ErrorNote, LoadingRows, ObjectStatus, PageHeader, SearchField, TablePanel, TONE } from "@/components/kit";
import { Avatar } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** Customers (REQ CUS-01 … CUS-04): search by name or phone; open one for details, favourites and order history. */
export default function CustomersPage() {
  const { company } = useSession();
  const cur = company?.currency ?? "AED";
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => { const t = window.setTimeout(() => setTerm(q.trim()), 250); return () => window.clearTimeout(t); }, [q]);
  const list = useApi<Customer[]>(`/customers${term ? `?q=${encodeURIComponent(term)}` : ""}`);
  useLiveEvent(["order.changed"], () => list.reload());
  const [open, setOpen] = useState<string | "new" | null>(null);

  return (
    <div>
      <PageHeader title="Customers" icon={ContactRoundIcon} module="bp" count={list.data?.length}
        description="Regulars found by phone at the register. A paid order with a new phone number and a name adds one."
        actions={<Button size="lg" onClick={() => setOpen("new")}><PlusIcon /> New customer</Button>} />
      <SearchField value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or phone" className="mb-4 w-80 max-w-full" />
      <ErrorNote message={list.error} />
      {list.loading && !list.data ? <LoadingRows /> : list.data?.length ? (
        <TablePanel>
          <Table>
            <TableHeader><TableRow>
              <TableHead className="pl-5">Customer</TableHead><TableHead>Phone</TableHead><TableHead className="text-right">Visits</TableHead>
              <TableHead className="text-right">Spent</TableHead><TableHead className="pr-5">Last visit</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {list.data.map((c) => (
                <TableRow key={c.id} className={cn("cursor-pointer", !c.isActive && "opacity-55")} onClick={() => setOpen(c.id)}>
                  <TableCell className="pl-5">
                    <div className="flex items-center gap-3">
                      <Avatar name={c.name} />
                      <div className="min-w-0">
                        <div className="truncate font-medium">{c.name} {!c.isActive && <ObjectStatus className={TONE.muted}>Archived</ObjectStatus>}</div>
                        {c.notes && <div className="truncate text-xs text-warning">{c.notes}</div>}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">{c.phone ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.visits}</TableCell>
                  <TableCell className="text-right tabular-nums">{cur} {fmtIn(c.spend, 2)}</TableCell>
                  <TableCell className="pr-5 text-muted-foreground">{c.lastVisit ? timeAgo(c.lastVisit) : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TablePanel>
      ) : (
        <EmptyState icon={ContactRoundIcon} title={term ? "No customer matches" : "No customers yet"} module="bp"
          action={<Button size="lg" onClick={() => setOpen("new")}><PlusIcon /> New customer</Button>}>
          {term ? `Nobody with “${term}” in their name or phone.` : "They're added from paid orders with a phone number and a name, or here."}
        </EmptyState>
      )}
      <CustomerDialog value={open} currency={cur} onClose={() => setOpen(null)} onSaved={() => list.reload()} />
    </div>
  );
}
