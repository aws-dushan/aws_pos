using System.Globalization;
using Dapper;
using Npgsql;
using OnePos.Api.Data;

namespace OnePos.Api.Platform;

/// <summary>
/// Shared number series (administrators, Companies &amp; branches → the company): invoices (INV) and credit notes (CN) can each run
/// as one plain number sequence for all the company's branches, from a set date and time and a starting number. The numbers go to
/// FACTS unchanged (POS51 / PSR51 document numbers), so a starting number must be above every plain number already used in One
/// POS and in FACTS for that document (e.g. Polaris' bills); once the first shared number is given the start can't change.
/// </summary>
public static class NumberSeries
{
    public sealed record Body(string Series, bool Shared, string? From, long? Start, string? Prefix = null);

    /// <summary>A shared number as written: plain (200000), or the prefix and at least 6 digits (CN000001, CN-1000000).</summary>
    public static string Format(string? prefix, long n) =>
        string.IsNullOrEmpty(prefix) ? n.ToString(CultureInfo.InvariantCulture) : prefix + n.ToString("000000", CultureInfo.InvariantCulture);

    private sealed class Row
    {
        public string Series { get; set; } = "";
        public bool Shared { get; set; }
        public DateTime? FromAt { get; set; }
        public string? Prefix { get; set; }
        public long? StartNo { get; set; }
        public long? NextNo { get; set; }
        public DateTime? FirstAt { get; set; }
    }

    // The highest number already used with a prefix ('' = plain numbers): the digits after it, in One POS and in FACTS. A prefix
    // is letters, digits and dashes only, so it is safe inside the pattern; branch numbers (CN-EBL-01-000001) never match "CN-" + digits.
    private static readonly Dictionary<string, (string Label, string FactsType, string Sql)> Kinds = new()
    {
        ["INV"] = ("Invoices", "POS51", "select max(substr(invoice_no, length(@p) + 1)::bigint) from pos_order where invoice_no ~ ('^' || @p || '[0-9]{1,12}$')"),
        ["CN"] = ("Credit notes", "PSR51", "select max(substr(number, length(@p) + 1)::bigint) from credit_note where number ~ ('^' || @p || '[0-9]{1,12}$')"),
    };
    private const string FactsSql = """
        select max(try_convert(bigint, substring(SAL_DOCNO, len(@p) + 1, 20))) from dbo.SALES_HEADER with (nolock)
        where SAL_DOCTYPE = @type and left(SAL_DOCNO, len(@p)) = @p and len(SAL_DOCNO) - len(@p) between 1 and 12
          and substring(SAL_DOCNO, len(@p) + 1, 20) not like '%[^0-9]%'
        """;

