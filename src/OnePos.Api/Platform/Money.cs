namespace OnePos.Api.Platform;

/// <summary>Money rounding (REQ NFR-04): 2 decimals, half away from zero, like AWS One's server (never banker's rounding).</summary>
public static class Money
{
    public static decimal Round(decimal value) => decimal.Round(value, 2, MidpointRounding.AwayFromZero);
}
