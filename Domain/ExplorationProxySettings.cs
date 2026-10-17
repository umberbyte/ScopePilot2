namespace ScopePilot.Domain;

public enum ExplorationProxyMode { Auto, Burp, Zap }

public sealed class ExplorationProxySettings
{
    public ExplorationProxyMode Mode { get; set; } = ExplorationProxyMode.Auto;
    public string BurpProxyUrl { get; set; } = "http://127.0.0.1:8080";
    public int ZapPort { get; set; } = 8090;
}

public sealed record ExplorationProxyEndpoint(ExplorationProxyMode Provider, string Url);
