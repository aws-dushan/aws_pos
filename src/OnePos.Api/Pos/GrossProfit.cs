using Dapper;
using OnePos.Api.Data;
using OnePos.Api.Erp;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Gross profit (admin and finance): sales before VAT against what they cost in FACTS, by item, category, day and branch.
/// A bill line's cost is read from FACTS when the report opens (read-only): its POS51 line's quantity × the landed cost of the
/// batch on it. That is what FACTS books once its cost recalculation has run, but right from the start (the cost FACTS books
/// on the day can't be trusted until then). Bills not in FACTS yet, and lines FACTS has no batch (or a different item) for,
/// have no cost: they're counted apart and left out of the gross profit, so it never looks better than it is. Refunds don't
/// go to FACTS yet, so gross profit is on the bills as sold; the days' refunds are shown on their own.
/// </summary>
public static class GrossProfit
{
    private sealed class Line
    {
        public Guid OrderId { get; set; }
        public string InvoiceNo { get; set; } = "";
        public DateOnly BusinessDate { get; set; }
        public string BranchCode { get; set; } = "";
        public string BranchName { get; set; } = "";
        public string? Location { get; set; }
        public string Name { get; set; } = "";
        public string? Category { get; set; }
        public decimal Qty { get; set; }
        public decimal Sales { get; set; }
        public string Modifiers { get; set; } = "[]";
        public string? Code { get; set; }
        public bool IsCombo { get; set; }
    }

