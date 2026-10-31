using Dapper;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Tax invoice numbers, returns and refunds (REQ PAY-04; UAE VAT credit notes). A paid order gets a sequential tax invoice number.
/// Every refund is a tax credit note referencing it: items returned (the refund is worked out from each line's share of the bill,
/// discount, service charge and VAT included) or an amount (goodwill). Limits: the role's maxRefund and the branch's return window.
/// </summary>
public static class Returns
{
    public sealed record ReturnLine(Guid LineId, decimal Qty, bool? Restock);
    public sealed record ReturnBody(ReturnLine[] Lines, string Method, string Reason);
    public sealed record RefundBody(decimal Amount, string Method, string Reason);
    public sealed record BillReturnBody(string Reason);

    public sealed class CreditNoteRow
    {
        public string? VoucherCode { get; set; }
        public Guid Id { get; set; }
        public string Number { get; set; } = "";
        public DateOnly BusinessDate { get; set; }
        public string Kind { get; set; } = "";
        public string Reason { get; set; } = "";
        public string Method { get; set; } = "";
        public decimal Total { get; set; }
        public decimal Vat { get; set; }
        public DateTime CreatedAt { get; set; }
        public string? CreatedByName { get; set; }
        public List<CreditLine> Lines { get; set; } = [];
    }

    public sealed class CreditLine
    {
        public Guid CreditNoteId { get; set; }
        public string Name { get; set; } = "";
        public string? NameAr { get; set; }
        public decimal Qty { get; set; }
        public decimal Amount { get; set; }
        public decimal Vat { get; set; }
        public bool Restock { get; set; }
    }

    private static readonly string[] Methods = ["cash", "card", "other", "voucher", "account", "points", "platform"];

    /// <summary>Gives a fully paid order its tax invoice number, once: INV, the branch code and the serial (INV-EBL-01-000001).</summary>
    public static async Task AssignInvoiceAsync(NpgsqlConnection c, NpgsqlTransaction tx, Orders.OrderRow o)
    {
        var no = await NextAsync(c, tx, o.CompanyId, o.BranchId, "INV");
        await c.ExecuteAsync("update pos_order set invoice_no = @no where id = @id and invoice_no is null", new { no, o.Id }, tx);
    }

