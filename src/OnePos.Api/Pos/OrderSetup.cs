using System.Text.Json;
using Dapper;
using Npgsql;
using OnePos.Api.Platform;

namespace OnePos.Api.Pos;

/// <summary>
/// A branch's order types and, for each, the payment types its tills offer (Companies &amp; branches → Order types and payments).
/// Dine-in is on with table service; takeaway and delivery have their own switch. Voucher and points follow the company's settings.
/// </summary>
public static class OrderSetup
{
    public static readonly string[] Types = ["dine_in", "takeaway", "delivery"];
    /// <summary>The payment types a branch chooses per order type, in the till's order.</summary>
    public static readonly string[] Methods = ["cash", "card", "other", "account", "platform"];
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public sealed record Setup(bool TableService, bool TakeawayOn, bool DeliveryOn, Dictionary<string, string[]> PayMethods)
    {
        public bool TypeOn(string type) => type switch { "dine_in" => TableService, "takeaway" => TakeawayOn, "delivery" => DeliveryOn, _ => false };
        public bool Allows(string type, string method) => PayMethods.TryGetValue(type, out var m) && m.Contains(method);
        /// <summary>The order type is paid only by a delivery platform here (a cloud kitchen): no walk-in or own delivery.</summary>
        public bool PlatformOnly(string type) => PayMethods.TryGetValue(type, out var m) && m.Length > 0 && m.All(x => x == "platform");
    }

    /// <summary>
    /// Where an order type is paid only by a platform and exactly one platform of that type is on at the branch, that platform
    /// (id, commission, bank fee) — the order starts tagged with it. Otherwise null: the cashier picks.
    /// </summary>
    public static async Task<(Guid Id, decimal Pct, decimal Fee)?> OnlyPlatformAsync(NpgsqlConnection c, NpgsqlTransaction tx, Setup s, Guid branchId, string type)
    {
        if (!s.PlatformOnly(type)) return null;
        var list = (await c.QueryAsync<(Guid Id, decimal Pct, decimal Fee)>(
            "select id, commission_pct, bank_fee_pct from delivery_platform where is_active and @b = any(branch_ids) and order_type = @type limit 2",
            new { b = branchId, type }, tx)).ToList();
        return list.Count == 1 ? list[0] : null;
    }

    public static string TypeLabel(string type) => type switch { "dine_in" => "dine-in", "takeaway" => "takeaway", _ => "delivery" };
    public static string MethodLabel(string method) => method switch { "cash" => "Cash", "card" => "Card", "other" => "Other", "account" => "Account", _ => "Platform" };

    public static async Task<Setup> LoadAsync(NpgsqlConnection c, NpgsqlTransaction tx, Guid branchId)
    {
        var r = await c.QuerySingleAsync<(bool TableService, bool TakeawayOn, bool DeliveryOn, string PayMethods)>(
            "select table_service, takeaway_on, delivery_on, pay_methods::text from branch where id = @branchId", new { branchId }, tx);
        return new Setup(r.TableService, r.TakeawayOn, r.DeliveryOn, Parse(r.PayMethods));
    }

    public static Dictionary<string, string[]> Parse(string? json) =>
        (string.IsNullOrWhiteSpace(json) ? null : JsonSerializer.Deserialize<Dictionary<string, string[]>>(json, Json)) ?? [];

    /// <summary>An order type the branch doesn't take is refused (an old till screen, an order started before the change).</summary>
    public static void RequireType(Setup s, string type)
    {
        if (s.TypeOn(type)) return;
        throw new DomainException(type == "dine_in" ? "This branch has no table service: start a takeaway or delivery order."
            : $"This branch doesn't take {TypeLabel(type)} orders (Companies & branches → Order types and payments).");
    }

    /// <summary>A payment type the branch doesn't offer for the order's type is refused (voucher and points follow the company).</summary>
    public static void RequireMethod(Setup s, string type, string method)
    {
        if (!Methods.Contains(method) || s.Allows(type, method)) return;
        throw new DomainException($"{MethodLabel(method)} isn't taken for {TypeLabel(type)} orders at this branch (Companies & branches → Order types and payments).");
    }

    /// <summary>
    /// The choice as saved: known types and payment types only, in the usual order. A type that's on needs at least one payment type
    /// (voucher and points alone can't pay every bill).
    /// </summary>
    public static Dictionary<string, string[]> Clean(Dictionary<string, string[]>? m, bool tableService, bool takeawayOn, bool deliveryOn)
    {
        var res = Types.ToDictionary(t => t, t => Methods.Where(x => (m?.GetValueOrDefault(t) ?? []).Contains(x, StringComparer.OrdinalIgnoreCase)).ToArray());
        foreach (var t in Types)
            if (new Setup(tableService, takeawayOn, deliveryOn, res).TypeOn(t) && res[t].Length == 0)
                throw new DomainException($"Tick at least one payment type for {TypeLabel(t)} orders, or switch {TypeLabel(t)} off.");
        return res;
    }

    public static string Text(Dictionary<string, string[]> m, bool tableService, bool takeawayOn, bool deliveryOn)
    {
        var s = new Setup(tableService, takeawayOn, deliveryOn, m);
        return string.Join("; ", Types.Where(s.TypeOn).Select(t => $"{TypeLabel(t)}: {string.Join(", ", m.GetValueOrDefault(t, []).Select(MethodLabel))}"));
    }

    public static string ToJson(Dictionary<string, string[]> m) => JsonSerializer.Serialize(m, Json);
}
