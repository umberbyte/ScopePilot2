using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using ScopePilot.Domain;
using ScopePilot.Services;
using ScopePilot.ViewModels;
using Xunit;

namespace ScopePilot.Tests;

[Collection("WPF UI")]
public sealed class ZapAlertDetailsTests
{
    private static async Task<(EngagementProject Project, DiagnosticObservation Alert)> ReportAsync(TestFolder temp)
    {
        var project = temp.Project();
        var path = ProjectPaths.Resolve(project, "inputs/zap.json");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllTextAsync(path, """
        {"site":[{"alerts":[{"pluginid":"10020","name":"Missing header","riskcode":"1","confidence":"2","cweid":"693","wascid":"15",
          "desc":"<p>Description &amp; context.</p><p>Second line.</p>","solution":"<p>Set the appropriate header.</p>",
          "reference":"<p><a href='https://example.test/docs'>https://example.test/docs</a></p>",
          "instances":[{"uri":"https://example.test/api?token=SECRET","method":"POST","param":"token","evidence":"SECRET","attack":"INPUT","otherinfo":"CVE-2026-12345 interaction notes","messageId":"42",
          "request-header":"POST /api?token=SECRET HTTP/1.1\r\nHost: example.test\r\nAuthorization: Bearer RAW_AUTH_SECRET\r\nCookie: sid=RAW_COOKIE_SECRET\r\nContent-Type: application/json\r\n",
          "request-body":"{\"email\":\"person@example.test\",\"password\":\"RAW_PASSWORD\"}",
          "response-header":"HTTP/1.1 200 OK\r\nSet-Cookie: sid=RAW_COOKIE_SECRET\r\n","response-body":"{\"email\":\"person@example.test\"}"}]}]}]}
        """);
        await new ZapResultImporter().ImportAsync(project, path);
        return (project, Assert.Single(project.DiagnosticObservations));
    }

    [Fact]
    public async Task DetailsReadLegacyEvidenceWithoutPersistingRawInstanceValues()
    {
        using var temp = new TestFolder();
        var (project, alert) = await ReportAsync(temp);
        var before = JsonSerializer.Serialize(project);
        var details = await new ZapAlertDetailsService().ReadAsync(project, alert);
        Assert.Equal("Missing header", details.Title);
        Assert.Contains("Description & context.", details.DisplayText);
        Assert.DoesNotContain("<p>", details.DisplayText);
        Assert.Contains("Set the appropriate header.", details.DisplayText);
        Assert.Contains("https://example.test/docs", details.DisplayText);
        Assert.Contains("証拠: SECRET", details.DisplayText);
        Assert.Contains("メッセージID: 42", details.DisplayText);
        Assert.Contains(alert.Evidence.Pointer, details.DisplayText);
        Assert.Contains("危険度: 低", details.Summary);
        Assert.Contains("CWE: 693", details.Summary);
        Assert.Contains("POST /api?token=", details.Request);
        Assert.Contains("伏せ字", details.Request);
        Assert.Contains("Authorization: [伏せ字]", details.Request);
        Assert.Contains("Cookie: [伏せ字]", details.Request);
        Assert.DoesNotContain("RAW_AUTH_SECRET", details.Request);
        Assert.DoesNotContain("RAW_COOKIE_SECRET", details.Response);
        Assert.DoesNotContain("RAW_PASSWORD", details.Request);
        Assert.DoesNotContain("person@example.test", details.Request + details.Response);
        Assert.Equal("[伏せ字]", details.AttackInput);
        Assert.Equal("[伏せ字]", details.ObservedEvidence);
        Assert.Contains("CVE-2026-12345", details.CveIds);
        Assert.Equal(before, JsonSerializer.Serialize(project));
        Assert.DoesNotContain("SECRET", before);
    }

    [Fact]
    public async Task ChangedOriginalOrInvalidPointerCannotSupplyDetails()
    {
        using var temp = new TestFolder();
        var (project, alert) = await ReportAsync(temp);
        alert.Evidence = alert.Evidence with { Pointer = "/site/0/alerts/9/instances/0" };
        await Assert.ThrowsAsync<InvalidDataException>(() => new ZapAlertDetailsService().ReadAsync(project, alert));
        alert.Evidence = alert.Evidence with { Pointer = "/site/0/alerts/0/instances/0" };
        await File.AppendAllTextAsync(ProjectPaths.Resolve(project, alert.Evidence.LocalPath), " ");
        await Assert.ThrowsAsync<InvalidDataException>(() => new ZapAlertDetailsService().ReadAsync(project, alert));
    }