    private static async Task<string> NextAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid companyId, Guid branchId, string series)
    {
        var n = await c.ExecuteScalarAsync<long>("""
            insert into number_series (company_id, branch_id, series, next_no) values (@companyId, @branchId, @series, 2)
            on conflict (branch_id, series) do update set next_no = number_series.next_no + 1 returning next_no - 1
            """, new { companyId, branchId, series }, tx);
        var code = await c.ExecuteScalarAsync<string>("select code from branch where id = @branchId", new { branchId }, tx);
        // The series, the branch code and the serial (INV-EBL-01-000123): the same number on the bill and in FACTS, which takes 20
        // characters (its payment posting too since 19-10-2026); a long branch code (up to 12) drops the series (ABCDEFGH-01-000123).
        var no = $"{series}-{code}-{n:000000}";
        return no.Length <= Erp.FactsPosting.FactsNoLength ? no : $"{code}-{n:000000}";
    }

    public static async Task<List<CreditNoteRow>> CreditNotesAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid orderId)
    {
        var notes = (await c.QueryAsync<CreditNoteRow>("""
            select n.*, u.display_name as created_by_name, v.code as voucher_code from credit_note n left join app_user u on u.id = n.created_by left join voucher v on v.id = n.voucher_id where n.order_id = @orderId order by n.created_at
            """, new { orderId }, tx)).ToList();
        var ids = notes.Select(n => n.Id).ToArray();
        var lines = (await c.QueryAsync<CreditLine>("""
            select cl.credit_note_id, cl.name, ol.name_ar, cl.qty, cl.amount, cl.vat, cl.restock
            from credit_note_line cl left join order_line ol on ol.id = cl.order_line_id where cl.credit_note_id = any(@ids)
            """, new { ids }, tx)).ToList();
        foreach (var n in notes) n.Lines = lines.Where(l => l.CreditNoteId == n.Id).ToList();
        return notes;
    }

    public static void Map(RouteGroupBuilder api)
    {
        // Items back: each line's share of what was paid (discount, service charge and VAT included), the role's limit, the window.
        api.MapPost("/orders/{id:guid}/return", (Guid id, ReturnBody body, HttpContext http, Db db, Live live) => Orders.Mutate(http, db, live, id, "pos.sell", async (c, tx, o, scope) =>
        {
            var (method, reason, late) = await CheckAsync(c, tx, o, scope, body.Method, body.Reason);
            var all = (await c.QueryAsync<Orders.LineRow>("select * from order_line where order_id = @id and not is_void order by sort", new { id }, tx)).ToList();
            var returned = (await c.QueryAsync<(Guid Id, decimal ReturnedQty)>("select id, returned_qty from order_line where order_id = @id", new { id }, tx)).ToDictionary(x => x.Id, x => x.ReturnedQty);
            var wanted = (body.Lines ?? []).Where(l => l.Qty > 0).ToList();
            if (wanted.Count == 0) throw new DomainException("Choose what is coming back.");
            // What each line was really sold for: its value less its discount (a promotion, an item discount or its share of the bill's).
            var subtotal = all.Sum(l => l.LineTotal - l.Discount);
            if (subtotal <= 0) throw new DomainException("Nothing on this order can be returned.");
            var parts = new List<(Orders.LineRow Line, decimal Qty, bool Restock, decimal Amount, decimal Vat)>();
            foreach (var w in wanted)
            {
                var l = all.FirstOrDefault(x => x.Id == w.LineId) ?? throw new DomainException("A chosen line isn't on this order.");
                var left = l.Qty - returned.GetValueOrDefault(l.Id);
                if (w.Qty > left) throw new DomainException($"Only {left} × {l.Name} can still be returned.");
                var share = (l.LineTotal - l.Discount) * w.Qty / l.Qty / subtotal;   // this part's share of the bill
                parts.Add((l, w.Qty, w.Restock == true, Money.Round(o.Total * share), Money.Round(o.Vat * share)));
            }
            // Everything still returnable comes back: refund exactly what's left (no rounding remainder).
            var everything = all.All(l => l.Qty - returned.GetValueOrDefault(l.Id) == wanted.Where(w => w.LineId == l.Id).Sum(w => w.Qty));
            var total = everything ? o.Paid - o.Refunded : parts.Sum(p => p.Amount);
            if (total <= 0) throw new DomainException("There's nothing left to refund on this order.");
            total = Math.Min(total, o.Paid - o.Refunded);
            await LimitAsync(c, tx, http, scope, o, total, late);
            var vat = everything ? Math.Max(0, o.Vat - await c.ExecuteScalarAsync<decimal>("select coalesce(sum(vat), 0) from credit_note where order_id = @id", new { id }, tx)) : parts.Sum(p => p.Vat);
            var noteId = await WriteAsync(c, tx, o, scope, "items", reason, method, total, vat);
            foreach (var p in parts)
            {
                await c.ExecuteAsync("""
                    insert into credit_note_line (company_id, credit_note_id, order_line_id, name, qty, amount, vat, restock)
                    values (@co, @noteId, @lid, @name, @qty, @amount, @vat, @restock)
                    """, new { co = o.CompanyId, noteId, lid = p.Line.Id, name = p.Line.Name, qty = p.Qty, amount = p.Amount, vat = p.Vat, restock = p.Restock }, tx);
                await c.ExecuteAsync("update order_line set returned_qty = returned_qty + @qty where id = @lid", new { qty = p.Qty, lid = p.Line.Id }, tx);
            }
            // Back to stock: the returned items' ingredients go back on.
            await Recipes.RestockAsync(c, tx, o, parts.Where(p => p.Restock).Select(p => (p.Line, p.Qty)), scope.UserId);
            await Erp.FactsPosting.EnqueueRefundAsync(c, tx, noteId, o.Id);
            await Audit.RecordAsync(c, tx, o.CompanyId, o.BranchId, scope.UserId, "order", id.ToString(), "return",
                $"Order #{o.Number}: {parts.Sum(p => p.Qty)} item(s) returned, {total:N2} refunded by {method}", note: reason);
        }, allowClosed: true));

        // The Return button: the whole bill back, each payment the way it was paid, its items back on stock. On the bill's own
        // business day anyone at the till does it without approval; a later day needs the return window or a manager, as any refund.
        // Where the company posts returns to FACTS it goes as a posted PSR51, a copy of the bill's POS51. A 0.00 bill comes back too
        // (its items on stock, its PSR51): a 0.00 return record, no money and no tax credit note.
        api.MapPost("/orders/{id:guid}/return-bill", (Guid id, BillReturnBody body, HttpContext http, Db db, Live live) => Orders.Mutate(http, db, live, id, "pos.sell", async (c, tx, o, scope) =>
        {
            if (o.Refunded > 0) throw new DomainException("Part of this bill was refunded already, so it can't be returned as a whole bill.");
            var pays = (await c.QueryAsync<(string Method, decimal Amount, string? CardType)>("""
                select method, sum(amount), card_type from payment where order_id = @id and kind = 'payment' group by method, card_type order by sum(amount) desc
                """, new { id }, tx)).ToList();
            if (o.Paid <= 0 && o.Total > 0) throw new DomainException("Nothing was paid on this bill.");
            var method = pays.Count > 0 ? pays[0].Method : "other";
            var (_, reason, _) = await CheckAsync(c, tx, o, scope, method, body.Reason);
            // An earlier day's bill: only an administrator or a manager (day.manage) returns it, or approves it at the till.
            if (await Days.DateAsync(c, tx, o.BranchId) != o.BusinessDate && !scope.IsAdmin && !scope.Can("day.manage"))
                await Approvals.RequireAsync(c, tx, http, scope, "refund", o.Paid, "Only a manager returns a bill from an earlier day. A manager can approve it.", late: true, orderId: o.Id);
            var all = (await c.QueryAsync<Orders.LineRow>("select * from order_line where order_id = @id and not is_void and qty > returned_qty order by sort", new { id }, tx)).ToList();
            if (all.Count == 0) throw new DomainException("Nothing on this bill can be returned.");
            var returned = (await c.QueryAsync<(Guid Id, decimal ReturnedQty)>("select id, returned_qty from order_line where order_id = @id", new { id }, tx)).ToDictionary(x => x.Id, x => x.ReturnedQty);
            // Each line's share of what was paid; the last takes the rounding, so the lines add up to the bill.
            var subtotal = all.Sum(l => l.LineTotal - l.Discount);
            var parts = all.Select(l => (Line: l, Qty: l.Qty - returned.GetValueOrDefault(l.Id),
                                        Amount: subtotal > 0 ? Money.Round(o.Paid * (l.LineTotal - l.Discount) / subtotal) : 0m,
                                        Vat: subtotal > 0 ? Money.Round(o.Vat * (l.LineTotal - l.Discount) / subtotal) : 0m)).ToList();
            parts[^1] = parts[^1] with { Amount = o.Paid - parts.Take(parts.Count - 1).Sum(p => p.Amount), Vat = o.Vat - parts.Take(parts.Count - 1).Sum(p => p.Vat) };
            var noteId = await WriteAsync(c, tx, o, scope, "bill", reason, method, o.Paid, o.Vat, pays);
            foreach (var p in parts)
            {
                await c.ExecuteAsync("""
                    insert into credit_note_line (company_id, credit_note_id, order_line_id, name, qty, amount, vat, restock)
                    values (@co, @noteId, @lid, @name, @qty, @amount, @vat, true)
                    """, new { co = o.CompanyId, noteId, lid = p.Line.Id, name = p.Line.Name, qty = p.Qty, amount = p.Amount, vat = p.Vat }, tx);
                await c.ExecuteAsync("update order_line set returned_qty = qty where id = @lid", new { lid = p.Line.Id }, tx);
            }
            // The items come back on stock (their ingredients).
            await Recipes.RestockAsync(c, tx, o, parts.Select(p => (p.Line, p.Qty)), scope.UserId);
            await Erp.FactsPosting.EnqueueRefundAsync(c, tx, noteId, o.Id);
            await Audit.RecordAsync(c, tx, o.CompanyId, o.BranchId, scope.UserId, "order", id.ToString(), "return-bill",
                pays.Count == 0 ? $"Order #{o.Number}: whole 0.00 bill returned, items back on stock"
                    : $"Order #{o.Number}: whole bill returned, {o.Paid:N2} refunded ({string.Join(", ", pays.Select(p => $"{p.CardType ?? p.Method} {p.Amount:N2}"))})", note: reason);
        }, allowClosed: true));

        // An amount back without items (goodwill, overcharge): still a credit note, its VAT in proportion to the bill.
        api.MapPost("/orders/{id:guid}/refund", (Guid id, RefundBody body, HttpContext http, Db db, Live live) => Orders.Mutate(http, db, live, id, "pos.sell", async (c, tx, o, scope) =>
        {
            var (method, reason, late) = await CheckAsync(c, tx, o, scope, body.Method, body.Reason);
            var amount = Money.Round(body.Amount);
            var left = o.Paid - o.Refunded;
            if (amount <= 0 || amount > left) throw new DomainException($"A refund is more than zero and at most {left:N2}.");
            await LimitAsync(c, tx, http, scope, o, amount, late);
            var vat = o.Total == 0 ? 0 : Money.Round(o.Vat * amount / o.Total);
            var amountNoteId = await WriteAsync(c, tx, o, scope, "amount", reason, method, amount, vat);
            await Erp.FactsPosting.EnqueueRefundAsync(c, tx, amountNoteId, o.Id);
            await Audit.RecordAsync(c, tx, o.CompanyId, o.BranchId, scope.UserId, "order", id.ToString(), "refund", $"Order #{o.Number}: {amount:N2} refunded by {method}", note: reason);
        }, allowClosed: true));
    }

    private static async Task<(string Method, string Reason, bool Late)> CheckAsync(NpgsqlConnection c, NpgsqlTransaction tx, Orders.OrderRow o, Scope scope, string? m, string? r)
    {
        if (o.Status is not ("paid" or "refunded")) throw new DomainException("Only a paid order can be refunded. An open one is changed or voided instead.");
        if (!await c.ExecuteScalarAsync<bool>("select returns_enabled from branch where id = @b", new { b = o.BranchId }, tx))
            throw new DomainException("Returns are switched off for this branch (Companies & branches).");
        if (string.IsNullOrWhiteSpace(r)) throw new DomainException("Give a reason for the refund.");
        var method = (m ?? "").Trim().ToLowerInvariant();
        if (!Methods.Contains(method)) throw new DomainException("Choose how the money goes back.");
        // The return window: days after the order's business date (0 = the same day). Later needs day.manage.
        var br = await c.QuerySingleAsync<(int ReturnDays, string TimeZone)>("select return_days, time_zone from branch where id = @b", new { b = o.BranchId }, tx);
        var age = (await Days.DateAsync(c, tx, o.BranchId)).DayNumber - o.BusinessDate.DayNumber;
        return (method, r.Trim(), age > br.ReturnDays && !scope.Can("day.manage"));
    }

    /// <summary>A refund above the role's limit, or outside the return window, needs a manager's approval.</summary>
    private static async Task LimitAsync(NpgsqlConnection c, NpgsqlTransaction tx, HttpContext http, Scope scope, Orders.OrderRow o, decimal amount, bool late)
    {
        // Without the refund permission at all, a manager can still approve this one.
        var noRight = !scope.Can("pos.refund");
        var over = scope.Limit("maxRefund") is { } max && amount > max;
        if (!noRight && !over && !late) return;
        var why = noRight ? "Your role doesn't do refunds." : late ? "This order is outside the return window." : $"Your role can refund up to {scope.Limit("maxRefund"):N2}.";
        await Approvals.RequireAsync(c, tx, http, scope, "refund", amount, $"{why} A manager can approve it.", late, orderId: o.Id);
    }

    private static async Task<Guid> WriteAsync(NpgsqlConnection c, NpgsqlTransaction tx, Orders.OrderRow o, Scope scope, string kind, string reason, string method, decimal total, decimal vat,
        IReadOnlyList<(string Method, decimal Amount, string? CardType)>? split = null)
    {
        // The money back: one way, or (a whole bill) each payment the way it was paid.
        IReadOnlyList<(string Method, decimal Amount, string? CardType)> backs = split ?? [(method, total, null)];
        // Refunds come out of today's business day and, on a register, the cashier's open shift (its cash count). Cash always
        // comes out of a drawer, so a cash refund needs one; a card refund may be done from the back office.
        var day = (await Days.CurrentAsync(c, tx, o.BranchId, scope.UserId)).Date;
        var shift = await Days.ShiftOfAsync(c, tx, scope.RegisterId, scope.UserId);
        if (backs.Any(x => x.Method == "cash") && scope.RegisterId is null) throw new DomainException("A cash refund comes out of a drawer: pick the register you're at first (on the Dashboard).");
        if (scope.RegisterId is not null && shift is null) throw new DomainException("Open your shift first: count the float in the drawer (on the Dashboard).");
        var number = await NextAsync(c, tx, o.CompanyId, o.BranchId, "CN");
        var noteId = await c.ExecuteScalarAsync<Guid>("""
            insert into credit_note (company_id, branch_id, order_id, register_id, number, business_date, kind, reason, method, total, vat, created_by)
            values (@co, @b, @id, @reg, @number, @day, @kind, @reason, @method, @total, @vat, @user) returning id
            """, new { co = o.CompanyId, b = o.BranchId, id = o.Id, reg = scope.RegisterId, number, day, kind, reason, method, total, vat, user = scope.UserId }, tx);
        foreach (var back in backs)
        {
            // Refunded "as a voucher": store credit, a new voucher for the amount (its code prints on the credit note).
            Guid? voucherId = null;
            if (back.Method == "voucher")
            {
                var customer = await c.ExecuteScalarAsync<Guid?>("select customer_id from pos_order where id = @Id", new { o.Id }, tx);
                var v = await Rewards.IssueAsync(c, tx, o.CompanyId, o.BranchId, scope.UserId, back.Amount, "refund", null, customer, $"Refund {number}", o.Id);
                voucherId = v.Id;
                await c.ExecuteAsync("update credit_note set voucher_id = @voucherId where id = @noteId", new { voucherId, noteId }, tx);
            }
            await c.ExecuteAsync("""
                insert into payment (company_id, branch_id, register_id, order_id, business_date, kind, method, amount, reason, taken_by, credit_note_id, shift_id, voucher_id, card_type)
                values (@co, @b, @reg, @id, @day, 'refund', @method, @amount, @reason, @user, @noteId, @shift, @voucherId, @cardType)
                """, new { co = o.CompanyId, b = o.BranchId, reg = scope.RegisterId, id = o.Id, day, method = back.Method, amount = back.Amount, reason, user = scope.UserId, noteId, shift, voucherId, cardType = back.CardType }, tx);
            // Points the refunded share earned go back; refunded "by points" gives the points back.
            await Rewards.RefundAsync(c, tx, o, scope.UserId, back.Method, back.Amount);
        }
        await c.ExecuteAsync("""
            update pos_order set refunded = refunded + @total, status = case when refunded + @total >= paid then 'refunded' else status end where id = @id
            """, new { id = o.Id, total }, tx);
        return noteId;
    }
}
