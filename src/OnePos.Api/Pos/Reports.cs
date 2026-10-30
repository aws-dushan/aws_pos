using System.Text.Json;
using Dapper;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Sales reports (REQ RPT-02 … RPT-06) for a range of business days, one branch or every branch the user works in: the summary,
/// by day, by hour, by item and category, by payment method and by cashier. Sales are paid orders net of their credit notes
/// (an item's net is its line share less what came back). Money by method and by cashier counts the day it changed hands.
/// </summary>
public static class Reports
{
    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/reports/sales", async (HttpContext http, Db db, DateOnly? from, DateOnly? to, string? branches) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("reports.view");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var today = scope.BranchId is { } bid ? await Days.DateAsync(c, tx, bid) : DateOnly.FromDateTime(DateTime.UtcNow);
                var t = to ?? today;
                var f = from ?? t;
                if (f > t) (f, t) = (t, f);
                if (t.DayNumber - f.DayNumber > 366) throw new DomainException("Choose at most a year.");
                // This branch, or every branch of the company this user works in.
                var ids = branches == "all"
                    ? (await c.QueryAsync<Guid>("""
                        select b.id from branch b where @admin or exists (select 1 from user_branch ub where ub.branch_id = b.id and ub.user_id = @u)
                        """, new { admin = scope.IsAdmin, u = scope.UserId }, tx)).ToArray()
                    : [scope.Branch];
                var tz = scope.BranchId is { } b0 ? await c.ExecuteScalarAsync<string>("select time_zone from branch where id = @b0", new { b0 }, tx) ?? "Asia/Dubai" : "Asia/Dubai";
                var args = new { ids, f, t, tz };

