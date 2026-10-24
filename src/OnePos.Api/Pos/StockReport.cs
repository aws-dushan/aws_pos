using Dapper;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Stock report for this branch: every item on sale with its stock now (as the register counts it: FACTS stock less what was sold
/// and thrown away since FACTS was read), the outlet price and each FACTS-linked delivery platform's price (null = none in FACTS,
/// so it can't be sold there). Anyone who can see reports can see it, supervisors included.
/// </summary>
public static class StockReport
{
    public sealed class Row
    {
        public Guid Id { get; set; }
        public string? Code { get; set; }
        public string Name { get; set; } = "";
        public string Category { get; set; } = "";
        public bool FactsItem { get; set; }
        public bool MadeToOrder { get; set; }
        public decimal? Stock { get; set; }
        public DateTime? StockAt { get; set; }
        public decimal? Price { get; set; }
        public Dictionary<string, decimal?> Platforms { get; set; } = [];
    }

    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/reports/stock", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("reports.view");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var branchId = scope.Branch;
                var today = await Days.DateAsync(c, tx, branchId);
                var rows = (await c.QueryAsync<Row>("""
                    with sold as (
                      select l.item_id, po.closed_at, l.qty from pos_order po join order_line l on l.order_id = po.id
                      where po.branch_id = @branchId and po.status in ('paid','refunded') and not l.is_void
                        and po.closed_at > greatest((select min(erp_stock_at) from branch_item where branch_id = @branchId and erp_stock is not null), now() - interval '1 day'))
                    select i.id, i.erp_item_code as code, i.name, cat.name as category, i.erp_item_code is not null as facts_item,
                           coalesce(mto.yes, false) as made_to_order,
                           -- The same stock left as the register shows (Menu.LoadAsync).
                           case when bi.erp_stock is null or mto.yes then null else
                             bi.erp_stock - coalesce((select sum(s.qty) from sold s where s.item_id = i.id and s.closed_at > bi.erp_stock_at), 0)
                                          - coalesce((select sum(w.qty) from wastage w where w.item_id = i.id and w.branch_id = @branchId and w.voided_at is null
                                                        and w.erp_status <> 'none' and (w.erp_status <> 'posted' or w.erp_matched_at > bi.erp_stock_at)), 0)
                                          - coalesce((select sum(r.qty) from stock_return r where r.item_code = i.erp_item_code and r.branch_id = @branchId and r.approval in ('waiting','approved')
                                                        and (r.erp_status <> 'posted' or r.erp_posted_at > bi.erp_stock_at)), 0) end as stock,
                           bi.erp_stock_at as stock_at,
                           -- A FACTS-priced item has only FACTS' price here (none = can't be sold); others fall back to the company price.
                           case when coalesce(bi.erp_priced, false) then bi.price else coalesce(bi.price, i.price) end as price
                    from menu_item i
                    join menu_category cat on cat.id = i.category_id
                    left join branch_item bi on bi.item_id = i.id and bi.branch_id = @branchId
                    left join lateral (select true as yes from bom b join bom_version v on v.bom_id = b.id and v.valid_from <= @today
                                       where b.item_code = i.erp_item_code and b.item_type = i.erp_item_type
                                         and (b.ended_from is null or b.ended_from > @today) limit 1) mto on true
                    where i.is_active and cat.is_active and coalesce(bi.is_sold, i.erp_item_code is null)
                    order by cat.sort, cat.name, i.sort, i.name
                    """, new { branchId, today }, tx)).ToList();

                // FACTS-linked platforms and their prices, VAT as the branch's FACTS prices are (PlatformPrices.ForMenuAsync).
                var vat = await c.QuerySingleAsync<(bool InclVat, decimal Rate)>(
                    "select b.facts_prices_include_vat, co.vat_rate from branch b join company co on co.id = b.company_id where b.id = @branchId", new { branchId }, tx);
                var platforms = (await c.QueryAsync<(Guid Id, string Name)>(
                    "select id, name from delivery_platform where facts_customer is not null and is_active order by sort, name", transaction: tx)).ToList();
                var prices = (await c.QueryAsync<(Guid PlatformId, Guid ItemId, decimal FactsPrice)>("""
                    select pp.platform_id, pp.item_id, pp.facts_price from platform_item_price pp join delivery_platform dp on dp.id = pp.platform_id
                    where dp.facts_customer is not null and dp.is_active
                    """, transaction: tx)).ToDictionary(p => (p.PlatformId, p.ItemId), p => Money.Round(vat.InclVat ? p.FactsPrice : p.FactsPrice * (1 + vat.Rate / 100m)));
                foreach (var r in rows)
                    foreach (var p in platforms)
                        // Items without a FACTS code sell at the outlet's price on every platform.
                        r.Platforms[p.Id.ToString()] = r.FactsItem ? (prices.TryGetValue((p.Id, r.Id), out var x) ? x : null) : r.Price;

                return new { platforms = platforms.Select(p => new { id = p.Id, name = p.Name }).ToList(), items = rows };
            });
        });
    }
}