    [Fact]
    public void CardsShowExclusiveSelectionAndReselectingKeepsPreparedOutput()
    {
        RunOnUiThread(() =>
        {
            var window = new MainWindow(false);
            try
            {
                var model = (MainViewModel)window.DataContext;
                var zap = (RadioButton)window.FindName("ZapHandoffChoice");
                var burp = (RadioButton)window.FindName("BurpHandoffChoice");
                window.ApplyTemplate();
                window.Measure(new Size(960, 720)); window.Arrange(new Rect(0, 0, 960, 720)); window.UpdateLayout();
                window.Dispatcher.Invoke(() => { }, DispatcherPriority.ContextIdle);
                Assert.True(burp.IsChecked);
                Assert.False(zap.IsChecked);
                zap.IsChecked = true;
                window.Dispatcher.Invoke(() => { }, DispatcherPriority.ContextIdle);
                Assert.True(model.IsZapTarget);
                Assert.False(model.IsBurpTarget);
                Assert.False(burp.IsChecked);
                model.BurpScopeRegexes.Add("prepared");
                model.IsZapTarget = true;
                Assert.Equal("prepared", Assert.Single(model.BurpScopeRegexes));
                burp.IsChecked = true;
                window.Dispatcher.Invoke(() => { }, DispatcherPriority.ContextIdle);
                Assert.True(model.IsBurpTarget);
                Assert.False(zap.IsChecked);
                Assert.Empty(model.BurpScopeRegexes);
            }
            finally { window.Close(); }
        });
    }

    [Fact]
    public void DetailsWindowRendersLongSelectableTextAtBothSizesAndThemes()
    {
        RunOnUiThread(() =>
        {
            foreach (var dark in new[] { false, true })
            foreach (var size in new[] { new Size(560, 420), new Size(840, 740) })
            {
                var details = new ZapAlertDetails("警告のタイトル " + new string('長', 90),
                    "危険度: 中　確度: 高　状態: 要確認\nルールID: 10020　CWE: 693　WASC: 15\nロール: 一般ユーザー",
                    "説明\n" + string.Join("\n", Enumerable.Repeat("説明・対策・通信証拠を原本から読む。", 150)), "C:\\fixture\\zap.json");
                var window = new ZapAlertDetailsWindow(details);
                try
                {
                    ThemeService.Apply(window, dark);
                    window.Width = size.Width; window.Height = size.Height;
                    var root = (FrameworkElement)window.Content;
                    root.Measure(size); root.Arrange(new Rect(size)); root.UpdateLayout();
                    window.Dispatcher.Invoke(() => { }, DispatcherPriority.ContextIdle);
                    root.UpdateLayout();
                    var text = (TextBox)window.FindName("AlertDetailsText");
                    Assert.True(text.IsReadOnly);
                    Assert.Equal(details.DisplayText, text.Text);
                    Assert.True(text.ActualHeight >= 100, $"Details height: {text.ActualHeight}");
                    Assert.True(text.ActualWidth >= 480, $"Details width: {text.ActualWidth}");
                    if (Environment.GetEnvironmentVariable("SCOPEPILOT_UI_SNAPSHOTS") is { Length: > 0 } output)
                    {
                        Directory.CreateDirectory(output);
                        var bitmap = new RenderTargetBitmap((int)size.Width, (int)size.Height, 96, 96, PixelFormats.Pbgra32);
                        bitmap.Render(root);
                        var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(bitmap));
                        using var stream = File.Create(Path.Combine(output, $"zap-details-{(dark ? "dark" : "light")}-{size.Width}.png"));
                        encoder.Save(stream);
                    }
                }
                finally { window.Close(); }
            }
        });
    }

    private static void RunOnUiThread(Action action)
    {
        Exception? failure = null;
        var thread = new Thread(() => { try { action(); } catch (Exception ex) { failure = ex; } finally { Dispatcher.CurrentDispatcher.InvokeShutdown(); } });
        thread.SetApartmentState(ApartmentState.STA); thread.Start();
        Assert.True(thread.Join(TimeSpan.FromSeconds(30)));
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