    /// <summary>The company's time zone for the start time: its branches' (all the same in practice), Dubai when it has none.</summary>
    private static async Task<TimeZoneInfo> ZoneAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid companyId) =>
        BusinessClock.Zone(await c.ExecuteScalarAsync<string?>("select time_zone from branch where company_id = @companyId order by is_active desc, code limit 1",
            new { companyId }, tx) ?? "Asia/Dubai");

    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/companies/{companyId:guid}/number-series", async (Guid companyId, HttpContext http, Db db) =>
        {
            var scope = await http.ScopeAsync(db, companyId);
            if (!scope.IsAdmin) throw new ForbiddenException("Only administrators set the invoice and credit note numbers.");
            return Results.Ok(await db.Company(companyId, async (c, tx) =>
            {
                var zone = await ZoneAsync(c, tx, companyId);
                var rows = (await c.QueryAsync<Row>("select * from company_number_series where company_id = @companyId", new { companyId }, tx)).ToDictionary(r => r.Series);
                var list = new List<object>();
                foreach (var (series, k) in Kinds)
                {
                    rows.TryGetValue(series, out var r);
                    var highest = await c.ExecuteScalarAsync<long?>(k.Sql, new { p = r?.Prefix ?? "" }, tx);
                    list.Add(new
                    {
                        series, k.Label, k.FactsType, shared = r?.Shared ?? false,
                        from = r?.FromAt is DateTime f ? TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(f, DateTimeKind.Utc), zone).ToString("yyyy-MM-dd'T'HH:mm", CultureInfo.InvariantCulture) : null,
                        prefix = r?.Prefix, start = r?.StartNo, next = r?.NextNo,
                        nextNo = r is { StartNo: long sn } ? Format(r.Prefix, r.NextNo ?? sn) : null, started = r?.NextNo is not null, highest,
                        active = r is { Shared: true, FromAt: DateTime at } && at <= DateTime.UtcNow,
                    });
                }
                return new { timeZone = zone.Id, series = list };
            }));
        });

        api.MapPut("/companies/{companyId:guid}/number-series", async (Guid companyId, Body body, HttpContext http, Db db, Erp.FactsSync facts, Live live) =>
        {
            var scope = await http.ScopeAsync(db, companyId);
            if (!scope.IsAdmin) throw new ForbiddenException("Only administrators set the invoice and credit note numbers.");
            var series = (body.Series ?? "").Trim().ToUpperInvariant();
            if (!Kinds.TryGetValue(series, out var kind)) throw new DomainException("Series is INV (invoices) or CN (credit notes).");

            var (old, zone, erp) = await db.Company(companyId, async (c, tx) => (
                await c.QuerySingleOrDefaultAsync<Row>("select * from company_number_series where company_id = @companyId and series = @series", new { companyId, series }, tx),
                await ZoneAsync(c, tx, companyId),
                await c.ExecuteScalarAsync<string>("select erp_connector from company where id = @companyId", new { companyId }, tx)));
            var started = old?.NextNo is not null;

            DateTime? fromUtc = null;
            long? start = body.Start ?? old?.StartNo;
            var prefix = body.Shared ? (string.IsNullOrWhiteSpace(body.Prefix) ? null : body.Prefix.Trim().ToUpperInvariant()) : old?.Prefix;
            if (prefix is not null && !System.Text.RegularExpressions.Regex.IsMatch(prefix, "^[A-Z0-9-]{1,8}$"))
                throw new DomainException("A prefix is up to 8 letters, digits or dashes (e.g. CN or CN-), or empty for plain numbers.");
            if (body.Shared)
            {
                if (!DateTime.TryParseExact(body.From ?? "", ["yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd'T'HH:mm:ss"], CultureInfo.InvariantCulture, DateTimeStyles.None, out var local))
                    throw new DomainException("Enter the date and time the shared numbers start from.");
                fromUtc = TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(local, DateTimeKind.Unspecified), zone);
                if (start is not (>= 1 and <= 999_999_999_999)) throw new DomainException("The starting number is a whole number from 1 to 999999999999.");
                if (started && (start != old!.StartNo || prefix != old.Prefix))
                    throw new DomainException($"{kind.Label} already run from {Format(old.Prefix, old.StartNo ?? 0)} (the next is {Format(old.Prefix, old.NextNo ?? 0)}), so the prefix and starting number can't change any more.");
                if (!started)
                {
                    // Every plain number already used must stay below the start: in One POS (each number once per company) and in FACTS,
                    // where the same number again would replace that document (e.g. one of Polaris' bills).
                    var here = await db.Company(companyId, (c, tx) => c.ExecuteScalarAsync<long?>(kind.Sql, new { p = prefix ?? "" }, tx));
                    if (here >= start) throw new DomainException($"One POS already has {kind.Label.ToLowerInvariant()} up to {Format(prefix, here.Value)}. Start above it.");
                    if (erp == "facts")
                    {
                        long? inFacts;
                        try
                        {
                            await using var f = await facts.OpenAsync(companyId);
                            inFacts = await f.ExecuteScalarAsync<long?>(FactsSql, new { type = kind.FactsType, p = prefix ?? "" }, commandTimeout: 60);
                        }
                        catch (DomainException) { throw; }
                        catch (Exception ex) { throw new DomainException($"Couldn't check FACTS for numbers already used: {ex.Message.Split('\n')[0].Trim()}"); }
                        if (inFacts >= start)
                            throw new DomainException($"FACTS already has {kind.FactsType} documents up to {Format(prefix, inFacts.Value)}. Start above it, or the same number would replace that document in FACTS.");
                    }
                }
            }
            else if (old is null) return Results.Ok(new { ok = true });   // off, and never set: nothing to save
            else { fromUtc = old.FromAt; }

            await db.Company(companyId, async (c, tx) =>
            {
                await c.ExecuteAsync("""
                    insert into company_number_series (company_id, series, shared, from_at, prefix, start_no) values (@companyId, @series, @shared, @fromUtc, @prefix, @start)
                    on conflict (company_id, series) do update set shared = excluded.shared, from_at = excluded.from_at, prefix = excluded.prefix, start_no = excluded.start_no, updated_at = now()
                    """, new { companyId, series, shared = body.Shared, fromUtc, prefix, start }, tx);
                string? Local(DateTime? t) => t is DateTime u ? TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(u, DateTimeKind.Utc), zone).ToString("d MMM yyyy HH:mm", CultureInfo.InvariantCulture) : null;
                await Audit.RecordAsync(c, tx, companyId, null, scope.UserId, "company", companyId.ToString(), "numbers",
                    $"{kind.Label}: {(body.Shared ? $"one series for all branches from {Local(fromUtc)}, starting {Format(prefix, start ?? 0)}" : "each branch its own numbers")}",
                    [new("Shared", old?.Shared ?? false, body.Shared), new("From", Local(old?.FromAt), Local(fromUtc)), new("Prefix", old?.Prefix, prefix), new("Starting number", old?.StartNo, start)]);
                return 0;
            });
            await live.ToCompany(companyId, "branches.changed");
            return Results.Ok(new { ok = true });
        });
    }
}