                var summary = await c.QuerySingleAsync<(int Orders, decimal Gross, decimal Vat, decimal Discounts, decimal Service, int Guests, decimal Refunded)>("""
                    select count(*)::int, coalesce(sum(total), 0), coalesce(sum(vat), 0), coalesce(sum(discount_total), 0), coalesce(sum(service_charge), 0),
                           coalesce(sum(guests), 0)::int, coalesce(sum(refunded), 0)
                    from pos_order where branch_id = any(@ids) and business_date between @f and @t and status in ('paid','refunded')
                    """, args, tx);
                var notes = await c.QuerySingleAsync<(int Count, decimal Total, decimal Vat, decimal AmountOnly)>("""
                    select count(*)::int, coalesce(sum(total), 0), coalesce(sum(vat), 0), coalesce(sum(total) filter (where kind = 'amount'), 0)
                    from credit_note where branch_id = any(@ids) and business_date between @f and @t
                    """, args, tx);
                var voids = await c.QuerySingleAsync<(int Count, decimal Value)>("""
                    select count(*)::int, coalesce(sum(total), 0) from pos_order where branch_id = any(@ids) and business_date between @f and @t and status = 'void'
                    """, args, tx);
                var byDay = await c.QueryAsync<(DateOnly Day, int Orders, decimal Sales, decimal Refunded)>("""
                    select business_date, count(*)::int, sum(total), sum(refunded) from pos_order
                    where branch_id = any(@ids) and business_date between @f and @t and status in ('paid','refunded') group by business_date order by business_date
                    """, args, tx);
                var byHour = await c.QueryAsync<(int Hour, int Orders, decimal Sales)>("""
                    select extract(hour from closed_at at time zone @tz)::int, count(*)::int, sum(total - refunded) from pos_order
                    where branch_id = any(@ids) and business_date between @f and @t and status in ('paid','refunded') group by 1 order by 1
                    """, args, tx);
                // Items: each line's share of what the order was paid (discounts and service charge spread), less what came back.
                // Finished days come summed per day (SalesSummary), so a year's report doesn't read every bill line.
                var byItem = await SalesSummary.ItemsAsync(c, tx, ids, f, t);
                var byMethod = await c.QueryAsync<(string Method, decimal Taken, decimal Refunded, int Count)>("""
                    select method, coalesce(sum(amount) filter (where kind = 'payment'), 0), coalesce(sum(amount) filter (where kind = 'refund'), 0), count(*) filter (where kind = 'payment')::int
                    from payment where branch_id = any(@ids) and business_date between @f and @t group by method order by 2 desc
                    """, args, tx);
                // Discounts: each item's discount under what gave it (its own when that was the bigger, else the bill's) and who gave it.
                var byDiscount = await c.QueryAsync<(string Name, string Kind, string By, int Bills, decimal Amount)>("""
                    with ln as (
                      select o.id as order_id, l.discount, l.disc_type, l.disc_name, l.disc_source, l.disc_by, o.discount_name, o.discount_source, o.discount_pct, o.discount_by,
                             case l.disc_type when 'pct' then round(l.line_total * least(l.disc_value, 100) / 100, 2)
                                              when 'amount' then least(l.line_total, round(l.disc_value * l.qty, 2))
                                              when 'price' then greatest(0, l.line_total - round(l.disc_value * l.qty, 2)) else 0 end as own
                      from order_line l join pos_order o on o.id = l.order_id
                      where o.branch_id = any(@ids) and o.business_date between @f and @t and o.status in ('paid','refunded') and not l.is_void and l.discount > 0),
                    w as (
                      select order_id, discount, disc_type is not null and own >= discount as mine, disc_name, disc_source, disc_by, discount_name, discount_source, discount_pct, discount_by from ln)
                    select case when mine then coalesce(disc_name, 'Item discount (typed)')
                                else coalesce(discount_name, case when discount_pct > 0 then 'Bill discount ' || trim(to_char(discount_pct, 'FM990.##')) || '%' else 'Bill discount (typed)' end) end as name,
                           case when mine then coalesce(disc_source, 'typed') else coalesce(discount_source, 'typed') end as kind,
                           coalesce(u.display_name, case when mine and disc_source = 'promotion' then 'Automatic' else '—' end) as by,
                           count(distinct order_id)::int, sum(discount)
                    from w left join app_user u on u.id = case when mine then disc_by else discount_by end
                    group by 1, 2, 3 order by 5 desc
                    """, args, tx);
                var byCashier = await c.QueryAsync<(string Name, int Payments, decimal Taken, decimal Refunded)>("""
                    select u.display_name, count(*) filter (where p.kind = 'payment')::int,
                           coalesce(sum(p.amount) filter (where p.kind = 'payment'), 0), coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0)
                    from payment p join app_user u on u.id = p.taken_by
                    where p.branch_id = any(@ids) and p.business_date between @f and @t group by u.display_name order by 3 desc
                    """, args, tx);
                var byType = await c.QueryAsync<(string Type, int Orders, decimal Sales)>("""
                    select order_type, count(*)::int, sum(total - refunded) from pos_order
                    where branch_id = any(@ids) and business_date between @f and @t and status in ('paid','refunded') group by order_type order by 3 desc
                    """, args, tx);
                var byBranch = await c.QueryAsync<(string Code, string Name, int Orders, decimal Sales)>("""
                    select b.code, b.name, count(o.branch_id)::int, coalesce(sum(o.total - o.refunded), 0) from branch b
                    left join pos_order o on o.branch_id = b.id and o.business_date between @f and @t and o.status in ('paid','refunded')
                    where b.id = any(@ids) group by b.code, b.name order by 4 desc
                    """, args, tx);

