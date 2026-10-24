using Dapper;
using Npgsql;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Delivery platform prices: a platform linked to its FACTS customer sells FACTS items at that customer's FACTS prices (read by the
/// price sync into platform_item_price), VAT added where the branch's FACTS prices are before VAT. An item without a price there
/// can't be sold on that platform. Items without a FACTS code, and unlinked platforms, keep the outlet's prices.
/// </summary>
public static class PlatformPrices
{
    private sealed record Row(string Platform, bool Linked, bool FactsItem, decimal? FactsPrice, bool InclVat, decimal VatRate);

    /// <summary>The item's price on the platform: Applies = the platform's FACTS prices decide (Price null = none there).</summary>
    public static async Task<(bool Applies, decimal? Price, string Platform)> ForAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid branchId, Guid? platformId, Guid itemId)
    {
        if (platformId is null) return (false, null, "");
        var r = await c.QuerySingleOrDefaultAsync<Row>("""
            select dp.name as Platform, dp.facts_customer is not null as Linked, i.erp_item_code is not null as FactsItem, pp.facts_price as FactsPrice,
                   b.facts_prices_include_vat as InclVat, co.vat_rate as VatRate
            from delivery_platform dp join menu_item i on i.id = @itemId join branch b on b.id = @branchId join company co on co.id = b.company_id
            left join platform_item_price pp on pp.platform_id = dp.id and pp.item_id = i.id
            where dp.id = @platformId
            """, new { branchId, platformId, itemId }, tx);
        if (r is null || !r.Linked || !r.FactsItem) return (false, null, r?.Platform ?? "");
        return (true, r.FactsPrice is { } p ? Money.Round(r.InclVat ? p : p * (1 + r.VatRate / 100m)) : null, r.Platform);
    }

    /// <summary>
    /// The bill's platform changed (or it stopped being a platform order): its open lines take the new prices (item plus options),
    /// the platform's or the outlet's. Refused, naming them, when an item has no price there.
    /// </summary>
    public static async Task RepriceAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid orderId, Guid branchId, Guid? platformId)
    {
        var lines = (await c.QueryAsync<(Guid Id, Guid ItemId, string Name, decimal Unit, decimal Mods, decimal? BranchPrice, decimal Price, bool ErpPriced)>("""
            select l.id, l.item_id, l.name, l.unit_price,
                   coalesce((select sum((m->>'price')::numeric) from jsonb_array_elements(l.modifiers) m), 0),
                   bi.price, i.price, coalesce(bi.erp_priced, false)
            from order_line l join menu_item i on i.id = l.item_id left join branch_item bi on bi.item_id = i.id and bi.branch_id = @branchId
            where l.order_id = @orderId and not l.is_void
            """, new { orderId, branchId }, tx)).ToList();
        var missing = new List<string>();
        var platformName = "";
        foreach (var l in lines)
        {
            var (applies, price, name) = await ForAsync(c, tx, branchId, platformId, l.ItemId);
            if (name.Length > 0) platformName = name;
            decimal? baseprice = applies ? price : l.ErpPriced ? l.BranchPrice : l.BranchPrice ?? l.Price;
            if (baseprice is null) { missing.Add(l.Name); continue; }
            var unit = Money.Round(baseprice.Value + l.Mods);
            if (unit != l.Unit) await c.ExecuteAsync("update order_line set unit_price = @unit where id = @Id", new { unit, l.Id }, tx);
        }
        if (missing.Count > 0)
            throw new DomainException(platformId is not null && platformName.Length > 0
                ? $"No {platformName} price in FACTS for: {string.Join(", ", missing.Distinct())}. Take them off first, or keep the bill as it was."
                : $"No outlet price for: {string.Join(", ", missing.Distinct())}.");
    }

    /// <summary>For the register: each FACTS-linked platform's prices here (item → price, VAT as the branch's FACTS prices are).</summary>
    public static async Task<object> ForMenuAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid? branchId)
    {
        if (branchId is null) return Array.Empty<object>();
        var vat = await c.QuerySingleAsync<(bool InclVat, decimal Rate)>(
            "select b.facts_prices_include_vat, co.vat_rate from branch b join company co on co.id = b.company_id where b.id = @branchId", new { branchId }, tx);
        var rows = (await c.QueryAsync<(Guid PlatformId, Guid? ItemId, decimal? FactsPrice)>("""
            select dp.id, pp.item_id, pp.facts_price from delivery_platform dp left join platform_item_price pp on pp.platform_id = dp.id
            where dp.facts_customer is not null and dp.is_active
            """, transaction: tx)).ToList();
        return rows.GroupBy(r => r.PlatformId).Select(g => new
        {
            platformId = g.Key,
            prices = g.Where(r => r.ItemId is not null).ToDictionary(r => r.ItemId!.Value.ToString(),
                r => Money.Round(vat.InclVat ? r.FactsPrice!.Value : r.FactsPrice!.Value * (1 + vat.Rate / 100m))),
        }).ToList();
    }
}
