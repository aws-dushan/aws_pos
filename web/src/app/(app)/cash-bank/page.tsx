"use client";

import { CalendarClockIcon, HandCoinsIcon, LandmarkIcon } from "lucide-react";
import { useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { fmtIn } from "@/lib/num";
import { useSession } from "@/components/session";
import { useLiveEvent } from "@/components/live";
import { EmptyState, ErrorNote, LoadingRows, PageHeader, StatTile, TablePanel } from "@/components/kit";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Day = { date: string; broughtForward: number; cashSales: number; refunds: number; added: number; remarks: string | null; deposited: number; carriedForward: number };
type Deposit = { date: string; amount: number; bagNo: string | null; takenBy: string; register: string | null; at: string };
type BranchOwed = { id: string; code: string; name: string; owed: number; oldest: string | null };
type CashBank = { from: string; owed: number; oldest: string | null; depositedThisMonth: number; days: Day[]; deposits: Deposit[]; branches: BranchOwed[] };

const day = (s: string) => new Date(s + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const daysSince = (s: string) => Math.max(0, Math.round((Date.now() - new Date(s + "T00:00:00").getTime()) / 86_400_000));
const money = (n: number) => fmtIn(n, 2);

/** Cash to bank: every cash sale is owed to the bank; what isn't deposited yet carries forward day to day. Per header branch. */
export default function CashBankPage() {
  const { company, branch } = useSession();
  const cur = company?.currency ?? "AED";
  const data = useApi<CashBank>("/cash-bank");
  useLiveEvent(["day.changed", "order.changed"], () => data.reload());
  const d = data.data;
  const late = d?.oldest ? daysSince(d.oldest) : 0;
  // Amounts added by hand (e.g. cash held from before One POS): their own column, only when there are any.
  const anyAdded = !!d?.days.some((r) => r.added);

  return (
    <div>
      <PageHeader title="Cash to bank" icon={LandmarkIcon} module="bank"
        description={`Every cash sale at ${branch?.name ?? "this branch"} goes to the bank. What isn't deposited yet carries forward until it is. Deposits are recorded on the till: Cash in / out → Bank deposit.`} />
      <ErrorNote message={data.error} />
      {data.loading && !d ? <LoadingRows rows={4} /> : d && (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <StatTile label="Owed to bank now" value={`${cur} ${money(d.owed)}`} icon={HandCoinsIcon} module="bank" tone={d.owed > 0 ? "warn" : "success"}
              hint={d.owed > 0 ? (late > 0 ? `Not deposited for ${late} day${late === 1 ? "" : "s"}` : "From today's cash sales") : d.owed < 0 ? "Deposited more than the cash sales" : "All cash sales are deposited"} />
            <StatTile label="Oldest cash not deposited" value={d.oldest ? day(d.oldest) : "—"} icon={CalendarClockIcon} module="bank" hint={`Counted from ${day(d.from)}`} />
            <StatTile label="Deposited this month" value={`${cur} ${money(d.depositedThisMonth)}`} icon={LandmarkIcon} module="bank" />
          </div>

          {d.branches.length > 1 && (
            <section className="mb-6">
              <h2 className="mb-3 font-heading text-[0.95rem] font-semibold">All branches</h2>
              <TablePanel>
                <Table>
                  <TableHeader><TableRow>
                    <TableHead className="pl-5">Branch</TableHead><TableHead className="text-right">Owed to bank</TableHead><TableHead className="pr-5">Oldest not deposited</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {d.branches.map((b) => (
                      <TableRow key={b.id} className={cn(b.id === branch?.id && "bg-muted/40")}>
                        <TableCell className="pl-5"><span className="font-medium">{b.name}</span> <span className="font-mono text-xs text-muted-foreground">{b.code}</span></TableCell>
                        <TableCell className={cn("text-right font-medium tabular-nums", b.owed > 0 && "text-warning")}>{money(b.owed)}</TableCell>
                        <TableCell className="pr-5 text-muted-foreground">{b.oldest ? `${day(b.oldest)} (${daysSince(b.oldest)} day${daysSince(b.oldest) === 1 ? "" : "s"})` : "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TablePanel>
            </section>
          )}

          <h2 className="mb-3 font-heading text-[0.95rem] font-semibold">By day</h2>
          {d.days.length ? (
            <TablePanel>
              <Table>
                <TableHeader><TableRow>
                  <TableHead className="pl-5">Day</TableHead><TableHead className="text-right">Brought forward</TableHead><TableHead className="text-right">Cash sales</TableHead>
                  <TableHead className="text-right">Cash refunds</TableHead>{anyAdded && <TableHead>Added to owed</TableHead>}<TableHead className="text-right">Deposited</TableHead><TableHead className="pr-5 text-right">Carried forward</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {d.days.map((r) => (
                    <TableRow key={r.date}>
                      <TableCell className="pl-5 whitespace-nowrap">{day(r.date)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{money(r.broughtForward)}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(r.cashSales)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{r.refunds ? `−${money(r.refunds)}` : "—"}</TableCell>
                      {anyAdded && (
                        <TableCell className="max-w-64">
                          {r.added ? <><span className="tabular-nums">{r.added > 0 ? "+" : "−"}{money(Math.abs(r.added))}</span>{r.remarks && <div className="text-xs text-muted-foreground">{r.remarks}</div>}</> : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                      )}
                      <TableCell className="text-right tabular-nums">{r.deposited ? `−${money(r.deposited)}` : "—"}</TableCell>
                      <TableCell className={cn("pr-5 text-right font-medium tabular-nums", r.carriedForward > 0 && "text-warning")}>{money(r.carriedForward)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TablePanel>
          ) : <EmptyState icon={LandmarkIcon} title="No cash sales yet" module="bank" compact>Cash sales from {day(d.from)} show here, day by day.</EmptyState>}

          {!!d.deposits.length && (
            <section className="mt-6">
              <h2 className="mb-3 font-heading text-[0.95rem] font-semibold">Bank deposits</h2>
              <TablePanel>
                <Table>
                  <TableHeader><TableRow>
                    <TableHead className="pl-5">Day</TableHead><TableHead>Bag or slip</TableHead><TableHead>Taken by</TableHead><TableHead>From</TableHead><TableHead className="pr-5 text-right">Amount</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {d.deposits.map((x, i) => (
                      <TableRow key={`${x.at}-${i}`}>
                        <TableCell className="pl-5 whitespace-nowrap">{day(x.date)}</TableCell>
                        <TableCell className="font-mono text-xs">{x.bagNo ?? "—"}</TableCell>
                        <TableCell>{x.takenBy}</TableCell>
                        <TableCell className="text-muted-foreground">{x.register ? `Drawer · ${x.register}` : "Safe"}</TableCell>
                        <TableCell className="pr-5 text-right font-medium tabular-nums">{money(x.amount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TablePanel>
            </section>
          )}
        </>
      )}
    </div>
  );
}
