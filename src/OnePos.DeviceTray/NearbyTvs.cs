using Windows.Devices.Enumeration;

namespace OnePos.DeviceTray;

/// <summary>
/// The wireless (Miracast) TVs this PC can see now: Windows' Wi-Fi Direct display endpoints (the ones the Cast panel lists) that are
/// in reach. Wi-Fi Direct printers ("DIRECT-…") are left out. Never throws.
/// </summary>
internal static class NearbyTvs
{
    private const string MiracastProtocol = "System.Devices.Aep.ProtocolId:=\"{0407d24e-53de-4c9a-9ba1-9ced54641188}\"";
    private const string IsPresent = "System.Devices.Aep.IsPresent";

    /// <summary>The TVs' names, each once; null when Windows can't list them on this PC.</summary>
    public static async Task<List<string>?> FindAsync()
    {
        try
        {
            var find = DeviceInformation.FindAllAsync(MiracastProtocol, [IsPresent], DeviceInformationKind.AssociationEndpoint).AsTask();
            if (await Task.WhenAny(find, Task.Delay(TimeSpan.FromSeconds(20))) != find) return null;
            var all = await find;
            // Windows also lists TVs it knew before that aren't answering now, and doesn't reliably say which: every TV is listed
            // (those it says are present first); Connect on one that is off reports that the TV didn't answer.
            var names = new List<(string Name, bool Present)>();
            foreach (var d in all)
            {
                var name = d.Name?.Trim();
                if (string.IsNullOrEmpty(name) || name.StartsWith("DIRECT-", StringComparison.OrdinalIgnoreCase)) continue;
                var present = d.Properties.TryGetValue(IsPresent, out var p) && p is true;
                var i = names.FindIndex(n => string.Equals(n.Name, name, StringComparison.OrdinalIgnoreCase));
                if (i < 0) names.Add((name, present)); else if (present) names[i] = (name, true);
            }
            return [.. names.OrderByDescending(n => n.Present).Select(n => n.Name)];
        }
        catch (Exception e) when (e is not OutOfMemoryException) { return null; }
    }
}
