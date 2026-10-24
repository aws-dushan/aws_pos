using Dapper;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Paper fallback (REQ ONL-04). During an outage the branch writes orders on pre-printed pads (slip number, items, total, how it
/// was paid). Back online, a manager keys each slip in: it becomes a paid order of the open business day with its own tax invoice
/// number and VAT, marked as from paper with the slip number and the time written on it. Nothing goes to the kitchen (it was
/// already made) and no shift counts it (the cash is counted with the day).
/// </summary>
public static class Paper
{
    public sealed record PaperLine(Guid ItemId, decimal Qty, decimal? UnitPrice);
    public sealed record PaperPayment(string Method, decimal Amount, string? Reference);
    public sealed record PaperBody(string SlipNo, DateTime At, string? Type, string? CustomerName, string? Note, PaperLine[] Lines, PaperPayment[] Payments, decimal? DiscountPct);

    private static readonly string[] Methods = ["cash", "card", "other"];

    public static void Map(RouteGroupBuilder api)
    {
        api.MapPost("/orders/paper", async (PaperBody body, HttpContext http, Db db, Live live) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("day.manage");
            var branchId = scope.Branch;
            var slip = (body.SlipNo ?? "").Trim();
            if (slip.Length is 0 or > 30) throw new DomainException("Enter the slip number written on the paper.");
            if (body.At > DateTime.UtcNow.AddMinutes(5) || body.At < DateTime.UtcNow.AddDays(-7)) throw new DomainException("The time on the slip must be within the last 7 days.");
            var type = (body.Type ?? "takeaway").Trim().ToLowerInvariant() is var t && t is "dine_in" or "takeaway" or "delivery" ? t : throw new DomainException("Choose dine-in, takeaway or delivery.");
            var lines = (body.Lines ?? []).ToList();
            if (lines.Count == 0) throw new DomainException("Add what was sold.");
            var pays = (body.Payments ?? []).Where(p => p.Amount > 0).ToList();
            if (pays.Count == 0) throw new DomainException("Enter how it was paid.");
            if (pays.Any(p => !Methods.Contains((p.Method ?? "").Trim().ToLowerInvariant()))) throw new DomainException("Paper sales are paid by cash, card or other.");
            var pct = body.DiscountPct ?? 0;
            if (pct is < 0 or > 100) throw new DomainException("A discount is between 0 and 100 %.");

            var detail = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var day = await Days.CurrentAsync(c, tx, branchId, scope.UserId);
                var br = await c.QuerySingleAsync<(bool TableService, decimal ServiceChargePct)>("select table_service, service_charge_pct from branch where id = @branchId", new { branchId }, tx);
                if (type == "dine_in" && !br.TableService) throw new DomainException("This branch has no table service.");
                var co = await c.QuerySingleAsync<(decimal VatRate, bool PricesIncludeVat)>("select vat_rate, prices_include_vat from company where id = @id", new { id = scope.CompanyId }, tx);
                var number = await c.ExecuteScalarAsync<int>("""
                    insert into number_series (company_id, branch_id, series, next_no) values (@co, @branchId, @series, 2)
                    on conflict (branch_id, series) do update set next_no = number_series.next_no + 1 returning next_no - 1
                    """, new { co = scope.CompanyId, branchId, series = $"order:{day.Date:yyyy-MM-dd}" }, tx);
                var id = await c.ExecuteScalarAsync<Guid>("""
                    insert into pos_order (company_id, branch_id, business_date, number, order_type, customer_name, note, vat_rate, prices_include_vat, service_pct,
                                           discount_pct, opened_by, opened_at, source, paper_ref, paper_at)
                    values (@co, @branchId, @date, @number, @type, @name, @note, @vatRate, @incl, @svc, @pct, @userId, @at, 'paper', @slip, @at) returning id
                    """, new
                    {
                        co = scope.CompanyId, branchId, date = day.Date, number, type, name = Opt(body.CustomerName), note = Opt(body.Note), vatRate = co.VatRate, incl = co.PricesIncludeVat,
                        svc = type == "dine_in" ? br.ServiceChargePct : 0, pct, userId = scope.UserId, at = body.At.ToUniversalTime(), slip,
                    }, tx);
                var sort = 0;
                foreach (var l in lines)
                {
                    var item = await c.QuerySingleOrDefaultAsync<(Guid Id, string Name, decimal Price, decimal? BranchPrice, bool NeedsPrice, int Decimals, string Station, string? NameAr)>("""
                        select i.id, i.name, i.price, bi.price, i.needs_price or coalesce(bi.erp_priced, false), i.qty_decimals, i.station, i.name_ar from menu_item i
                        left join branch_item bi on bi.item_id = i.id and bi.branch_id = @branchId where i.id = @ItemId
                        """, new { branchId, l.ItemId }, tx) ;
                    if (item.Id == Guid.Empty) throw new DomainException("An item on the slip isn't on the menu.");
                    Orders.CheckQty(l.Qty, item.Decimals, item.Name);
                    // The price on the menu; an item without one takes the price written on the slip.
                    var unit = item.NeedsPrice && item.BranchPrice is null
                        ? l.UnitPrice is > 0 ? Money.Round(l.UnitPrice.Value) : throw new DomainException($"{item.Name} has no price yet: enter the price written on the slip.")
                        : item.BranchPrice ?? item.Price;
                    await c.ExecuteAsync("""
                        insert into order_line (company_id, order_id, item_id, name, name_ar, unit_price, qty, modifiers, station, sent_qty, sort, added_by)
                        values (@co, @id, @itemId, @name, @nameAr, @unit, @qty, '[]'::jsonb, @station, @qty, @sort, @userId)
                        """, new { co = scope.CompanyId, id, itemId = item.Id, name = item.Name, nameAr = item.NameAr, unit, qty = l.Qty, station = item.Station, sort = ++sort, userId = scope.UserId }, tx);
                }
                await Orders.RecalcAsync(c, tx, id);
                var o = await c.QuerySingleAsync<Orders.OrderRow>("select * from pos_order where id = @id", new { id }, tx);
                var paid = pays.Sum(p => Money.Round(p.Amount));
                if (paid != o.Total) throw new DomainException($"The payments ({paid:N2}) must equal the slip's total ({o.Total:N2}).");
                foreach (var p in pays)
                    await c.ExecuteAsync("""
                        insert into payment (company_id, branch_id, order_id, business_date, method, amount, tendered, change_given, reference, taken_by)
                        values (@co, @branchId, @id, @date, @method, @amount, @amount, 0, @reference, @userId)
                        """, new { co = scope.CompanyId, branchId, id, date = day.Date, method = p.Method.Trim().ToLowerInvariant(), amount = Money.Round(p.Amount), reference = Opt(p.Reference), userId = scope.UserId }, tx);
                await c.ExecuteAsync("update pos_order set paid = @paid, status = 'paid', closed_at = @at where id = @id", new { id, paid, at = body.At.ToUniversalTime() }, tx);
                await Returns.AssignInvoiceAsync(c, tx, o);
                await Recipes.ConsumeAsync(c, tx, id, scope.UserId);
                await Boms.EnqueueBillRepackingAsync(c, tx, id);
                await Erp.FactsPosting.EnqueueInvoiceAsync(c, tx, id);
                await Audit.RecordAsync(c, tx, scope.CompanyId, branchId, scope.UserId, "order", id.ToString(), "paper", $"Paper slip {slip} entered as order #{number} ({o.Total:N2})");
                return await Orders.DetailAsync(c, tx, id);
            });
            await live.ToBranch(branchId, "order.changed", new { id = detail.Order.Id });
            return Results.Ok(detail);
        });

        // The paper slips entered for this branch (newest first), to see what's done.
        api.MapGet("/orders/paper", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("day.manage");
            return await db.Company(scope.CompanyId, (c, tx) => c.QueryAsync<(Guid Id, int Number, string PaperRef, DateTime PaperAt, DateOnly BusinessDate, decimal Total, string? InvoiceNo, string Status)>("""
                select id, number, paper_ref, paper_at, business_date, total, invoice_no, status from pos_order
                where branch_id = @b and source = 'paper' order by opened_at desc limit 100
                """, new { b = scope.Branch }, tx)
                .ContinueWith(r => r.Result.Select(x => new { x.Id, x.Number, slipNo = x.PaperRef, at = x.PaperAt, x.BusinessDate, x.Total, x.InvoiceNo, x.Status })));
        });
    }

    private static string? Opt(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
}
