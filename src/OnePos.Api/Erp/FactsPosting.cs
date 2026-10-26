using System.Data;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Dapper;
using Microsoft.Data.SqlClient;
using Npgsql;
using OnePos.Api.Data;
using OnePos.Api.Platform;

namespace OnePos.Api.Erp;

/// <summary>
/// Posting sales to FACTS (REQ ERP-05, ERP-06), the way the outlet POS (Polaris) does: each paid bill is sent as XML to FACTS'
/// usp_FQAPI_PWA_POS_SaveInvoice, which makes a POS51 document (same invoice number again = a revision, never a double).
/// A bill goes into the queue when it's paid at a branch with a posting start date; the sender sends the queue only while an
/// administrator has posting switched on for the company. Refunds: a company setting (not posted, or SR50 credit notes through
/// a FACTS procedure the FACTS developer provides). Wastage isn't posted (finance posts it in FACTS, by FIFO batch).
/// </summary>
public static partial class FactsPosting
{
    public sealed record CompanyBody(bool Posting, string Refunds, string? RefundProc, string? InvoiceProc = null, string? Wastage = null, string? Repacking = null);

    /// <summary>One POS' procedure in FACTS (db/facts/usp_ONEPOS_SaveWastageTransfer.sql): a day's wastage as a draft STV50.</summary>
    public const string WastageProc = "usp_ONEPOS_SaveWastageTransfer";
    /// <summary>FACTS: approved wastage as a POSTED STV50 (batches FIFO, FACTS' own approval), as the branch approver's FACTS user.</summary>
    public const string PostWastageProc = "usp_ONEPOS_PostWastageTransfer";
    /// <summary>FACTS: approved marketing give-aways as a POSTED MCV50 (batch cost to the marketing expense account), db/facts/usp_ONEPOS_PostConsumption.sql.</summary>
    public const string PostConsumptionProc = "usp_ONEPOS_PostConsumption";
    /// <summary>
    /// Who a draft transfer is created by in FACTS: it must be a FACTS user (TRANSFER_HEADER's creator is checked against
    /// USER_MASTER). POSBAKERY is the user FACTS already puts on every POS bill.
    /// </summary>
    public const string WastageUser = "POSBAKERY";

    /// <summary>FACTS' own procedure for a POS bill (the outlet POS uses it): the sale, no batches.</summary>
    public const string StandardInvoiceProc = "usp_FQAPI_PWA_POS_SaveInvoice";
    /// <summary>One POS' procedure in FACTS (db/facts/usp_ONEPOS_SaveInvoice.sql): the standard one, then each line its batch, FIFO.</summary>
    public const string FifoInvoiceProc = "usp_ONEPOS_SaveInvoice";
    public sealed record BranchBody(DateOnly? PostFrom);

    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
    private static string N(decimal v, int d = 2) => v.ToString("0." + new string('0', d), Inv);

    [GeneratedRegex(@"^[A-Za-z0-9_]{1,100}$")]
    private static partial Regex ProcName();

    private sealed class OrderInfo
    {
        /// <summary>A pre-approved customer discount's reason (Complimentary, Staff meal…), else null.</summary>
        public string? PreapprovedLabel { get; set; }
        public Guid Id { get; set; }
        public Guid CompanyId { get; set; }
        public Guid BranchId { get; set; }
        public string? InvoiceNo { get; set; }
        /// <summary>The branch's FACTS number prefix (EBQS): FACTS gets the prefix and the invoice's serial.</summary>
        public string? DocPrefix { get; set; }
        /// <summary>The number FACTS knows this bill by (EBQS000123), or null when it can't be made.</summary>
        public string? FactsNo => FactsPosting.FactsNo(InvoiceNo, DocPrefix);
        public DateOnly BusinessDate { get; set; }
        public string OrderType { get; set; } = "";
        public string Status { get; set; } = "";
        public decimal Subtotal { get; set; }
        public decimal DiscountTotal { get; set; }
        public decimal DiscountPct { get; set; }
        public decimal ServiceCharge { get; set; }
        public decimal Vat { get; set; }
        public decimal Total { get; set; }
        public decimal VatRate { get; set; }
        public string? CustomerName { get; set; }
        public string? CustomerPhone { get; set; }
        public string? DeliveryAddress { get; set; }
        public DateTime? ClosedAt { get; set; }
        public string? Location { get; set; }
        public string Currency { get; set; } = "AED";
        public string? Cashier { get; set; }
        public string? PlatformName { get; set; }
        /// <summary>The delivery platform's own order number (Talabat…), as typed at the till.</summary>
        public string? PlatformRef { get; set; }
        public DateOnly? PostFrom { get; set; }
    }

    private sealed class LineInfo
    {
        public string Name { get; set; } = "";
        public decimal Qty { get; set; }
        public decimal UnitPrice { get; set; }
        public decimal LineTotal { get; set; }
        public decimal Discount { get; set; }
        public decimal Vat { get; set; }
        public string Modifiers { get; set; } = "[]";
        public string? Code { get; set; }
        public string? Type { get; set; }
        public string? Unit { get; set; }
        public bool IsCombo { get; set; }
    }

    /// <summary>One FACTS item that a unit of a bill line is, at its rate; Mods are the line's chosen options that go with it.</summary>
    private sealed record Part(string Name, string? Code, string? Type, string? Unit, decimal Rate, List<JsonElement> Mods);

    private static Guid? ComboItemId(JsonElement m) =>
        m.TryGetProperty("itemId", out var v) && v.ValueKind == JsonValueKind.String && Guid.TryParse(v.GetString(), out var g) ? g : null;

    private static decimal ModPrice(JsonElement m) => m.TryGetProperty("price", out var p) && p.ValueKind == JsonValueKind.Number ? p.GetDecimal() : 0;

    /// <summary>The FACTS code, type and unit of the menu items chosen in these combo lines.</summary>
    private static async Task<Dictionary<Guid, (string? Code, string? Type, string? Unit)>> ComboItemsAsync(NpgsqlConnection c, NpgsqlTransaction tx, IEnumerable<string> modifiers)
    {
        var ids = modifiers.SelectMany(m => JsonDocument.Parse(m).RootElement.EnumerateArray().Select(ComboItemId)).OfType<Guid>().Distinct().ToArray();
        if (ids.Length == 0) return [];
        return (await c.QueryAsync<(Guid Id, string? Code, string? Type, string? Unit)>(
            "select id, erp_item_code, erp_item_type, erp_unit from menu_item where id = any(@ids)", new { ids }, tx)).ToDictionary(x => x.Id, x => (x.Code, x.Type, x.Unit));
    }

