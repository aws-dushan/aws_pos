using System.Text.Json;

namespace OnePos.Api.Platform;

/// <summary>
/// What a role may do (REQ USR-02, USR-03). Keys live in code; a role stores the keys it has and its limits.
/// Approvals (USR-05/06) build on these in phase 2.
/// </summary>
public static class Permissions
{
    public sealed record Def(string Key, string Group, string Label);

    public static readonly Def[] All =
    [
        new("pos.sell", "Register", "Take orders and payments"),
        new("pos.discount", "Register", "Give discounts (up to the role's limit)"),
        new("pos.void", "Register", "Void orders and items sent to the kitchen"),
        new("pos.refund", "Register", "Refund paid orders"),
        new("pos.nosale", "Register", "Open the cash drawer without a sale"),
        new("pos.price_override", "Register", "Change an item's price on an order"),
        new("tables.serve", "Tables", "Seat, move, merge and split tables"),
        new("kitchen.view", "Kitchen", "Use the kitchen display"),
        new("day.shift", "Day control", "Open and close own shift"),
        new("day.manage", "Day control", "Open and close the business day, approve variances"),
        new("day.reopen", "Day control", "Reopen a closed day"),
        new("day.deposit", "Day control", "Record bank deposits (cash taken to the bank, with its bag number)"),
        new("dashboard.register", "Dashboard", "See this register's sales (own till and shift)"),
        new("dashboard.branch", "Dashboard", "See the whole branch's sales (all registers)"),
        new("menu.manage", "Back office", "Edit the menu, prices and availability"),
        new("tables.manage", "Back office", "Edit floors and tables"),
        new("reports.view", "Back office", "View reports and the dashboard"),
        new("branch.manage", "Back office", "Edit branch settings and devices"),
        new("users.manage", "Administration", "Manage users and roles"),
        new("audit.view", "Administration", "View the audit log"),
        new("customers.preapprove", "Register", "Pre-approve a customer's discount (e.g. 100 % complimentary): it then applies at the till with no approval"),
        new("facts.post", "Finance", "FACTS posting: see the log, push and re-push bills, record wastage posted in FACTS"),
    ];

    public static readonly HashSet<string> Keys = All.Select(p => p.Key).ToHashSet();

    /// <summary>The limits a role can carry, with their meaning.</summary>
    public static readonly (string Key, string Label)[] LimitDefs =
    [
        ("maxDiscountPct", "Largest discount without approval (%)"),
        ("maxRefund", "Largest refund without approval (amount)"),
        ("maxCashOut", "Largest cash-out without approval (amount)"),
    ];

    /// <summary>The roles a new company starts with (users can edit them).</summary>
    public static readonly (string Name, string[] Perms, object Limits)[] Presets =
    [
        ("Cashier", ["pos.sell", "pos.discount", "tables.serve", "day.shift", "day.deposit", "dashboard.register"], new { maxDiscountPct = 10, maxRefund = 0, maxCashOut = 0 }),
        ("Waiter", ["pos.sell", "tables.serve", "dashboard.register"], new { maxDiscountPct = 0, maxRefund = 0, maxCashOut = 0 }),
        ("Kitchen", ["kitchen.view"], new { }),
        ("Supervisor", ["pos.sell", "pos.discount", "pos.void", "pos.refund", "pos.nosale", "tables.serve", "kitchen.view", "day.shift", "day.deposit", "reports.view", "dashboard.register", "dashboard.branch"],
            new { maxDiscountPct = 25, maxRefund = 500, maxCashOut = 200 }),
        ("Branch manager", All.Select(p => p.Key).Where(k => k is not "users.manage" and not "day.reopen").ToArray(),
            new { maxDiscountPct = 100, maxRefund = 5000, maxCashOut = 2000 }),
        ("Head office", All.Select(p => p.Key).ToArray(), new { maxDiscountPct = 100, maxRefund = 100000, maxCashOut = 100000 }),
        ("Finance", ["facts.post", "reports.view", "dashboard.branch"], new { maxDiscountPct = 0, maxRefund = 0, maxCashOut = 0 }),
    ];

    public static string[] Clean(IEnumerable<string>? keys)
    {
        var list = (keys ?? []).Distinct().ToArray();
        var unknown = list.Where(k => !Keys.Contains(k)).ToArray();
        if (unknown.Length > 0) throw new DomainException($"Unknown permission: {string.Join(", ", unknown)}.");
        return list;
    }

    /// <summary>
    /// A user's own limits over their role's: a number is their limit, null is "no limit" for them; a key left out follows the role.
    /// </summary>
    public static string CleanUserLimits(JsonElement? limits)
    {
        var allowed = LimitDefs.Select(l => l.Key).ToHashSet();
        var clean = new Dictionary<string, decimal?>();
        if (limits is { ValueKind: JsonValueKind.Object } obj)
            foreach (var p in obj.EnumerateObject())
            {
                if (!allowed.Contains(p.Name)) throw new DomainException($"Unknown limit: {p.Name}.");
                if (p.Value.ValueKind == JsonValueKind.Null) { clean[p.Name] = null; continue; }
                if (p.Value.ValueKind != JsonValueKind.Number || !p.Value.TryGetDecimal(out var v) || v < 0)
                    throw new DomainException("Limits are numbers of zero or more.");
                clean[p.Name] = v;
            }
        return JsonSerializer.Serialize(clean);
    }

    public static string CleanLimits(JsonElement? limits)
    {
        var allowed = LimitDefs.Select(l => l.Key).ToHashSet();
        var clean = new Dictionary<string, decimal>();
        if (limits is { ValueKind: JsonValueKind.Object } obj)
            foreach (var p in obj.EnumerateObject())
            {
                if (!allowed.Contains(p.Name)) throw new DomainException($"Unknown limit: {p.Name}.");
                if (p.Value.ValueKind != JsonValueKind.Number || !p.Value.TryGetDecimal(out var v) || v < 0)
                    throw new DomainException("Limits are numbers of zero or more.");
                clean[p.Name] = v;
            }
        return JsonSerializer.Serialize(clean);
    }
}
