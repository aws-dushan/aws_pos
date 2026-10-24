using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Identity;

namespace OnePos.Api.Platform;

/// <summary>Back-office passwords (the same hasher as AWS One).</summary>
public static class Passwords
{
    private static readonly PasswordHasher<object> Hasher = new();

    /// <summary>A hash to compare against when the user doesn't exist, so a wrong username takes as long as a wrong password.</summary>
    private static readonly string Dummy = Hasher.HashPassword(new object(), Guid.NewGuid().ToString());

    public static string Hash(string password) => Hasher.HashPassword(new object(), password);

    public static (bool Ok, bool Rehash) Verify(string? hash, string password)
    {
        if (string.IsNullOrEmpty(hash)) { Hasher.VerifyHashedPassword(new object(), Dummy, password); return (false, false); }
        try
        {
            var r = Hasher.VerifyHashedPassword(new object(), hash, password);
            return (r != PasswordVerificationResult.Failed, r == PasswordVerificationResult.SuccessRehashNeeded);
        }
        catch (FormatException) { return (false, false); }
    }

    public static void Check(string? password, string username)
    {
        if (string.IsNullOrEmpty(password) || password.Length < 8) throw new DomainException("The password needs at least 8 characters.");
        if (password.Length > 128) throw new DomainException("The password can have at most 128 characters.");
        if (!password.Any(char.IsLetter) || !password.Any(char.IsDigit)) throw new DomainException("The password needs both letters and digits.");
        if (username.Length >= 3 && password.Contains(username, StringComparison.OrdinalIgnoreCase))
            throw new DomainException("The password can't contain the username.");
    }
}

/// <summary>
/// Till PINs (REQ USR-01). A PIN is 4–6 digits, so a slow hash adds nothing against someone holding the database; what protects
/// it is the server secret (config Pins:Secret) plus lockout after failed tries. Kept as HMAC(secret, company + PIN): unique within
/// the company, so the PIN alone identifies the cashier at the till.
/// </summary>
public sealed class Pins(IConfiguration config)
{
    private readonly byte[] secret = Encoding.UTF8.GetBytes(config["Pins:Secret"] is { Length: >= 16 } s ? s
        : throw new InvalidOperationException("Pins:Secret is not configured (at least 16 characters)."));

    public const int MaxFailures = 5;
    public static readonly TimeSpan Lockout = TimeSpan.FromMinutes(5);

    public string Lookup(Guid companyId, string pin) =>
        Convert.ToHexString(HMACSHA256.HashData(secret, Encoding.UTF8.GetBytes($"{companyId:N}:{pin}")));

    public static void Check(string? pin)
    {
        if (pin is null || pin.Length is < 4 or > 6 || !pin.All(char.IsAsciiDigit))
            throw new DomainException("A PIN is 4 to 6 digits.");
        if (pin.Distinct().Count() == 1 || "0123456789".Contains(pin) || "9876543210".Contains(pin))
            throw new DomainException("That PIN is too easy to guess. Avoid repeated or sequential digits.");
    }
}