    /// <summary>
    /// What one unit of a bill line is in FACTS: its own item, or for a combo (no FACTS code of its own) each chosen item at the price
    /// set on that choice in the combo. Anything else in the combo's price (its own price, a chosen extra that isn't an item) goes on
    /// the first item, so the parts add up to the line. A combo with no chosen item stays one part (and fails for having no code).
    /// </summary>
    private static List<Part> Parts(string name, bool isCombo, string modifiers, decimal unitPrice, string? code, string? type, string? unit,
        IReadOnlyDictionary<Guid, (string? Code, string? Type, string? Unit)> items)
    {
        var mods = JsonDocument.Parse(modifiers).RootElement.EnumerateArray().ToList();
        var chosen = isCombo ? mods.Where(m => ComboItemId(m) is { } id && items.ContainsKey(id)).ToList() : [];
        if (chosen.Count == 0) return [new(name, code, type, unit, unitPrice, mods)];
        var extras = mods.Where(m => ComboItemId(m) is null).ToList();
        return chosen.Select((m, k) =>
        {
            var it = items[ComboItemId(m)!.Value];
            var rate = k == 0 ? unitPrice - chosen.Skip(1).Sum(ModPrice) : ModPrice(m);
            return new Part(m.TryGetProperty("name", out var nm) ? nm.GetString() ?? "" : "", it.Code, it.Type, it.Unit, rate, k == 0 ? extras : []);
        }).ToList();
    }

    /// <summary>An amount shared by weight, rounded to fils; the last share takes what rounding leaves.</summary>
    private static decimal[] Share(decimal amount, decimal[] weights)
    {
        var total = weights.Sum();
        var r = weights.Select(w => total == 0 ? 0 : Money.Round(amount * w / total)).ToArray();
        r[^1] = amount - r[..^1].Sum();
        return r;
    }

    private const string OrderSql = """
        select o.id, o.company_id, o.branch_id, o.invoice_no, o.business_date, o.order_type, o.status, o.subtotal, o.discount_total, o.discount_pct,
               o.service_charge, o.vat, o.total, o.vat_rate, o.customer_name, o.customer_phone, o.delivery_address, o.closed_at,
               b.erp_location_code as location, co.base_currency as currency, u.display_name as cashier, dp.name as platform_name, o.platform_ref, b.facts_post_from as post_from,
               b.facts_doc_prefix as doc_prefix, case when o.discount_source = 'customer' then o.discount_name end as preapproved_label
        from pos_order o join branch b on b.id = o.branch_id join company co on co.id = o.company_id
        left join app_user u on u.id = o.opened_by left join delivery_platform dp on dp.id = o.platform_id
        """;

    /// <summary>The longest document number FACTS' accounts posting keeps (usp_SAL_APPR_AccountsUpdation: NVARCHAR(10)).</summary>
    /// <summary>FACTS' document number: 20 characters through sale, stock, accounts and payment posting (tested 19-10-2026).</summary>
    public const int FactsNoLength = 20;

    /// <summary>
    /// The number a One POS document goes to FACTS by: its own number (INV-EBL-01-000123), at most <see cref="FactsNoLength"/> characters;
    /// null when it is longer. The prefix is not used (kept for old callers).
    /// </summary>
    public static string? FactsNo(string? number, string? prefix) => number is { Length: > 0 and <= FactsNoLength } ? number : null;

