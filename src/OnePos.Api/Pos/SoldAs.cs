using Dapper;
using Npgsql;

namespace OnePos.Api.Pos;

/// <summary>
/// "Sold as" (migration 0093): the FACTS unit an item is sold in. FACTS keeps Sprite in LTR and the till sells it by the can
/// (PCS, 1 = 0.33 LTR): bills, returns and wastage go to FACTS in PCS and FACTS converts to LTR by its own STOCK_UNIT. The item's
/// erp_unit is that unit, unit_per how much of the stock unit one of it is, and FACTS stock read into One POS is counted in it.
/// </summary>
public static class SoldAs
{
    /// <summary>One FACTS unit of an item: its stock unit (PerUnit 1) or a conversion.</summary>
    public sealed class Unit
    {
        public Guid ItemId { get; set; }
        public string Name { get; set; } = "";
        public decimal PerUnit { get; set; }
        public int Decimals { get; set; }
    }

    /// <summary>
    /// Sets each FACTS item's unit (all of them, or just these): made from a live FACTS BOM, the BOM's unit; else the one chosen on
    /// the item (Menu → Sold as) where FACTS still has it; else the stock unit. Nothing is picked by itself. Stock already read is
    /// turned into the new unit. Returns how many items changed unit.
    /// </summary>
    public static async Task<int> ApplyAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid[]? ids = null)
    {
        return await c.ExecuteScalarAsync<int>("""
            with pick as (
              select i.id, i.unit_per as old_per, u.unit, u.per_unit, u.decimals
              from menu_item i
              left join lateral (select b.unit from bom b where b.item_code = i.erp_item_code and b.item_type = i.erp_item_type
                                   and (b.ended_from is null or b.ended_from > current_date) limit 1) bom on true
              cross join lateral (
                select u.unit, u.per_unit, u.decimals from item_unit u where u.item_id = i.id
                order by case when bom.unit is null and upper(u.unit) = upper(i.sale_unit) then 0
                              when upper(u.unit) = upper(bom.unit) then 1
                              when upper(u.unit) = upper(i.erp_stock_unit) then 2 else 3 end, u.unit
                limit 1) u
              where i.erp_item_code is not null and (cast(@ids as uuid[]) is null or i.id = any(@ids))
            ), changed as (
              update menu_item i set erp_unit = p.unit, unit_per = p.per_unit, qty_decimals = p.decimals
              from pick p where p.id = i.id and (i.erp_unit is distinct from p.unit or i.unit_per <> p.per_unit or i.qty_decimals <> p.decimals)
              returning i.id, p.old_per, p.per_unit
            ), restock as (
              update branch_item bi set erp_stock = round(bi.erp_stock * ch.old_per / ch.per_unit, 3),
                                        erp_in_since_waste = round(bi.erp_in_since_waste * ch.old_per / ch.per_unit, 3)
              from changed ch where bi.item_id = ch.id and ch.old_per <> ch.per_unit
            )
            select count(*)::int from changed
            """, new { ids }, tx);
    }

    /// <summary>Every item's FACTS units, its stock unit first, then the smallest.</summary>
    public static async Task<ILookup<Guid, Unit>> LoadAsync(NpgsqlConnection c, NpgsqlTransaction tx) =>
        (await c.QueryAsync<Unit>("""
            select u.item_id, u.unit as name, u.per_unit, u.decimals from item_unit u join menu_item i on i.id = u.item_id
            order by u.item_id, upper(u.unit) = upper(coalesce(i.erp_stock_unit, '')) desc, u.per_unit, u.unit
            """, transaction: tx)).ToLookup(u => u.ItemId);
}
