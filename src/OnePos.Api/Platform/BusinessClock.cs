namespace OnePos.Api.Platform;

/// <summary>
/// The branch's business date: today in the branch's time zone. Phase 2 replaces this with the opened business day
/// (REQ DAY-02: a day that crosses midnight keeps its date).
/// </summary>
public static class BusinessClock
{
    public static DateOnly Today(string timeZone)
    {
        var tz = TimeZoneInfo.TryFindSystemTimeZoneById(timeZone, out var z) ? z : TimeZoneInfo.Utc;
        return DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, tz));
    }

    public static TimeZoneInfo Zone(string timeZone) => TimeZoneInfo.TryFindSystemTimeZoneById(timeZone, out var z) ? z : TimeZoneInfo.Utc;
}
