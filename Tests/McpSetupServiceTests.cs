using System.IO;
using System.Text.Json;
using ScopePilot.Services;
using Xunit;

namespace ScopePilot.Tests;

public sealed class McpSetupServiceTests
{
    [Fact]
    public void BurpProxy_DefaultsToUserSuppliedJarUnderDataRoot() =>
        Assert.Equal(Path.Combine(@"C:\ScopePilot data", "mcp", "mcp-proxy-all.jar"), BurpProxyLocation.ResolvePath(null, null, @"C:\ScopePilot data"));

    [Fact]
    public void BurpProxy_ExplicitPathTakesPrecedenceOverDataRoot() =>
        Assert.Equal(@"C:\Burp tools\proxy.jar", BurpProxyLocation.ResolvePath(@"C:\Burp tools\proxy.jar", null, @"C:\ScopePilot data"));

    [Fact]
    public void BurpProxy_AppSettingTakesPrecedenceOverEnvironmentVariable()
    {
        Assert.Equal(@"C:\App\proxy.jar", BurpProxyLocation.ResolvePath(@"C:\App\proxy.jar", @"C:\Env\proxy.jar", @"C:\ScopePilot data"));
        Assert.Equal(@"C:\Env\proxy.jar", BurpProxyLocation.ResolvePath(" ", @"C:\Env\proxy.jar", @"C:\ScopePilot data"));
    }

    private static string Configuration(string cli, bool enabled = true) => JsonSerializer.Serialize(new
    {
        enabled,
        transport = new { type = "stdio", command = @"C:\Program Files\nodejs\node.exe",
            args = new[] { cli, "--timeout-action", "15000", "--timeout-navigation", "90000" } }
    });

    private static readonly string[] Expected = [@"C:\Program Files\nodejs\node.exe",
        @"C:\Users\tester\AppData\Local\Programs\ScopePilot\tools\cli.js",
        "--timeout-action", "15000", "--timeout-navigation", "90000"];

    [Fact]
    public void InstallerMigration_RejectsOldPortablePathWithSameMarkers() =>
        Assert.False(McpSetupService.MatchesConfiguration(Configuration(@"C:\portable\tools\cli.js"), Expected));

    [Fact]
    public void InstalledConfiguration_DoesNotRequireRegistrationAgain() =>
        Assert.True(McpSetupService.MatchesConfiguration(Configuration(Expected[1]), Expected));

    [Fact]
    public void DisabledConfiguration_RequiresUpdate() =>
        Assert.False(McpSetupService.MatchesConfiguration(Configuration(Expected[1], false), Expected));

    [Theory]
    [InlineData("not json")]
    [InlineData("{}")]
    [InlineData("{\"transport\":null}")]
    public void UnrecognizedConfiguration_IsNotTreatedAsReady(string json) =>
        Assert.False(McpSetupService.MatchesConfiguration(json, Expected));
}