                var items = byItem.ToList();
                return new
                {
                    from = f, to = t, branches = ids.Length,
                    summary = new
                    {
                        summary.Orders, gross = summary.Gross, vat = summary.Vat - notes.Vat, net = summary.Gross - notes.Total, netOfVat = summary.Gross - notes.Total - (summary.Vat - notes.Vat),
                        summary.Discounts, serviceCharge = summary.Service, summary.Guests, refunds = notes.Total, creditNotes = notes.Count,
                        averageOrder = summary.Orders == 0 ? 0 : Money.Round((summary.Gross - notes.Total) / summary.Orders),
                        voids = new { voids.Count, voids.Value },
                    },
                    byDay = byDay.Select(x => new { day = x.Day, x.Orders, sales = x.Sales - x.Refunded }),
                    byHour = byHour.Select(x => new { x.Hour, x.Orders, x.Sales }),
                    // What comes off sales but off no item (refunds of an amount, rounding of full returns): its own line, so the items add up.
                    amountRefunds = (summary.Gross - notes.Total) - Money.Round(items.Sum(x => x.Sales)),
                    byItem = items.Select(x => new { x.Name, category = x.Category ?? "Other", x.Qty, sales = Money.Round(x.Sales) }),
                    byCategory = items.GroupBy(x => x.Category ?? "Other").Select(g => new { category = g.Key, qty = g.Sum(x => x.Qty), sales = Money.Round(g.Sum(x => x.Sales)) }).OrderByDescending(x => x.sales),
                    byMethod = byMethod.Select(x => new { x.Method, x.Taken, x.Refunded, net = x.Taken - x.Refunded, x.Count }),
                    byCashier = byCashier.Select(x => new { x.Name, x.Payments, x.Taken, x.Refunded, net = x.Taken - x.Refunded }),
                    byDiscount = byDiscount.Select(x => new { x.Name, x.Kind, x.By, x.Bills, amount = Money.Round(x.Amount) }),
                    byType = byType.Select(x => new { x.Type, x.Orders, x.Sales }),
                    byBranch = byBranch.Select(x => new { x.Code, x.Name, x.Orders, x.Sales }),
                };
            });
        });

        // Invoices: one row per paid, refunded or voided bill of the days that has an invoice number — its number, who and which till, the money, how it was
        // paid (card type, platform) and whether it reached FACTS (its latest invoice posting). finance=true (admin and finance only, the Finance
        // invoices report) adds the customer and each payment: its type and amount.
        api.MapGet("/reports/invoices", async (HttpContext http, Db db, DateOnly from, DateOnly to, string? branches, bool? finance) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("reports.view");
            var fin = finance == true;
            if (fin) scope.Require("facts.post");
            var (f, t) = from <= to ? (from, to) : (to, from);
            if (t.DayNumber - f.DayNumber > 366) throw new DomainException("Choose at most a year.");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var ids = branches == "all"
                    ? (await c.QueryAsync<Guid>("""
                        select b.id from branch b where @admin or exists (select 1 from user_branch ub where ub.branch_id = b.id and ub.user_id = @u)
                        """, new { admin = scope.IsAdmin, u = scope.UserId }, tx)).ToArray()
                    : [scope.Branch];
                var tz = scope.BranchId is { } b0 ? await c.ExecuteScalarAsync<string>("select time_zone from branch where id = @b0", new { b0 }, tx) ?? "Asia/Dubai" : "Asia/Dubai";
                var rows = await c.QueryAsync<Invoice>("""
                    select o.id, o.invoice_no, o.business_date, b.code as branch,
                           to_char(coalesce(o.closed_at, o.opened_at) at time zone @tz, 'YYYY-MM-DD"T"HH24:MI') as at,
                           o.order_type, dp.name as platform, o.platform_ref, o.status,
                           coalesce(cu.display_name, ou.display_name) as cashier, r.name as till,
                           (select coalesce(sum(l.qty), 0) from order_line l where l.order_id = o.id and not l.is_void) as items,
                           o.subtotal as gross, o.discount_total as discount, o.vat, o.total as net, o.refunded,
                           (select string_agg(case p.method when 'card' then coalesce(initcap(regexp_replace(p.card_type, '^\S+\s+', '')), 'Card') when 'platform' then coalesce(dp.name, 'Platform')
                                                             else initcap(p.method) end || ' ' || to_char(p.amount, 'FM999999990.00'), ' · ' order by p.at)
                              from payment p where p.order_id = o.id and p.kind = 'payment') as paid_by,
                           (select e.status from erp_post e where e.order_id = o.id and e.kind = 'invoice' order by e.created_at desc limit 1) as facts,
                           case when @fin then coalesce(nullif(trim(o.customer_name), ''), cs.name) end as customer
                    from pos_order o
                    join branch b on b.id = o.branch_id
                    left join customer cs on cs.id = o.customer_id
                    left join delivery_platform dp on dp.id = o.platform_id
                    left join register r on r.id = o.register_id
                    left join app_user ou on ou.id = o.opened_by
                    left join lateral (select u.display_name from payment p join app_user u on u.id = p.taken_by
                                       where p.order_id = o.id and p.kind = 'payment' order by p.at desc limit 1) cu on true
                    where o.branch_id = any(@ids) and o.business_date between @f and @t and o.status in ('paid', 'refunded', 'void') and o.invoice_no is not null
                    order by coalesce(o.closed_at, o.opened_at)
                    """, new { ids, f, t, tz, fin }, tx);
                if (!fin) return new { invoices = rows, payments = (IEnumerable<InvoicePayment>?)null };
                // Each payment of those bills, named as in Paid by.
                var pays = await c.QueryAsync<InvoicePayment>("""
                    select p.order_id, case p.method when 'card' then coalesce(initcap(regexp_replace(p.card_type, '^\S+\s+', '')), 'Card') when 'platform' then coalesce(dp.name, 'Platform')
                                                      else initcap(p.method) end as type, p.amount
                    from payment p join pos_order o on o.id = p.order_id
                    left join delivery_platform dp on dp.id = o.platform_id
                    where o.branch_id = any(@ids) and o.business_date between @f and @t and o.status in ('paid', 'refunded', 'void') and o.invoice_no is not null
                      and p.kind = 'payment'
                    order by p.at
                    """, new { ids, f, t }, tx);
                return new { invoices = rows, payments = pays };
            });
        });

        // Returns: every credit note of the days — a returned bill (the Return button) or an older refund of items or an amount — who did
        // it and why, the bill, the money back and how, and its FACTS document (PSR51) where it went there.
        api.MapGet("/reports/returns", async (HttpContext http, Db db, DateOnly from, DateOnly to, string? branches) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("reports.view");
            var (f, t) = from <= to ? (from, to) : (to, from);
            if (t.DayNumber - f.DayNumber > 366) throw new DomainException("Choose at most a year.");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var ids = branches == "all"
                    ? (await c.QueryAsync<Guid>("""
                        select b.id from branch b where @admin or exists (select 1 from user_branch ub where ub.branch_id = b.id and ub.user_id = @u)
                        """, new { admin = scope.IsAdmin, u = scope.UserId }, tx)).ToArray()
                    : [scope.Branch];
                var tz = scope.BranchId is { } b0 ? await c.ExecuteScalarAsync<string>("select time_zone from branch where id = @b0", new { b0 }, tx) ?? "Asia/Dubai" : "Asia/Dubai";
                return new
                {
                    returns = await c.QueryAsync<ReturnRow>("""
                        select n.id, n.order_id, n.number, o.invoice_no, n.business_date, b.code as branch, n.kind, n.reason, n.total, n.vat,
                               to_char(n.created_at at time zone @tz, 'YYYY-MM-DD"T"HH24:MI') as at, u.display_name as cashier, r.name as till,
                               o.total as bill_total, to_char(o.closed_at at time zone @tz, 'YYYY-MM-DD"T"HH24:MI') as bill_at,
                               (select string_agg(case p.method when 'card' then coalesce(initcap(regexp_replace(p.card_type, '^\S+\s+', '')), 'Card') when 'platform' then 'Platform'
                                                                 else initcap(p.method) end || ' ' || to_char(p.amount, 'FM999999990.00'), ' · ' order by p.at)
                                  from payment p where p.credit_note_id = n.id) as back_by,
                               e.status as facts, e.facts_doc, e.last_error as facts_error
                        from credit_note n
                        join pos_order o on o.id = n.order_id
                        join branch b on b.id = n.branch_id
                        left join app_user u on u.id = n.created_by
                        left join register r on r.id = n.register_id
                        left join erp_post e on e.credit_note_id = n.id and e.kind = 'refund'
                        where n.branch_id = any(@ids) and n.business_date between @f and @t
                        order by n.created_at
                        """, new { ids, f, t, tz }, tx),
                };
            });
        });

        // Summary (admin and finance): the days in one report, section by section — sales, money collected, VAT by rate, gross to net,
        // cancelled bills, voided items, categories, each bill by cashier, discounts, and expenses (cash paid out, wastage, give-aways).
        api.MapGet("/reports/summary", async (HttpContext http, Db db, DateOnly from, DateOnly to, string? branches) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("facts.post");
            var (f, t) = from <= to ? (from, to) : (to, from);
            if (t.DayNumber - f.DayNumber > 366) throw new DomainException("Choose at most a year.");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var ids = branches == "all"
                    ? (await c.QueryAsync<Guid>("""
                        select b.id from branch b where @admin or exists (select 1 from user_branch ub where ub.branch_id = b.id and ub.user_id = @u)
                        """, new { admin = scope.IsAdmin, u = scope.UserId }, tx)).ToArray()
                    : [scope.Branch];
                var args = new { ids, f, t };
                var sales = await c.QuerySingleAsync<(int Orders, decimal Subtotal, decimal Discount, decimal Service, decimal Vat, decimal Total, bool VatIncluded)>("""
                    select count(*)::int, coalesce(sum(subtotal), 0), coalesce(sum(discount_total), 0), coalesce(sum(service_charge), 0), coalesce(sum(vat), 0),
                           coalesce(sum(total), 0), coalesce(bool_or(prices_include_vat), true)
                    from pos_order where branch_id = any(@ids) and business_date between @f and @t and status in ('paid','refunded')
                    """, args, tx);
                var notes = await c.QuerySingleAsync<(int Count, decimal Total)>("""
                    select count(*)::int, coalesce(sum(total), 0) from credit_note where branch_id = any(@ids) and business_date between @f and @t
                    """, args, tx);
                // Money by how it was paid (card type, platform), on the day it changed hands; refunds by how they were paid back.
                var collected = await c.QueryAsync<(string Label, string Kind, int Count, decimal Amount)>("""
                    select case p.method when 'card' then coalesce(initcap(regexp_replace(p.card_type, '^\S+\s+', '')), 'Card') when 'platform' then coalesce(dp.name, 'Platform')
                                         else initcap(p.method) end, p.kind, count(*)::int, sum(p.amount)
                    from payment p join pos_order o on o.id = p.order_id left join delivery_platform dp on dp.id = o.platform_id
                    where p.branch_id = any(@ids) and p.business_date between @f and @t group by 1, 2 order by 4 desc
                    """, args, tx);
                // VAT by rate: sales less what came back, the amount before VAT and the VAT.
                var tax = await c.QueryAsync<(decimal Rate, decimal Amount, decimal Vat)>("""
                    select rate, sum(amount), sum(vat) from (
                      select vat_rate as rate, total - vat as amount, vat from pos_order
                      where branch_id = any(@ids) and business_date between @f and @t and status in ('paid','refunded')
                      union all
                      select o.vat_rate, -(n.total - n.vat), -n.vat from credit_note n join pos_order o on o.id = n.order_id
                      where n.branch_id = any(@ids) and n.business_date between @f and @t) x
                    group by rate order by rate
                    """, args, tx);
                var cancelled = await c.QueryAsync<(string Bill, string Branch, decimal Amount, string? Reason, string? By)>("""
                    select coalesce(o.invoice_no, '#' || o.number), b.code, o.total, o.void_reason,
                           (select u.display_name from audit_log x join app_user u on u.id = x.user_id where x.entity = 'order' and x.entity_id = o.id::text and x.action = 'void' order by x.at desc limit 1)
                    from pos_order o join branch b on b.id = o.branch_id
                    where o.branch_id = any(@ids) and o.business_date between @f and @t and o.status = 'void' and o.number is not null
                    order by o.business_date, o.number
                    """, args, tx);
                var voided = await c.QueryAsync<(string? Code, string Name, decimal Qty, decimal Amount)>("""
                    select i.erp_item_code, l.name, sum(l.qty), sum(round(l.unit_price * l.qty, 2))
                    from order_line l join pos_order o on o.id = l.order_id left join menu_item i on i.id = l.item_id
                    where o.branch_id = any(@ids) and o.business_date between @f and @t and l.is_void
                    group by 1, 2 order by 4 desc
                    """, args, tx);
                var items = await SalesSummary.ItemsAsync(c, tx, ids, f, t);
                var bills = await c.QueryAsync<(string Cashier, string Bill, string Branch, decimal Amount)>("""
                    select coalesce((select u.display_name from payment p join app_user u on u.id = p.taken_by where p.order_id = o.id and p.kind = 'payment' order by p.at desc limit 1),
                                    ou.display_name), o.invoice_no, b.code, o.total - o.refunded
                    from pos_order o join branch b on b.id = o.branch_id join app_user ou on ou.id = o.opened_by
                    where o.branch_id = any(@ids) and o.business_date between @f and @t and o.status in ('paid','refunded') and o.invoice_no is not null
                    order by 1, coalesce(o.closed_at, o.opened_at)
                    """, args, tx);
                var discounts = await c.QueryAsync<(string Bill, string Branch, string? Reference, decimal Amount)>("""
                    select coalesce(o.invoice_no, '#' || o.number), b.code,
                           coalesce(o.discount_name, case when o.discount_pct > 0 then 'Bill ' || trim(to_char(o.discount_pct, 'FM990.##')) || '%' when o.discount_amount > 0 then 'Amount off the bill' end,
                                    (select string_agg(distinct coalesce(l.disc_name, 'Item discount'), ', ') from order_line l where l.order_id = o.id and l.disc_type is not null and not l.is_void)),
                           o.discount_total
                    from pos_order o join branch b on b.id = o.branch_id
                    where o.branch_id = any(@ids) and o.business_date between @f and @t and o.discount_total > 0 and o.status in ('paid','refunded')
                    order by o.business_date, o.number
                    """, args, tx);
                // Expenses: cash paid out of the drawers, wastage and marketing give-aways (at their recorded value; not voided ones).
                var expenses = await c.QueryAsync<(string Type, DateOnly Day, string Branch, string? Account, string Who, decimal Amount, string? Memo)>("""
                    select 'Cash paid out', d.date, b.code, null, u.display_name, m.amount, m.reason
                    from cash_movement m join shift s on s.id = m.shift_id join business_day d on d.id = s.business_day_id join branch b on b.id = s.branch_id join app_user u on u.id = m.by_user
                    where s.branch_id = any(@ids) and d.date between @f and @t and m.kind = 'out'
                    union all
                    select case w.kind when 'marketing' then 'Marketing' else 'Wastage' end, w.business_date, b.code, case when w.kind = 'marketing' then b.marketing_account end,
                           trim(to_char(w.qty, 'FM999999990.###')) || ' × ' || w.name, coalesce(w.cost_value, 0), initcap(w.reason) || coalesce(': ' || w.note, '')
                    from wastage w join branch b on b.id = w.branch_id
                    where w.branch_id = any(@ids) and w.business_date between @f and @t and w.voided_at is null
                    order by 1, 2
                    """, args, tx);

                var taken = collected.Where(x => x.Kind == "payment").ToList();
                var back = collected.Where(x => x.Kind == "refund").ToList();
                return new
                {
                    from = f, to = t,
                    sales = new
                    {
                        sales.Orders, subtotal = sales.Subtotal, discount = sales.Discount, serviceCharge = sales.Service, vat = sales.Vat, vatIncluded = sales.VatIncluded,
                        billAmount = sales.Total, creditNotes = notes.Total, creditNoteCount = notes.Count, netSales = sales.Total - notes.Total,
                    },
                    collection = new
                    {
                        payments = taken.Select(x => new { x.Label, x.Count, x.Amount }), refunds = back.Select(x => new { x.Label, x.Count, x.Amount }),
                        net = taken.Sum(x => x.Amount) - back.Sum(x => x.Amount),
                    },
                    tax = tax.Select(x => new { x.Rate, x.Amount, x.Vat }),
                    pos = new { gross = sales.Total + sales.Discount, deduction = sales.Discount + notes.Total, net = sales.Total - notes.Total },
                    cancelled = cancelled.Select(x => new { x.Bill, x.Branch, x.Amount, x.Reason, x.By }),
                    voided = voided.Select(x => new { x.Code, x.Name, x.Qty, x.Amount }),
                    categories = items.GroupBy(x => x.Category ?? "Other").Select(g => new { category = g.Key, qty = g.Sum(x => x.Qty), amount = Money.Round(g.Sum(x => x.Sales)) }).OrderByDescending(x => x.amount),
                    bills = bills.Select(x => new { x.Cashier, x.Bill, x.Branch, x.Amount }),
                    discounts = discounts.Select(x => new { x.Bill, x.Branch, reference = x.Reference ?? "Discount", x.Amount }),
                    expenses = expenses.Select(x => new { x.Type, x.Day, x.Branch, x.Account, x.Who, x.Amount, x.Memo }),
                };
            });
        });

        // Closed days (admin and finance): each closed business day of the days with its kept Z report, and each shift of those days with its
        // own (kept when the shift closed). Open days aren't here: their X report is on the Day page.
        api.MapGet("/reports/days", async (HttpContext http, Db db, DateOnly from, DateOnly to, string? branches) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("facts.post");
            var (f, t) = from <= to ? (from, to) : (to, from);
            if (t.DayNumber - f.DayNumber > 366) throw new DomainException("Choose at most a year.");
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var ids = branches == "all"
                    ? (await c.QueryAsync<Guid>("""
                        select b.id from branch b where @admin or exists (select 1 from user_branch ub where ub.branch_id = b.id and ub.user_id = @u)
                        """, new { admin = scope.IsAdmin, u = scope.UserId }, tx)).ToArray()
                    : [scope.Branch];
                var days = await c.QueryAsync<ClosedDay>("""
                    select d.id, d.date, b.code as branch, d.closed_at, cu.display_name as closed_by_name, d.reopened, d.z_report::text as z
                    from business_day d join branch b on b.id = d.branch_id left join app_user cu on cu.id = d.closed_by
                    where d.branch_id = any(@ids) and d.date between @f and @t and d.status = 'closed'
                    order by d.date desc, b.code
                    """, new { ids, f, t }, tx);
                // Sales: what the shift took less what it paid back.
                var shifts = await c.QueryAsync<ClosedShift>("""
                    select s.id, d.date, b.code as branch, r.name as register_name, u.display_name as user_name, s.opened_at, s.closed_at, s.status,
                           s.opening_float, s.expected_cash, s.counted_cash, s.variance, a.display_name as approved_by_name,
                           coalesce((select sum(case p.kind when 'payment' then p.amount else -p.amount end) from payment p where p.shift_id = s.id), 0) as sales,
                           s.z_report::text as z
                    from shift s join business_day d on d.id = s.business_day_id join branch b on b.id = s.branch_id join register r on r.id = s.register_id
                    join app_user u on u.id = s.user_id left join app_user a on a.id = s.approved_by
                    where s.branch_id = any(@ids) and d.date between @f and @t and d.status = 'closed'
                    order by d.date desc, b.code, s.opened_at
                    """, new { ids, f, t }, tx);
                static JsonElement? Json(string? z) => z is null ? null : JsonDocument.Parse(z).RootElement;
                return new
                {
                    days = days.Select(x => new { x.Id, x.Date, x.Branch, x.ClosedAt, x.ClosedByName, x.Reopened, z = Json(x.Z) }),
                    shifts = shifts.Select(x => new { x.Id, x.Date, x.Branch, x.RegisterName, x.UserName, x.OpenedAt, x.ClosedAt, x.Status, x.OpeningFloat, x.ExpectedCash, x.CountedCash, x.Variance, x.ApprovedByName, x.Sales, z = Json(x.Z) }),
                };
            });
        });
    }

    public sealed class ClosedDay
    {
        public Guid Id { get; set; } public DateOnly Date { get; set; } public string Branch { get; set; } = ""; public DateTime? ClosedAt { get; set; } public string? ClosedByName { get; set; }
        public int Reopened { get; set; } public string? Z { get; set; }
    }

    public sealed class ClosedShift
    {
        public Guid Id { get; set; } public DateOnly Date { get; set; } public string Branch { get; set; } = ""; public string RegisterName { get; set; } = ""; public string UserName { get; set; } = "";
        public DateTime OpenedAt { get; set; } public DateTime? ClosedAt { get; set; } public string Status { get; set; } = ""; public decimal OpeningFloat { get; set; }
        public decimal? ExpectedCash { get; set; } public decimal? CountedCash { get; set; } public decimal? Variance { get; set; } public string? ApprovedByName { get; set; }
        public decimal Sales { get; set; } public string? Z { get; set; }
    }

    public sealed class Invoice
    {
        public Guid Id { get; set; } public string InvoiceNo { get; set; } = ""; public DateOnly BusinessDate { get; set; } public string Branch { get; set; } = "";
        public string At { get; set; } = ""; public string OrderType { get; set; } = ""; public string? Platform { get; set; } public string? PlatformRef { get; set; }
        public string Status { get; set; } = ""; public string? Cashier { get; set; } public string? Till { get; set; } public decimal Items { get; set; }
        public decimal Gross { get; set; } public decimal Discount { get; set; } public decimal Vat { get; set; } public decimal Net { get; set; } public decimal Refunded { get; set; }
        public string? PaidBy { get; set; } public string? Facts { get; set; } public string? Customer { get; set; }
    }

    public sealed class InvoicePayment
    {
        public Guid OrderId { get; set; } public string Type { get; set; } = ""; public decimal Amount { get; set; }
    }

    public sealed class ReturnRow
    {
        public Guid Id { get; set; } public Guid OrderId { get; set; } public string Number { get; set; } = ""; public string? InvoiceNo { get; set; }
        public DateOnly BusinessDate { get; set; } public string Branch { get; set; } = ""; public string Kind { get; set; } = ""; public string Reason { get; set; } = "";
        public decimal Total { get; set; } public decimal Vat { get; set; } public string At { get; set; } = ""; public string? Cashier { get; set; } public string? Till { get; set; }
        public decimal BillTotal { get; set; } public string? BillAt { get; set; } public string? BackBy { get; set; }
        public string? Facts { get; set; } public string? FactsDoc { get; set; } public string? FactsError { get; set; }
    }
}
