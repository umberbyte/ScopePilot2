using System.Text.RegularExpressions;

namespace ScopePilot.Services;

public static partial class UrlPatternNormalizer
{
    private static readonly HashSet<string> CacheQueryKeys = new(StringComparer.OrdinalIgnoreCase)
        { "_", "v", "ver", "version", "cb", "cache", "cachebuster", "rev", "hash" };

    public static string Normalize(string value, ISet<string>? ignoredQueryKeys = null)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)) return value;
        var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries)
            .Select(NormalizeSegment);
        var path = "/" + string.Join('/', segments);
        var queryKeys = uri.Query.TrimStart('?')
            .Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Select(x => Uri.UnescapeDataString(x.Split('=', 2)[0]))
            .Where(x => !string.IsNullOrWhiteSpace(x) && (ignoredQueryKeys is null || !ignoredQueryKeys.Contains(x)))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Order(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        return uri.GetLeftPart(UriPartial.Authority).ToLowerInvariant() + path +
               (queryKeys.Length > 0 ? $"?{string.Join('&', queryKeys.Select(x => x + "={value}"))}" : string.Empty);
    }

    public static string NormalizeForSelection(string value) => Normalize(value, CacheQueryKeys);

    public static string NormalizeSegment(string value)
    {
        var segment = Uri.UnescapeDataString(value).ToLowerInvariant();
        if (Guid.TryParse(segment, out _)) return "{guid}";
        if (PureId().IsMatch(segment)) return "{id}";

        var extension = Path.GetExtension(segment);
        var stem = extension.Length > 0 ? segment[..^extension.Length] : segment;
        var suffix = extension.Length > 0 ? extension : string.Empty;

        var dated = PrefixedDate().Match(stem);
        if (dated.Success)
            return dated.Groups["prefix"].Success
                ? dated.Groups["prefix"].Value.TrimEnd('-', '_') + "-{date}" + suffix
                : "{date}" + suffix;

        var prefixedId = PrefixedLongNumber().Match(stem);
        if (prefixedId.Success)
            return prefixedId.Groups["prefix"].Value.TrimEnd('-', '_') + "{id}" + suffix;

        return segment;
    }

    [GeneratedRegex("^(?:\\d+|[0-9a-f]{16,})$", RegexOptions.IgnoreCase)]
    private static partial Regex PureId();

    [GeneratedRegex("^(?:(?<prefix>[a-z][a-z0-9_-]*?)[-_])?(?:19|20)\\d{2}[-_]\\d{1,2}[-_]\\d{1,2}$", RegexOptions.IgnoreCase)]
    private static partial Regex PrefixedDate();

    [GeneratedRegex("^(?<prefix>[a-z][a-z_-]*?)[-_]?(?<id>\\d{4,})$", RegexOptions.IgnoreCase)]
    private static partial Regex PrefixedLongNumber();
}
