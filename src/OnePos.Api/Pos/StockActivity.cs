using System.Text.Json;
using System.Text.Json.Serialization;
using Dapper;
using Microsoft.Data.SqlClient;
using OnePos.Api.Data;
using OnePos.Api.Erp;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// Stock activity report (anyone who sees reports): what the branch threw away, gave away (marketing), asked the stores for, received
/// and sent back, over a range of business days, one row per line. Deliveries are read from FACTS (read-only), the rest is One POS'
/// own. Admin and finance also see the value of wastage, marketing and returns: quantity × the item's latest FACTS batch landed cost,
/// read from FACTS when the report opens (today's cost, not the cost on the day).
/// </summary>
public static class StockActivity
{
    public sealed class Line
    {
        public DateOnly Date { get; set; }
        public string Branch { get; set; } = "";
        /// <summary>The One POS document (REQ-12) or the FACTS one (STV50 8114) the line is on.</summary>
        public string? Doc { get; set; }
        public string? Code { get; set; }
        public string Item { get; set; } = "";
        public string? Unit { get; set; }
        /// <summary>Wasted / given / approved (requests) / sent (deliveries) / returned.</summary>
        public decimal Qty { get; set; }
        /// <summary>What was asked, when the approver changed it (and every request line).</summary>
        public decimal? Requested { get; set; }
        /// <summary>Deliveries: what arrived (null = not checked in). Requests: what the store sent so far (null = none read from FACTS).</summary>
        public decimal? Received { get; set; }
        /// <summary>Where it came from or goes to: the store (requests), the sending location (deliveries), the location returned to.</summary>
        public string? Place { get; set; }
        public string? Reason { get; set; }
        public string? Note { get; set; }
        public string? By { get; set; }
        public string? ApprovedBy { get; set; }
        public string Status { get; set; } = "";
        public string? FactsDoc { get; set; }
        public decimal? Value { get; set; }
        /// <summary>Requests: the line's number on the STR50 (to match what FACTS delivered against it).</summary>
        [JsonIgnore] public int StrLine { get; set; }
    }