    /// <summary>A paid bill as the XML FACTS' POS invoice procedure reads (the same shape Polaris sends), and what stops it from posting.</summary>
    private static async Task<(string Xml, List<string> Problems, OrderInfo Order)> InvoiceAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid orderId)
    {
        var o = await c.QuerySingleAsync<OrderInfo>($"{OrderSql} where o.id = @orderId", new { orderId }, tx);
        var problems = new List<string>();
        if (o.Location is null) problems.Add("The branch has no FACTS location.");
        if (o.InvoiceNo is null) problems.Add("The bill has no invoice number (not paid).");
        else if (o.FactsNo is null) problems.Add($"Invoice {o.InvoiceNo} is longer than the {FactsNoLength} characters FACTS takes.");
        var lines = (await c.QueryAsync<LineInfo>("""
            select l.name, l.qty, l.unit_price, l.line_total, l.discount, l.vat, l.modifiers::text as modifiers, i.erp_item_code as code, i.erp_item_type as type, i.erp_unit as unit,
                   coalesce(i.is_combo, false) as is_combo
            from order_line l left join menu_item i on i.id = l.item_id where l.order_id = @orderId and not l.is_void order by l.sort
            """, new { orderId }, tx)).ToList();
        var comboItems = await ComboItemsAsync(c, tx, lines.Where(l => l.IsCombo).Select(l => l.Modifiers));
        var parts = lines.Select(l => Parts(l.Name, l.IsCombo, l.Modifiers, l.UnitPrice, l.Code, l.Type, l.Unit, comboItems)).ToList();
        foreach (var (l, ps) in lines.Zip(parts))
            foreach (var p in ps.Where(p => p.Code is null || p.Type is null))
                problems.Add(!l.IsCombo ? $"{l.Name} isn't a FACTS item (no item code)."
                    : ps.Count == 1 && p.Name == l.Name ? $"Combo {l.Name} has no chosen item to send to FACTS."
                    : $"{p.Name} in combo {l.Name} isn't a FACTS item (no item code).");
        var modes = (await c.QueryAsync<(string Name, string Kind, string Label)>("select name, kind, label from erp_payment_mode where branch_id = @BranchId", new { o.BranchId }, tx)).ToList();
        var pays = (await c.QueryAsync<(string Method, decimal Amount, string? CardType)>(
            "select method, amount, card_type from payment where order_id = @orderId and kind = 'payment' order by at", new { orderId }, tx)).ToList();

        // Each line's discount as the bill worked it out (its promotion / item discount, or its share of the bill discount).
        var discounts = lines.Select(l => l.Discount).ToArray();

        string? Mode(string method, string? cardType)
        {
            switch (method)
            {
                case "cash": return modes.FirstOrDefault(m => m.Kind == "cash").Name;
                case "card": return cardType ?? modes.FirstOrDefault(m => m.Kind == "card").Name;
                case "platform":
                    var p = (o.PlatformName ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.ToLowerInvariant();
                    return p is null ? null : modes.FirstOrDefault(m => m.Kind == "platform" && m.Label.Contains(p, StringComparison.OrdinalIgnoreCase)).Name;
                default: return null;
            }
        }
        var receipts = new List<XElement>();
        foreach (var p in pays)
        {
            var mode = Mode(p.Method, p.CardType);
            if (mode is null) problems.Add($"No FACTS payment method for {p.Method}{(p.Method == "platform" ? $" ({o.PlatformName})" : "")} at {o.Location}.");
            receipts.Add(new XElement("ReceiptDetails",
                new XElement("ReceiptMode", mode ?? ""), new XElement("ReceiptAmount", N(p.Amount)), new XElement("ReceiptVoucherNo", ""),
                new XElement("ReceiptChequeNo", ""), new XElement("ReceiptChequeDate", "")));
        }

        // A FACTS line per part: a combo line's gross (by its items' rates), discount and VAT are shared out so its lines add up to it.
        var details = lines.Zip(parts, discounts).SelectMany(x =>
        {
            var (l, ps, discount) = x;
            var gross = ps.Select(p => Money.Round(p.Rate * l.Qty)).ToArray();
            gross[0] = l.LineTotal - gross[1..].Sum();
            var disc = Share(discount, gross);
            var vat = Share(l.Vat, gross);
            return ps.Select((p, k) => (p, l.Qty, Gross: gross[k], Disc: disc[k], Vat: vat[k]));
        }).Select((x, i) =>
        {
            var mods = x.p.Mods.Select(m => new XElement("Modifiers",
                new XElement("ModifierCode", ""), new XElement("ModifierQty", N(x.Qty, 3)), new XElement("ModifierRate", N(ModPrice(m))),
                new XElement("ModifierName", m.TryGetProperty("name", out var nm) ? nm.GetString() : ""), new XElement("ModifierUnit", x.p.Unit ?? "PCS")));
            return new XElement("InvoiceDetails",
                new XElement("ItemSrNo", i + 1), new XElement("ItemType", x.p.Type ?? ""), new XElement("ItemCode", x.p.Code ?? ""),
                new XElement("ItemQty", N(x.Qty, 3)), new XElement("ItemUnit", x.p.Unit ?? "PCS"), new XElement("ItemRate", N(x.p.Rate)),
                new XElement("ItemGrossAmount", N(x.Gross)), new XElement("ItemDiscountAmount", N(x.Disc)), new XElement("ItemDiscountPercentage", N(x.Gross == 0 ? 0 : Math.Round(x.Disc * 100 / x.Gross, 2, MidpointRounding.AwayFromZero))),
                new XElement("ItemAmount", N(x.Gross - x.Disc)), new XElement("VATPercentage", N(o.VatRate)), new XElement("VATAmount", N(x.Vat)),
                mods);
        });
        var at = (o.ClosedAt ?? DateTime.UtcNow).ToString("yyyy-MM-dd HH:mm:ss", Inv);
        var xml = new XElement("data", new XElement("Invoice",
            // The bill's own number (INV-EBL-01-000123), the same on the receipt and in FACTS (20 characters at most).
            new XElement("InvoiceNo", o.FactsNo ?? ""), new XElement("InvoiceDate", o.BusinessDate.ToString("yyyy-MM-dd", Inv)),
            new XElement("CurrCode", o.Currency), new XElement("ExchangeRate", "1"), new XElement("LocationCode", o.Location ?? ""),
            new XElement("GrossAmount", N(o.Subtotal)), new XElement("OtherAmount", N(o.ServiceCharge)), new XElement("DiscountPercentage", N(o.DiscountPct)),
            new XElement("DiscountAmount", N(o.DiscountTotal)), new XElement("NetAmount", N(o.Total)), new XElement("TotalVATAmount", N(o.Vat)),
            new XElement("VATRateType", "-1"), new XElement("VATCategory", "SR"),
            new XElement("CreatedBy", (o.Cashier ?? "One POS").Length > 20 ? o.Cashier![..20] : o.Cashier ?? "One POS"),
            new XElement("CreatedTs", at), new XElement("ModifiedTs", at), new XElement("Status", "Open"),
            new XElement("DeliveryMode", o.OrderType switch { "delivery" => "Delivery", "dine_in" => "Dine In", _ => "Takeaway" }),
            // FACTS saves the bill's header only when the bill-to address is there, so it always is (empty for walk-ins).
            new XElement("Party",
                new XElement("PartyCode", ""),
                // FACTS' narration: the customer, and for a pre-approved discount its reason too (e.g. "Ahmed Complimentary"), as Polaris sends it.
                new XElement("PartyName", o.PreapprovedLabel is { } pl ? $"{o.CustomerName} {pl}" : o.CustomerName ?? "Walk-in"), new XElement("MobileNo", o.CustomerPhone ?? ""),
                new XElement("TRNNumber", ""), new XElement("Telephone", ""), new XElement("Mobile", o.CustomerPhone ?? ""), new XElement("Email", ""),
                new XElement("VatCategory", "SR"), new XElement("VatRateType", "-1"),
                new XElement("BillToAddress", new XElement("Street", o.DeliveryAddress ?? ""), new XElement("City", ""), new XElement("State", ""), new XElement("Country", "AE"), new XElement("POBox", ""))),
            new XElement("DeliveryDetails", new XElement("EDD", o.BusinessDate.ToString("yyyy-MM-dd", Inv)), new XElement("DeliveryTiming", "")),
            // A delivery platform's order: its own order number, which One POS' procedure writes into SAL_REF1 (FACTS' own one ignores it).
            o.PlatformName is not null && !string.IsNullOrWhiteSpace(o.PlatformRef) ? new XElement("PlatformOrderNo", o.PlatformRef.Trim()) : null,
            receipts, details));
        return (xml.ToString(SaveOptions.DisableFormatting), problems, o);
    }

    /// <summary>A credit note as XML for the SR50 procedure the FACTS developer provides (proposed layout, agreed with them).</summary>
    private static async Task<(string Xml, string DocNo, decimal Amount)> CreditNoteAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid creditNoteId)
    {
        var n = await c.QuerySingleAsync<(string Number, Guid OrderId, DateOnly Day, string Reason, string Method, decimal Total, decimal Vat, string? CardType)>("""
            select n.number, n.order_id, n.business_date, n.reason, n.method, n.total, n.vat,
                   (select p.card_type from payment p where p.credit_note_id = n.id limit 1) from credit_note n where n.id = @creditNoteId
            """, new { creditNoteId }, tx);
        var o = await c.QuerySingleAsync<OrderInfo>($"{OrderSql} where o.id = @OrderId", new { n.OrderId }, tx);
        var refunded = (await c.QueryAsync<(string? Code, string? Type, string? Unit, decimal Qty, decimal Amount, decimal Vat, bool Restock, string Name, bool IsCombo, string Modifiers, decimal UnitPrice)>("""
            select i.erp_item_code, i.erp_item_type, i.erp_unit, cl.qty, cl.amount, cl.vat, cl.restock, l.name, coalesce(i.is_combo, false), l.modifiers::text, l.unit_price
            from credit_note_line cl join order_line l on l.id = cl.order_line_id left join menu_item i on i.id = l.item_id where cl.credit_note_id = @creditNoteId
            """, new { creditNoteId }, tx)).ToList();
        // A combo comes back as its items, as it was sold: the amount and VAT shared by their rates.
        var comboItems = await ComboItemsAsync(c, tx, refunded.Where(l => l.IsCombo).Select(l => l.Modifiers));
        var lines = refunded.SelectMany(l =>
        {
            var ps = Parts(l.Name, l.IsCombo, l.Modifiers, l.UnitPrice, l.Code, l.Type, l.Unit, comboItems);
            var weights = ps.Select(p => p.Rate).ToArray();
            var amount = Share(l.Amount, weights);
            var vat = Share(l.Vat, weights);
            return ps.Select((p, k) => (p.Code, p.Type, p.Unit, l.Qty, Amount: amount[k], Vat: vat[k], l.Restock));
        }).ToList();
        var xml = new XElement("data", new XElement("CreditNote",
            new XElement("CreditNoteNo", FactsNo(n.Number, o.DocPrefix) ?? n.Number), new XElement("CreditNoteDate", n.Day.ToString("yyyy-MM-dd", Inv)), new XElement("InvoiceNo", o.FactsNo ?? ""),
            new XElement("LocationCode", o.Location ?? ""), new XElement("NetAmount", N(n.Total)), new XElement("TotalVATAmount", N(n.Vat)), new XElement("Reason", n.Reason),
            lines.Select((l, i) => new XElement("Details", new XElement("ItemSrNo", i + 1), new XElement("ItemType", l.Type ?? ""), new XElement("ItemCode", l.Code ?? ""),
                new XElement("ItemQty", N(l.Qty, 3)), new XElement("ItemUnit", l.Unit ?? "PCS"), new XElement("ItemAmount", N(l.Amount)), new XElement("VATAmount", N(l.Vat)),
                new XElement("ReturnToStock", l.Restock ? "1" : "0"))),
            new XElement("ReceiptDetails", new XElement("ReceiptMode", n.Method == "card" ? n.CardType ?? "" : n.Method), new XElement("ReceiptAmount", N(n.Total)))));
        return (xml.ToString(SaveOptions.DisableFormatting), FactsNo(n.Number, o.DocPrefix) ?? n.Number, n.Total);
    }

    private static string RepackingLabel(string mode) => mode switch { "draft" => "Draft RPO50 per day", "posted" => "Posted RPO50 per bill", _ => "Off" };

    /// <summary>A bill was paid: into the queue where its branch posts from that business day on.</summary>
    public static async Task EnqueueInvoiceAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid orderId)
    {
        var due = await c.QuerySingleOrDefaultAsync<(Guid Branch, Guid Company, DateOnly Day)>("""
            select o.branch_id, o.company_id, o.business_date from pos_order o join branch b on b.id = o.branch_id join company co on co.id = o.company_id
            where o.id = @orderId and co.erp_connector = 'facts' and b.erp_location_code is not null and b.facts_post_from is not null and o.business_date >= b.facts_post_from
            """, new { orderId }, tx);
        if (due.Branch == Guid.Empty) return;
        var (xml, problems, o) = await InvoiceAsync(c, tx, orderId);
        await c.ExecuteAsync("""
            insert into erp_post (company_id, branch_id, kind, order_id, doc_no, business_date, amount, xml, status, last_error)
            values (@Company, @Branch, 'invoice', @orderId, @doc, @Day, @amount, @xml, @status, @error)
            on conflict (order_id) where kind = 'invoice' do update set xml = excluded.xml, status = excluded.status, last_error = excluded.last_error, next_try_at = now()
            """, new { due.Company, due.Branch, orderId, doc = o.FactsNo ?? o.InvoiceNo ?? "", due.Day, amount = o.Total, xml, status = problems.Count == 0 ? "pending" : "failed",
                       error = problems.Count == 0 ? null : string.Join(" ", problems) }, tx);
    }

    /// <summary>
    /// A branch's day of wastage still waiting for finance, as ONE draft STV50 (a line per entry) to its wastage location, where the
    /// company sends wastage as drafts: at the night's day close (or Send now). Entries whose item has no FACTS code stay for
    /// finance. Returns how many lines went into the draft.
    /// </summary>
    public static async Task<int> EnqueueWastageAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid branchId, DateOnly day)
    {
        var b = await c.QuerySingleOrDefaultAsync<(Guid Company, string Mode, string Connector, string? Loc, string? Waste, string? Prefix, string Code)>("""
            select b.company_id, co.facts_wastage, co.erp_connector, b.erp_location_code, b.erp_waste_location, b.facts_doc_prefix, b.code
            from branch b join company co on co.id = b.company_id where b.id = @branchId
            """, new { branchId }, tx);
        if (b.Mode != "draft" || b.Connector != "facts" || b.Loc is null || b.Waste is null) return 0;
        var lines = (await c.QueryAsync<(Guid Id, string? Code, string? Type, string Name, decimal Qty, string? Unit, decimal? Cost)>("""
            select w.id, i.erp_item_code, i.erp_item_type, w.name, w.qty, coalesce(i.erp_unit, w.unit), w.cost_value
            from wastage w left join menu_item i on i.id = w.item_id
            where w.branch_id = @branchId and w.business_date = @day and w.kind = 'wastage' and w.voided_at is null and w.erp_status = 'pending' and w.erp_post_id is null and w.approval = 'none'
            order by w.recorded_at for update of w
            """, new { branchId, day }, tx)).Where(l => l.Code is not null && l.Type is not null).ToList();
        if (lines.Count == 0) return 0;
        // The narration finance sees, and the key a retry finds the draft by (#2 only if the day is sent again, e.g. reopened).
        var n = 1 + await c.ExecuteScalarAsync<int>("select count(*)::int from erp_post where branch_id = @branchId and kind = 'wastage' and business_date = @day", new { branchId, day }, tx);
        var reference = $"One POS wastage {b.Code} {day:yyyy-MM-dd} #{n}";
        var xml = new XElement("data", new XElement("Transfer",
            new XElement("DocDate", day.ToString("yyyy-MM-dd", Inv)), new XElement("FromLocation", b.Loc), new XElement("ToLocation", b.Waste),
            new XElement("Reference", reference),
            lines.Select(l => new XElement("Line", new XElement("ItemType", l.Type), new XElement("ItemCode", l.Code), new XElement("ItemName", l.Name),
                new XElement("Qty", N(l.Qty, 3)), new XElement("Unit", l.Unit ?? "PCS")))));
        var postId = await c.ExecuteScalarAsync<Guid>("""
            insert into erp_post (company_id, branch_id, kind, doc_no, business_date, amount, xml, status)
            values (@Company, @branchId, 'wastage', @reference, @day, @amount, @xml, 'pending') returning id
            """, new { b.Company, branchId, reference, day, amount = lines.Sum(l => l.Cost ?? 0), xml = xml.ToString(SaveOptions.DisableFormatting) }, tx);
        await c.ExecuteAsync("update wastage set erp_post_id = @postId where id = any(@ids)", new { postId, ids = lines.Select(l => l.Id).ToArray() }, tx);
        return lines.Count;
    }

    /// <summary>A credit note was made: posted as SR50 where the company posts refunds and the bill itself was posted.</summary>
    public static async Task EnqueueRefundAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid creditNoteId, Guid orderId)
    {
        var co = await c.QuerySingleOrDefaultAsync<(string Refunds, string? Proc)>("""
            select co.facts_refunds, co.facts_refund_proc from pos_order o join company co on co.id = o.company_id where o.id = @orderId
            """, new { orderId }, tx);
        if (co.Refunds != "sr50") return;
        var inv = await c.QuerySingleOrDefaultAsync<(Guid Company, Guid Branch)>("select company_id, branch_id from erp_post where order_id = @orderId and kind = 'invoice'", new { orderId }, tx);
        if (inv.Branch == Guid.Empty) return;     // the bill itself wasn't posted (before the start date): nothing to credit in FACTS
        var (xml, doc, amount) = await CreditNoteAsync(c, tx, creditNoteId);
        var day = await c.ExecuteScalarAsync<DateOnly>("select business_date from credit_note where id = @creditNoteId", new { creditNoteId }, tx);
        await c.ExecuteAsync("""
            insert into erp_post (company_id, branch_id, kind, order_id, credit_note_id, doc_no, business_date, amount, xml, status, last_error)
            values (@Company, @Branch, 'refund', @orderId, @creditNoteId, @doc, @day, @amount, @xml, @status, @error)
            on conflict (credit_note_id) where kind = 'refund' do nothing
            """, new { inv.Company, inv.Branch, orderId, creditNoteId, doc, day, amount, xml, status = co.Proc is null ? "waiting" : "pending",
                       error = co.Proc is null ? "Waiting for the FACTS procedure that saves SR50 credit notes (from the FACTS developer)." : null }, tx);
    }

    public static void Map(RouteGroupBuilder api)
    {
        // Administration → FACTS posting: the company's switch and refunds, each branch's start date, what's in the queue.
        api.MapGet("/erp/posting", async (HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            RequireFinance(scope);
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var co = await c.QuerySingleAsync<(string Connector, bool Posting, string Refunds, string? Proc, string? InvoiceProc, string Wastage, string Repacking)>(
                    "select erp_connector, facts_posting, facts_refunds, facts_refund_proc, facts_invoice_proc, facts_wastage, facts_repacking from company where id = @id", new { id = scope.CompanyId }, tx);
                var branches = await c.QueryAsync<(Guid Id, string Code, string Name, string? Location, DateOnly? PostFrom, int Modes, int Cards)>("""
                    select b.id, b.code, b.name, b.erp_location_code, b.facts_post_from,
                           (select count(*) from erp_payment_mode m where m.branch_id = b.id)::int, (select count(*) from erp_payment_mode m where m.branch_id = b.id and m.kind = 'card')::int
                    from branch b order by b.code
                    """, transaction: tx);
                var counts = (await c.QueryAsync<(Guid Branch, string Status, int N)>("select branch_id, status, count(*)::int from erp_post group by branch_id, status", transaction: tx)).ToList();
                var modesRead = await c.QuerySingleOrDefaultAsync<(DateTime? At, bool? Ok, string? Message)>(
                    "select finished_at, ok, message from erp_sync where kind = 'payment_modes' order by started_at desc limit 1", transaction: tx);
                return new
                {
                    connector = co.Connector, posting = co.Posting, refunds = co.Refunds, refundProc = co.Proc, invoiceProc = co.InvoiceProc ?? StandardInvoiceProc, wastage = co.Wastage, repacking = co.Repacking,
                    modesReadAt = modesRead.At, modesReadOk = modesRead.Ok, modesReadError = modesRead.Message,
                    branches = branches.Select(b => new
                    {
                        b.Id, b.Code, b.Name, b.Location, b.PostFrom, paymentModes = b.Modes, cardTypes = b.Cards,
                        queue = counts.Where(x => x.Branch == b.Id).ToDictionary(x => x.Status, x => x.N),
                    }),
                };
            });
        });

        api.MapPut("/erp/posting/company", async (CompanyBody body, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.IsAdmin) throw new ForbiddenException("Only administrators switch posting to FACTS on or off.");
            if (body.Refunds is not ("none" or "sr50")) throw new DomainException("Refunds are not posted, or posted as SR50.");
            var proc = string.IsNullOrWhiteSpace(body.RefundProc) ? null : body.RefundProc.Trim();
            if (proc is not null && !ProcName().IsMatch(proc)) throw new DomainException("The SR50 procedure is a FACTS procedure name (letters, digits, _).");
            if (body.InvoiceProc is not (null or StandardInvoiceProc or FifoInvoiceProc)) throw new DomainException("Bills are saved by FACTS' standard procedure or One POS' (FIFO batches).");
            if (body.Wastage is not (null or "finance" or "draft")) throw new DomainException("Wastage is entered by finance, or sent as a draft STV50.");
            if (body.Repacking is not (null or "off" or "draft" or "posted")) throw new DomainException("BOM items' repacking is off, a draft RPO50 per day, or a posted RPO50 per bill.");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var old = await c.QuerySingleAsync<(bool Posting, string Refunds, string? Proc, string? InvoiceProc, string Wastage, string Repacking)>(
                    "select facts_posting, facts_refunds, facts_refund_proc, facts_invoice_proc, facts_wastage, facts_repacking from company where id = @id", new { id = scope.CompanyId }, tx);
                var wastage = body.Wastage ?? old.Wastage;
                var repacking = body.Repacking ?? old.Repacking;
                var invoiceProc = body.InvoiceProc is null ? old.InvoiceProc : body.InvoiceProc == StandardInvoiceProc ? null : body.InvoiceProc;
                await c.ExecuteAsync("update company set facts_posting = @Posting, facts_refunds = @Refunds, facts_refund_proc = @proc, facts_invoice_proc = @invoiceProc, facts_wastage = @wastage, facts_repacking = @repacking where id = @id",
                    new { body.Posting, body.Refunds, proc, invoiceProc, wastage, repacking, id = scope.CompanyId }, tx);
                // A procedure now there: credit notes that waited for it can go.
                if (proc is not null) await c.ExecuteAsync("update erp_post set status = 'pending', last_error = null, next_try_at = now() where kind = 'refund' and status = 'waiting'", transaction: tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, null, scope.UserId, "erp", "posting", "changed", "FACTS posting settings changed",
                    [new("Posting", old.Posting, body.Posting), new("Refunds", old.Refunds, body.Refunds), new("SR50 procedure", old.Proc, proc),
                     new("Bill procedure", old.InvoiceProc ?? StandardInvoiceProc, invoiceProc ?? StandardInvoiceProc),
                     new("Wastage", old.Wastage == "draft" ? "Draft STV from One POS" : "Finance enters", wastage == "draft" ? "Draft STV from One POS" : "Finance enters"),
                     new("BOM repacking", RepackingLabel(old.Repacking), RepackingLabel(repacking))]);
                return 0;
            });
            return Results.Ok(new { ok = true });
        });

        api.MapPut("/erp/posting/branch/{id:guid}", async (Guid id, BranchBody body, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            if (!scope.IsAdmin) throw new ForbiddenException("Only administrators set when a branch starts posting to FACTS.");
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var b = await c.QuerySingleOrDefaultAsync<(string Code, string? Location, DateOnly? Old)>("select code, erp_location_code, facts_post_from from branch where id = @id", new { id }, tx);
                if (b.Code is null) throw new NotFoundException("Branch not found.");
                if (body.PostFrom is not null && b.Location is null) throw new DomainException("Choose the branch's FACTS location first (Companies & branches).");
                await c.ExecuteAsync("update branch set facts_post_from = @PostFrom where id = @id", new { body.PostFrom, id }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, id, scope.UserId, "branch", id.ToString(), "facts-posting", $"FACTS posting for {b.Code}",
                    [new("Posts from", b.Old?.ToString("yyyy-MM-dd"), body.PostFrom?.ToString("yyyy-MM-dd"))]);
                return 0;
            });
            return Results.Ok(new { ok = true });
        });

        // The dry run: a day's paid bills of this branch as they would go to FACTS, nothing sent or queued.
        api.MapGet("/erp/posting/preview", async (HttpContext http, Db db, DateOnly date) =>
        {
            var scope = await http.ScopeAsync(db);
            RequireFinance(scope);
            return await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var ids = await c.QueryAsync<Guid>("""
                    select id from pos_order where branch_id = @b and business_date = @date and status in ('paid','refunded') and invoice_no is not null order by closed_at
                    """, new { b = scope.Branch, date }, tx);
                var bills = new List<object>();
                decimal total = 0, vat = 0;
                var problems = 0;
                foreach (var id in ids)
                {
                    var (xml, p, o) = await InvoiceAsync(c, tx, id);
                    total += o.Total; vat += o.Vat;
                    if (p.Count > 0) problems++;
                    bills.Add(new { o.Id, invoiceNo = o.InvoiceNo, factsNo = o.FactsNo, o.Total, o.Vat, problems = p, xml });
                }
                return new { date, bills = bills.Count, total, vat, withProblems = problems, items = bills };
            });
        });

        api.MapGet("/erp/posting/log", async (HttpContext http, Db db, string? status, int? take) =>
        {
            var scope = await http.ScopeAsync(db);
            RequireFinance(scope);
            return await db.Company(scope.CompanyId, (c, tx) => c.QueryAsync<(Guid Id, string Kind, string DocNo, DateOnly BusinessDate, decimal Amount, string Status, int Attempts, string? LastError, string? FactsDoc, DateTime CreatedAt, DateTime? PostedAt, string? BatchNote)>("""
                select id, kind, doc_no, business_date, amount, status, attempts, last_error, facts_doc, created_at, posted_at, batch_note from erp_post
                where branch_id = @b and (@status is null or status = @status) order by created_at desc limit @take
                """, new { b = scope.Branch, status, take = Math.Clamp(take ?? 100, 1, 500) }, tx)
                .ContinueWith(t => t.Result.Select(x => new { x.Id, x.Kind, x.DocNo, x.BusinessDate, x.Amount, x.Status, x.Attempts, x.LastError, x.FactsDoc, x.CreatedAt, x.PostedAt, x.BatchNote })));
        });

        api.MapGet("/erp/posting/{id:guid}/xml", async (Guid id, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            RequireFinance(scope);
            var xml = await db.Company(scope.CompanyId, (c, tx) => c.ExecuteScalarAsync<string?>("select xml from erp_post where id = @id", new { id }, tx)) ?? throw new NotFoundException("Not in the queue.");
            return Results.Ok(new { xml });
        });

        // Try again (an invoice is built afresh, e.g. after an item got its FACTS code), or leave it out (finance enters it by hand).
        api.MapPost("/erp/posting/{id:guid}/retry", async (Guid id, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            RequireFinance(scope);
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var status = await c.ExecuteScalarAsync<string?>("select status from erp_post where id = @id for update", new { id }, tx)
                             ?? throw new NotFoundException("Not in the queue.");
                if (status == "posted") throw new DomainException("Already posted.");
                await RequeueAsync(c, tx, id);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "erp_post", id.ToString(), "retry", "FACTS posting re-pushed");
                return 0;
            });
            Sender.Wake();
            return Results.Ok(new { ok = true });
        });

        // Push now: what waits for its next try goes at once; with `failed`, every failed bill of the branch is re-pushed too
        // (rebuilt first, so a fixed item code or card type goes with it).
        api.MapPost("/erp/posting/push", async (PushBody body, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            RequireFinance(scope);
            var n = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                if (!await c.ExecuteScalarAsync<bool>("select facts_posting from company where id = @id", new { id = scope.CompanyId }, tx))
                    throw new DomainException("Posting to FACTS is off. An administrator switches it on first.");
                var failed = body.Failed
                    ? (await c.QueryAsync<Guid>("select id from erp_post where branch_id = @b and status = 'failed' for update", new { b = scope.Branch }, tx)).ToList()
                    : [];
                foreach (var id in failed) await RequeueAsync(c, tx, id);
                var waiting = await c.ExecuteAsync("update erp_post set next_try_at = now() where branch_id = @b and status = 'pending'", new { b = scope.Branch }, tx);
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "erp_post", null, "pushed",
                    body.Failed ? $"FACTS posting: {failed.Count} failed re-pushed, {waiting} sent now" : $"FACTS posting: {waiting} sent now");
                return new { failed = failed.Count, sent = waiting };
            });
            Sender.Wake();
            return Results.Ok(n);
        });

        api.MapPost("/erp/posting/{id:guid}/skip", async (Guid id, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db);
            RequireFinance(scope);
            await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var n = await c.ExecuteAsync("update erp_post set status = 'skipped' where id = @id and status <> 'posted'", new { id }, tx);
                if (n == 0) throw new DomainException("Not found, or already posted.");
                await Audit.RecordAsync(c, tx, scope.CompanyId, scope.Branch, scope.UserId, "erp_post", id.ToString(), "skipped", "FACTS posting left out (finance enters it)");
                return 0;
            });
            return Results.Ok(new { ok = true });
        });
    }

    /// <summary>Finance (facts.post) or whoever manages the branch: the posting log, push and re-push.</summary>
    private static void RequireFinance(Scope scope)
    {
        if (!scope.Can("facts.post")) scope.Require("branch.manage");
    }

    public sealed record PushBody(bool Failed);

    /// <summary>A queued document back to "waiting to send", now: a bill rebuilt from the order (its problems, if any, fail it again).</summary>
    private static async Task RequeueAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid id)
    {
        var row = await c.QuerySingleAsync<(string Kind, Guid OrderId)>("select kind, order_id from erp_post where id = @id", new { id }, tx);
        if (row.Kind == "invoice")
        {
            var (xml, problems, o) = await InvoiceAsync(c, tx, row.OrderId);
            await c.ExecuteAsync("update erp_post set xml = @xml, doc_no = @doc, status = @status, last_error = @error, attempts = 0, next_try_at = now() where id = @id",
                new { id, xml, doc = o.FactsNo ?? o.InvoiceNo ?? "", status = problems.Count == 0 ? "pending" : "failed", error = problems.Count == 0 ? null : string.Join(" ", problems) }, tx);
        }
        else await c.ExecuteAsync("update erp_post set status = 'pending', attempts = 0, last_error = null, next_try_at = now() where id = @id", new { id }, tx);   // a refund, a wastage draft
    }

    /// <summary>
    /// The sender: every 30 seconds, the queue of companies with posting switched on goes to FACTS (oldest first). A FACTS "FAILED"
    /// answer or an error waits longer each time (1, 2, 4 … up to 60 minutes) and is shown in the log; 10 failures stop it until retried.
    /// </summary>
    public sealed class Sender(ErpConnections erp, Db db, ILogger<Sender> logger) : BackgroundService
    {
        private static readonly SemaphoreSlim Signal = new(0);
        /// <summary>Something was pushed: send now instead of at the next 30-second turn.</summary>
        public static void Wake() { if (Signal.CurrentCount == 0) Signal.Release(); }

        protected override async Task ExecuteAsync(CancellationToken stop)
        {
            while (!stop.IsCancellationRequested)
            {
                try
                {
                    var companies = await db.Platform((c, tx) => c.QueryAsync<Guid>("select id from company where erp_connector = 'facts' and facts_posting and is_active", transaction: tx));
                    foreach (var co in companies) await SendAsync(co, stop);
                }
                catch (Exception e) when (e is not OperationCanceledException) { logger.LogWarning(e, "FACTS posting round failed"); }
                try { await Signal.WaitAsync(TimeSpan.FromSeconds(30), stop); } catch (OperationCanceledException) { break; }
            }
        }

        private async Task SendAsync(Guid companyId, CancellationToken stop)
        {
            var due = (await db.Company(companyId, (c, tx) => c.QueryAsync<(Guid Id, string Kind, string Xml, int Attempts, string? Proc, string? InvoiceProc, Guid? OrderId, string? FactsUser)>("""
                select p.id, p.kind, p.xml, p.attempts, co.facts_refund_proc, co.facts_invoice_proc, p.order_id, p.facts_user from erp_post p join branch b on b.id = p.branch_id join company co on co.id = p.company_id
                where p.status = 'pending' and p.next_try_at <= now() and b.facts_post_from is not null and co.facts_posting
                order by p.created_at, p.kind <> 'repacking' limit 50
                """, transaction: tx))).ToList();
            if (due.Count == 0) return;
            var cs = await erp.GetAsync(companyId);
            if (cs is null) return;
            await using var f = new SqlConnection(new SqlConnectionStringBuilder(cs) { ApplicationName = "One POS posting" }.ConnectionString);
            await f.OpenAsync(stop);
            foreach (var p in due)
            {
                // A bill with BOM items waits for its own repacking voucher: the sale takes the batch that voucher brings in.
                if (p.Kind == "invoice" && p.OrderId is { } billId && await db.Company(companyId, (c, tx) => c.ExecuteScalarAsync<bool>(
                        "select exists (select 1 from erp_post where kind = 'repacking' and order_id = @billId and status not in ('posted', 'skipped'))", new { billId }, tx)))
                    continue;
                string status, error = "", doc = "";
                string? batchNote = null;
                try
                {
                    var proc = p.Kind == "invoice" ? p.InvoiceProc is FifoInvoiceProc ? FifoInvoiceProc : StandardInvoiceProc
                        : p.Kind == "wastage" ? p.FactsUser is null ? WastageProc : PostWastageProc
                        : p.Kind == "marketing" ? p.FactsUser is null ? throw new InvalidOperationException("Marketing needs a FACTS user to post it.") : PostConsumptionProc
                        : p.Kind == "return" ? p.FactsUser is null ? throw new InvalidOperationException("A return needs the approver's FACTS username.") : PostWastageProc
                        : p.Kind == "repacking" ? p.OrderId is null ? Pos.Boms.RepackingProc : Pos.Boms.PostRepackingProc
                        : p.Proc is { } rp && ProcName().IsMatch(rp) ? rp : throw new InvalidOperationException("No SR50 procedure set.");
                    await using var cmd = new SqlCommand(proc, f) { CommandType = CommandType.StoredProcedure, CommandTimeout = 120 };
                    cmd.Parameters.AddWithValue("@ClientID", p.FactsUser ?? (p.Kind is "wastage" or "repacking" ? WastageUser : "ONEPOS"));
                    cmd.Parameters.Add("@BodyXML", SqlDbType.Xml).Value = p.Xml;
                    await using var r = await cmd.ExecuteReaderAsync(stop);
                    // FACTS answers DocumentNo / status / description, possibly more than once (its posting step answers too).
                    var failed = false;
                    do
                    {
                        while (await r.ReadAsync(stop))
                        {
                            var cols = Enumerable.Range(0, r.FieldCount).ToDictionary(i => r.GetName(i), i => r.IsDBNull(i) ? "" : Convert.ToString(r.GetValue(i), Inv) ?? "", StringComparer.OrdinalIgnoreCase);
                            if (cols.TryGetValue("DocumentNo", out var d)) doc = d;
                            if (cols.TryGetValue("status", out var s) && s.Equals("FAILED", StringComparison.OrdinalIgnoreCase)) { failed = true; error = cols.GetValueOrDefault("description") ?? "FACTS said FAILED."; }
                            // One POS' procedure: how many lines got their batch (FIFO), and any left without.
                            if (cols.TryGetValue("OnePosBatches", out var given))
                                batchNote = $"Batches given (FIFO): {given} line{(given == "1" ? "" : "s")}." + (cols.GetValueOrDefault("OnePosNote") is { Length: > 0 } note ? $" {note}" : "");
                        }
                    } while (await r.NextResultAsync(stop));
                    status = failed ? "failed" : "posted";
                }
                catch (Exception e) when (e is SqlException or InvalidOperationException)
                {
                    status = "failed"; error = e.Message.Split('\n')[0];
                }
                var attempts = p.Attempts + 1;
                var retry = status == "failed" && attempts < 10;
                await db.Company(companyId, (c, tx) => c.ExecuteAsync("""
                    update erp_post set status = @final, attempts = @attempts, last_error = nullif(@error, ''), facts_doc = nullif(@doc, ''), batch_note = coalesce(@batchNote, batch_note),
                      posted_at = case when @final = 'posted' then now() else posted_at end,
                      next_try_at = now() + make_interval(mins => least(60, power(2, @attempts - 1)::int))
                    where id = @Id
                    """, new { final = retry ? "pending" : status, attempts, error, doc, batchNote, p.Id }, tx));
                // Wastage: approved wastage was POSTED in FACTS (counted there from now on); a day's draft STV50 waits for finance.
                // Marketing: the approved give-aways were POSTED in FACTS as an MCV50.
                if (p.Kind is "wastage" or "marketing" && status == "posted" && doc != "")
                    await db.Company(companyId, (c, tx) => c.ExecuteAsync("""
                        update wastage set erp_status = case when @posted then 'posted' else 'draft' end, erp_doc = @stv,
                          erp_matched_at = case when @posted then now() else erp_matched_at end
                        where erp_post_id = @Id and voided_at is null
                        """, new { stv = $"{(p.Kind == "marketing" ? "MCV50" : "STV50")} {doc}", posted = p.FactsUser is not null, p.Id }, tx));
                if (p.Kind is "wastage" or "marketing" && p.FactsUser is not null && status == "failed" && !retry)
                    await db.Company(companyId, (c, tx) => c.ExecuteAsync("update wastage set erp_status = 'failed' where erp_post_id = @Id and voided_at is null", new { p.Id }, tx));
                // A return to the factory: posted in FACTS (the STV50 back to the delivery's from-location), or given up on.
                if (p.Kind == "return" && status == "posted" && doc != "")
                    await db.Company(companyId, (c, tx) => c.ExecuteAsync(
                        "update stock_return set erp_status = 'posted', erp_doc = @stv, erp_posted_at = now() where erp_post_id = @Id", new { stv = $"STV50 {doc}", p.Id }, tx));
                if (p.Kind == "return" && status == "failed" && !retry)
                    await db.Company(companyId, (c, tx) => c.ExecuteAsync("update stock_return set erp_status = 'failed' where erp_post_id = @Id", new { p.Id }, tx));
                if (status == "failed") logger.LogWarning("Posting {Kind} {Id} to FACTS failed: {Error}", p.Kind, p.Id, error);
            }
        }
    }
}