    private sealed record FactsLine(string DocNo, int SrNo, string? Code, decimal Cost, bool HasCost);

    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/reports/gross-profit", async (HttpContext http, Db db, FactsSync facts, DateOnly from, DateOnly to, string? branches) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("facts.post");
            var (f, t) = from <= to ? (from, to) : (to, from);
            if (t.DayNumber - f.DayNumber > 366) throw new DomainException("Choose at most a year.");
            var (lines, combo, refunds) = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var ids = branches == "all"
                    ? (await c.QueryAsync<Guid>("""
                        select b.id from branch b where @admin or exists (select 1 from user_branch ub where ub.branch_id = b.id and ub.user_id = @u)
                        """, new { admin = scope.IsAdmin, u = scope.UserId }, tx)).ToArray()
                    : [scope.Branch];
                // Every line FACTS gets (not voided, in the order the invoice sends them), at its sales before VAT (after its discount).
                var lines = (await c.QueryAsync<Line>("""
                    select o.id as order_id, o.invoice_no, o.business_date, b.code as branch_code, b.name as branch_name, b.erp_location_code as location,
                           l.name, cat.name as category, l.qty, l.line_total - l.discount - case when o.prices_include_vat then l.vat else 0 end as sales,
                           l.modifiers::text as modifiers, i.erp_item_code as code, coalesce(i.is_combo, false) as is_combo
                    from pos_order o join branch b on b.id = o.branch_id join order_line l on l.order_id = o.id
                    left join menu_item i on i.id = l.item_id left join menu_category cat on cat.id = i.category_id
                    where o.branch_id = any(@ids) and o.business_date between @f and @t and o.status in ('paid','refunded') and o.invoice_no is not null and not l.is_void
                    order by o.id, l.sort
                    """, new { ids, f, t }, tx)).ToList();
                var combo = await FactsPosting.ComboItemsAsync(c, tx, lines.Where(l => l.IsCombo).Select(l => l.Modifiers));
                var refunds = await c.QuerySingleAsync<(int Count, decimal Amount)>("""
                    select count(*)::int, coalesce(sum(total - vat), 0) from credit_note where branch_id = any(@ids) and business_date between @f and @t
                    """, new { ids, f, t }, tx);
                return (lines, combo, refunds);
            });

            // FACTS: each POS51 line of these days at these locations, with qty × its batch's landed cost (none without a batch).
            var locations = lines.Select(l => l.Location).OfType<string>().Distinct().ToArray();
            var inFacts = new Dictionary<string, Dictionary<int, FactsLine>>();
            if (locations.Length > 0)
            {
                await using var fc = await facts.OpenAsync(scope.CompanyId);
                var rows = await fc.QueryAsync<FactsLine>("""
                    select ltrim(rtrim(h.SAL_DOCNO)) as DocNo, isnull(s.STTRN_DOCSRNO, 0) as SrNo, ltrim(rtrim(max(s.STTRN_STOCK_DOCNO))) as Code,
                           isnull(sum(-s.STTRN_QTY * bm.Rate), 0) as Cost,
                           cast(case when count(s.STTRN_DOCSRNO) > 0 and count(bm.Rate) = count(s.STTRN_DOCSRNO) then 1 else 0 end as bit) as HasCost
                    from SALES_HEADER h
                    left join STOCK_TRANSACTION s on s.STTRN_DOCTYPE = h.SAL_DOCTYPE and s.STTRN_DOCNO = h.SAL_DOCNO and s.STTRN_DOCDATE = h.SAL_DOCDATE
                    outer apply (select top 1 b.BATMST_LANDED_COST_RATE as Rate from STOCK_BATCH_MASTER b
                                 where b.BATMST_DOCNO = s.STTRN_BATCH_DOCNO and b.BATMST_STOCK_DOCNO = s.STTRN_STOCK_DOCNO) bm
                    where h.SAL_DOCTYPE = 'POS51' and h.SAL_LOCATION_DOCNO in @locations and h.SAL_DOCDATE between @f and @t
                    group by ltrim(rtrim(h.SAL_DOCNO)), s.STTRN_DOCSRNO
                    """, new { locations, f = f.ToDateTime(TimeOnly.MinValue), t = t.ToDateTime(TimeOnly.MinValue) }, commandTimeout: 120);
                foreach (var r in rows)
                {
                    if (!inFacts.TryGetValue(r.DocNo, out var doc)) inFacts[r.DocNo] = doc = [];
                    if (r.SrNo > 0) doc[r.SrNo] = r;
                }
            }

            // Each bill line against its FACTS lines (a combo is one FACTS line per chosen item), checked item by item.
            var costed = new List<(Line L, decimal Cost)>();
            decimal pendingSales = 0, noCostSales = 0;
            int pendingBills = 0, noCostLines = 0;
            foreach (var bill in lines.GroupBy(l => l.OrderId))
            {
                var first = bill.First();
                if (FactsPosting.FactsNo(first.InvoiceNo, null) is not { } no || !inFacts.TryGetValue(no, out var doc))
                {
                    pendingBills++;
                    pendingSales += bill.Sum(l => l.Sales);
                    continue;
                }
                var sr = 1;
                foreach (var l in bill)
                {
                    var codes = FactsPosting.PartCodes(l.IsCombo, l.Modifiers, l.Code, combo);
                    var parts = codes.Select((code, k) => doc.TryGetValue(sr + k, out var x) && x.HasCost && string.Equals(x.Code, code?.Trim(), StringComparison.OrdinalIgnoreCase) ? x : null).ToList();
                    sr += codes.Count;
                    if (parts.All(p => p is not null)) costed.Add((l, parts.Sum(p => p!.Cost)));
                    else if (l.Qty > 0) { noCostLines++; noCostSales += l.Sales; }
                }
            }

            static object Row(decimal sales, decimal cost) => new { sales = Money.Round(sales), cost = Money.Round(cost), profit = Money.Round(sales) - Money.Round(cost) };
            var items = costed.GroupBy(x => (x.L.Name, Category: x.L.Category ?? "Other"))
                .Select(g => new { name = g.Key.Name, category = g.Key.Category, qty = g.Sum(x => x.L.Qty), s = g.Sum(x => x.L.Sales), c = g.Sum(x => x.Cost) }).ToList();
            var sales = costed.Sum(x => x.L.Sales);
            var cost = costed.Sum(x => x.Cost);
            return Results.Ok(new
            {
                from = f, to = t,
                summary = new { sales = Money.Round(sales), cost = Money.Round(cost), profit = Money.Round(sales) - Money.Round(cost), pct = sales > 0 ? decimal.Round((sales - cost) / sales * 100, 1, MidpointRounding.AwayFromZero) : (decimal?)null },
                byItem = items.OrderByDescending(x => x.s - x.c).Select(x => new { x.name, x.category, x.qty, total = Row(x.s, x.c) }),
                byCategory = items.GroupBy(x => x.category).Select(g => new { category = g.Key, qty = g.Sum(x => x.qty), s = g.Sum(x => x.s), c = g.Sum(x => x.c) })
                    .OrderByDescending(x => x.s - x.c).Select(x => new { x.category, x.qty, total = Row(x.s, x.c) }),
                byDay = costed.GroupBy(x => x.L.BusinessDate).OrderBy(g => g.Key).Select(g => new { day = g.Key, total = Row(g.Sum(x => x.L.Sales), g.Sum(x => x.Cost)) }),
                byBranch = costed.GroupBy(x => (x.L.BranchCode, x.L.BranchName)).Select(g => new { code = g.Key.BranchCode, name = g.Key.BranchName, s = g.Sum(x => x.L.Sales), c = g.Sum(x => x.Cost) })
                    .OrderByDescending(x => x.s - x.c).Select(x => new { x.code, x.name, total = Row(x.s, x.c) }),
                pending = new { bills = pendingBills, sales = Money.Round(pendingSales) },
                noCost = new { lines = noCostLines, sales = Money.Round(noCostSales) },
                refunds = new { refunds.Count, amount = Money.Round(refunds.Amount) },
            });
        });
    }
}