    private static readonly string[] Kinds = ["wastage", "marketing", "requests", "deliveries", "returns"];

    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/reports/stock-activity", async (HttpContext http, Db db, FactsSync facts, string kind, DateOnly from, DateOnly to, string? branches) =>
        {
            var scope = await http.ScopeAsync(db);
            scope.Require("reports.view");
            if (!Kinds.Contains(kind)) throw new DomainException("Choose wastage, marketing, requests, deliveries or returns.");
            var (f, t) = from <= to ? (from, to) : (to, from);
            if (t.DayNumber - f.DayNumber > 366) throw new DomainException("Choose at most a year.");
            var showValue = scope.Can("facts.post") && kind is "wastage" or "marketing" or "returns";
            var (lines, places) = await db.Company(scope.CompanyId, async (c, tx) =>
            {
                var ids = branches == "all"
                    ? (await c.QueryAsync<Guid>("""
                        select b.id from branch b where @admin or exists (select 1 from user_branch ub where ub.branch_id = b.id and ub.user_id = @u)
                        """, new { admin = scope.IsAdmin, u = scope.UserId }, tx)).ToArray()
                    : [scope.Branch];
                var args = new { ids, f, t, kind = kind == "marketing" ? "marketing" : "wastage" };
                var lines = kind switch
                {
                    // A line's status: voided, waiting for / refused by its approver, then where it is in FACTS.
                    "wastage" or "marketing" => (await c.QueryAsync<Line>("""
                        select w.business_date as date, b.code as branch, i.erp_item_code as code, w.name as item, w.unit, w.qty, w.requested_qty as requested,
                               w.reason, w.note, u.display_name as "by", d.display_name as approved_by, w.erp_doc as facts_doc,
                               case when w.voided_at is not null then 'Voided' when w.approval = 'waiting' then 'Waiting approval' when w.approval = 'rejected' then 'Rejected'
                                    when w.erp_status = 'posted' then 'Posted' when w.erp_status = 'draft' then 'Draft in FACTS' when w.erp_status = 'failed' then 'FACTS failed'
                                    when w.erp_status = 'pending' then 'Waiting for FACTS' else 'Recorded' end as status
                        from wastage w join branch b on b.id = w.branch_id join app_user u on u.id = w.recorded_by
                        left join app_user d on d.id = w.decided_by left join menu_item i on i.id = w.item_id
                        where w.branch_id = any(@ids) and w.business_date between @f and @t and w.kind = @kind
                        order by w.business_date, w.recorded_at
                        """, args, tx)).ToList(),
                    "returns" => (await c.QueryAsync<Line>("""
                        select r.business_date as date, b.code as branch, r.delivery_doc_type || ' ' || r.delivery_doc_no as doc, r.item_code as code, r.item_name as item, r.unit,
                               r.qty, r.requested_qty as requested, r.to_location as place,
                               case when r.source = 'variance' then 'Short delivery' else r.reason end as reason, r.note,
                               u.display_name as "by", d.display_name as approved_by, r.erp_doc as facts_doc,
                               case when r.approval = 'waiting' then 'Waiting approval' when r.approval = 'rejected' then 'Rejected' when r.approval = 'cancelled' then 'Cancelled'
                                    when r.erp_status = 'posted' then 'Posted' when r.erp_status = 'failed' then 'FACTS failed' when r.erp_status = 'pending' then 'Waiting for FACTS'
                                    else 'Approved' end as status
                        from stock_return r join branch b on b.id = r.branch_id join app_user u on u.id = r.recorded_by left join app_user d on d.id = r.decided_by
                        where r.branch_id = any(@ids) and r.business_date between @f and @t
                        order by r.business_date, r.recorded_at
                        """, args, tx)).ToList(),
                    "requests" => (await c.QueryAsync<Line>("""
                        select r.business_date as date, b.code as branch, 'REQ-' || r.number as doc, l.item_code as code, l.item_name as item, l.unit,
                               l.qty, coalesce(l.requested_qty, l.qty) as requested, r.store_name as place, r.note,
                               u.display_name as "by", d.display_name as approved_by, r.erp_doc as facts_doc,
                               case when r.approval = 'waiting' then 'Waiting approval' when r.approval = 'rejected' then 'Rejected' when r.approval = 'cancelled' then 'Cancelled'
                                    when r.erp_status = 'posted' then 'Posted' when r.erp_status = 'failed' then 'FACTS failed' when r.erp_status = 'pending' then 'Waiting for FACTS'
                                    else 'Approved' end as status,
                               coalesce(l.str_line, l.line) as str_line
                        from stock_request r join stock_request_line l on l.request_id = r.id join branch b on b.id = r.branch_id
                        join app_user u on u.id = r.requested_by left join app_user d on d.id = r.decided_by
                        where r.branch_id = any(@ids) and r.business_date between @f and @t
                        order by r.business_date, r.number, l.line
                        """, args, tx)).ToList(),
                    _ => [],
                };
                // Deliveries: the branches' FACTS locations, and their check-ins (what arrived differently).
                var places = kind == "deliveries"
                    ? (await c.QueryAsync<(Guid Id, string Code, string Loc)>("select id, code, erp_location_code from branch where id = any(@ids) and erp_location_code is not null", args, tx)).ToList()
                    : [];
                return (lines, places);
            });

            if (kind == "requests") await DeliveredAsync(lines, facts, scope.CompanyId);
            if (kind == "deliveries") lines = await DeliveriesAsync(facts, db, scope.CompanyId, places, f, t);
            if (showValue) await ValueAsync(lines, facts, scope.CompanyId);
            return Results.Ok(new { kind, from = f, to = t, showValue, lines });
        });
    }

    /// <summary>Requests: what the store sent against each posted STR50 line (FACTS adds every delivery made against it).</summary>
    private static async Task DeliveredAsync(List<Line> lines, FactsSync facts, Guid companyId)
    {
        var got = await StockRequests.DeliveredAsync(facts, companyId, lines.Select(l => l.FactsDoc));
        foreach (var l in lines)
            if (l.FactsDoc is { } d && got.TryGetValue((d, l.StrLine), out var q)) l.Received = q;
    }

    private sealed record Head(string DocType, string DocNo, DateTime DocDate, string Loc, string From, string? FromName);
    private sealed record DetLine(string DocType, string DocNo, int SrNo, string Code, string Name, decimal Qty, string? Unit);

    /// <summary>Deliveries into the branches' FACTS locations in these days (transfers that move stock), line by line, with what was checked in.</summary>
    private static async Task<List<Line>> DeliveriesAsync(FactsSync facts, Db db, Guid companyId, List<(Guid Id, string Code, string Loc)> places, DateOnly f, DateOnly t)
    {
        if (places.Count == 0) return [];
        var locs = places.Select(p => p.Loc).Distinct().ToArray();
        List<Head> heads;
        List<DetLine> dets;
        await using (var fc = await facts.OpenAsync(companyId))
        {
            var args = new { locs, f = f.ToDateTime(TimeOnly.MinValue), t = t.AddDays(1).ToDateTime(TimeOnly.MinValue) };
            heads = (await fc.QueryAsync<Head>("""
                select h.TSF_DOCTYPE as DocType, h.TSF_DOCNO as DocNo, h.TSF_DOCDATE as DocDate, ltrim(rtrim(h.TSF_LOCATION_TO_DOCNO)) as Loc,
                       ltrim(rtrim(h.TSF_LOCATION_FM_DOCNO)) as [From], l.LOC_DESC as FromName
                from TRANSFER_HEADER h left join LOCATION_MASTER l on l.LOC_DOCNO = h.TSF_LOCATION_FM_DOCNO
                left join DOCUMENT_MASTER dm on dm.DM_DOCNO = h.TSF_DOCTYPE
                where h.TSF_LOCATION_TO_DOCNO in @locs and h.TSF_DOCDATE >= @f and h.TSF_DOCDATE < @t and isnull(dm.DM_UPDATE_STOCK, 0) = 1
                """, args, commandTimeout: 60)).ToList();
            dets = heads.Count == 0 ? [] : (await fc.QueryAsync<DetLine>("""
                select d.TSFDET_DOCTYPE as DocType, d.TSFDET_DOCNO as DocNo, d.TSFDET_DOCSRNO as SrNo, ltrim(rtrim(d.TSFDET_STOCK_DOCNO)) as Code,
                       d.TSFDET_STOCK_DESC as Name, d.TSFDET_QTY as Qty, d.TSFDET_UNIT_DOCNO as Unit
                from TRANSFER_DETAILS d join TRANSFER_HEADER h on h.TSF_FYCODE = d.TSFDET_FYCODE and h.TSF_DOCTYPE = d.TSFDET_DOCTYPE and h.TSF_DOCNO = d.TSFDET_DOCNO
                left join DOCUMENT_MASTER dm on dm.DM_DOCNO = h.TSF_DOCTYPE
                where h.TSF_LOCATION_TO_DOCNO in @locs and h.TSF_DOCDATE >= @f and h.TSF_DOCDATE < @t and isnull(dm.DM_UPDATE_STOCK, 0) = 1
                """, args, commandTimeout: 60)).ToList();
        }
        var ids = places.Select(p => p.Id).ToArray();
        var checks = (await db.Company(companyId, (c, tx) => c.QueryAsync<(Guid BranchId, string DocType, string DocNo, string By, bool AllOk, string? Differences)>("""
            select d.branch_id, d.erp_doc_type, d.erp_doc_no, u.display_name, d.all_ok, d.differences::text
            from delivery_check d join app_user u on u.id = d.checked_by where d.branch_id = any(@ids)
            """, new { ids }, tx))).ToDictionary(x => (x.BranchId, x.DocType.Trim(), x.DocNo.Trim()));
        var lines = new List<Line>();
        foreach (var h in heads.OrderBy(h => h.DocDate))
        {
            // A location shared by two branches is listed under each (rare); normally it's one branch.
            foreach (var p in places.Where(p => p.Loc.Trim() == h.Loc))
            {
                checks.TryGetValue((p.Id, h.DocType.Trim(), h.DocNo.Trim()), out var k);
                var diffs = k.Differences is null ? [] : JsonSerializer.Deserialize<Stock.Difference[]>(k.Differences, JsonSerializerOptions.Web) ?? [];
                foreach (var d in dets.Where(d => d.DocType == h.DocType && d.DocNo == h.DocNo).OrderBy(d => d.SrNo))
                {
                    var diff = diffs.FirstOrDefault(x => x.Line == d.SrNo) ?? diffs.FirstOrDefault(x => x.Line is null && string.Equals(x.Code?.Trim(), d.Code, StringComparison.OrdinalIgnoreCase));
                    decimal? received = k.By is null ? null : diff?.Received ?? d.Qty;
                    lines.Add(new Line
                    {
                        Date = DateOnly.FromDateTime(h.DocDate), Branch = p.Code, Doc = $"{h.DocType.Trim()} {h.DocNo.Trim()}", Code = d.Code, Item = d.Name.Trim(), Unit = d.Unit?.Trim(),
                        Qty = d.Qty, Received = received, Place = h.FromName?.Trim() ?? h.From, Note = diff?.Note, By = k.By,
                        Status = k.By is null ? "Not checked in" : received < d.Qty ? "Short" : "Received",
                    });
                }
            }
        }
        return lines;
    }

    /// <summary>Value at each item's latest FACTS batch landed cost (blank when FACTS has none, or FACTS can't be reached).</summary>
    private static async Task ValueAsync(List<Line> lines, FactsSync facts, Guid companyId)
    {
        var codes = lines.Select(l => l.Code?.Trim()).OfType<string>().Where(x => x.Length > 0).Distinct().ToArray();
        if (codes.Length == 0) return;
        Dictionary<string, decimal> cost;
        try
        {
            await using var fc = await facts.OpenAsync(companyId);
            cost = (await fc.QueryAsync<(string Code, decimal? Cost)>("""
                select ltrim(rtrim(m.STKMST_DOCNO)),
                       coalesce((select top 1 b.BATMST_LANDED_COST_RATE from STOCK_BATCH_MASTER b where b.BATMST_STOCK_DOCNO = m.STKMST_DOCNO and b.BATMST_LANDED_COST_RATE > 0
                                 order by b.BATMST_SDOCDATE desc), nullif(m.STKMST_LAST_LANDED_COST, 0))
                from STOCK_MASTER m where ltrim(rtrim(m.STKMST_DOCNO)) in (select value from string_split(@codes, ','))
                """, new { codes = string.Join(',', codes) }, commandTimeout: 60))
                .Where(x => x.Cost is not null).GroupBy(x => x.Code, StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.Max(x => x.Cost!.Value), StringComparer.OrdinalIgnoreCase);
        }
        catch (Exception e) when (e is SqlException or InvalidOperationException) { return; }   // FACTS away: the report shows without values
        foreach (var l in lines)
            if (l.Code?.Trim() is { } code && cost.TryGetValue(code, out var unit) && l.Status is not ("Voided" or "Rejected" or "Cancelled"))
                l.Value = Money.Round(l.Qty * unit);
    }
}
