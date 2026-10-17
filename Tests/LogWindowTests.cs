using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using ScopePilot.Services;
using Xunit;

namespace ScopePilot.Tests;

[Collection("WPF UI")]
public sealed class LogWindowTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void LogSelectionSurvivesIncomingMessagesAndCopyUsesVisibleText(bool dark)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            LogWindow? window = null;
            try
            {
                var current = "12:00:00  認証待ち\r\n11:59:59  探索を開始しました。";
                string? copied = null;
                window = new LogWindow(() => current, _ => Task.FromResult("fixture.txt"), text =>
                {
                    copied = text;
                    return Task.FromResult(new ClipboardCopyResult(true, "コピーしました。"));
                });
                ThemeService.Apply(window, dark);
                var root = (FrameworkElement)window.Content;
                var size = new Size(720, 420);
                root.Measure(size);
                root.Arrange(new Rect(size));
                root.UpdateLayout();
                window.Dispatcher.Invoke(() => { }, DispatcherPriority.ContextIdle);
                var input = (TextBox)window.FindName("LogTextBox");
                input.Select(10, 4);
                var selected = input.SelectedText;
                current = "12:00:01  新しいメッセージ\r\n" + current;
                Assert.Equal(selected, input.SelectedText);
                Assert.DoesNotContain("新しいメッセージ", input.Text);
                ApplicationCommands.Copy.Execute(null, input);
                Assert.Equal(selected, copied);
                Assert.Equal("コピーしました。", ((TextBlock)window.FindName("ResultText")).Text);
                window.CopyAsync(input.Text).GetAwaiter().GetResult();
                Assert.Equal(input.Text, copied);
                var copyAll = (Button)window.FindName("CopyAllButton");
                Assert.True(copyAll.ActualWidth > 90);
                Assert.True(input.ActualHeight > 160);
                var p = input.TransformToAncestor(root).Transform(new Point());
                Assert.InRange(p.Y + input.ActualHeight, 0, size.Height);
                Assert.Equal(((SolidColorBrush)window.Resources["ConsoleForeground"]).Color, ((SolidColorBrush)input.Foreground).Color);
                if (Environment.GetEnvironmentVariable("SCOPEPILOT_UI_SNAPSHOTS") is { Length: > 0 } output)
                {
                    Directory.CreateDirectory(output);
                    var bitmap = new RenderTargetBitmap(720, 420, 96, 96, PixelFormats.Pbgra32);
                    bitmap.Render(root);
                    var encoder = new PngBitmapEncoder();
                    encoder.Frames.Add(BitmapFrame.Create(bitmap));
                    using var stream = File.Create(Path.Combine(output, $"log-{(dark ? "dark" : "light")}.png"));
                    encoder.Save(stream);
                }
                window.RefreshLog();
                Assert.Equal(current, input.Text);
            }
            catch (Exception ex) { failure = ex; }
            finally { window?.Close(); Dispatcher.CurrentDispatcher.InvokeShutdown(); }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        Assert.True(thread.Join(TimeSpan.FromSeconds(30)), "Log UI check timed out.");
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }

    [Fact]
    public void LogWindowFollowsTailWhileIdleAndHoldsSelection()
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            LogWindow? window = null;
            try
            {
                var current = "12:00:00  探索を開始しました。";
                window = new LogWindow(() => current, _ => Task.FromResult("fixture.txt"));
                Assert.True(window.IsAutoRefreshRunning);
                var root = (FrameworkElement)window.Content;
                var size = new Size(720, 420);
                root.Measure(size);
                root.Arrange(new Rect(size));
                root.UpdateLayout();
                var input = (TextBox)window.FindName("LogTextBox");
                current = "12:00:05  ZAP: アクティブ診断を実行中（1/2）: http://example.test/sqli\r\n" + current;
                window.FollowLatest();
                Assert.Contains("アクティブ診断を実行中（1/2）", input.Text);
                input.Select(0, 8);
                var selected = input.SelectedText;
                current = "12:00:06  ZAP: アクティブ診断を完了しました。\r\n" + current;
                window.FollowLatest();
                Assert.Equal(selected, input.SelectedText);
                Assert.DoesNotContain("完了しました", input.Text);
                input.Select(0, 0);
                window.FollowLatest();
                Assert.Contains("完了しました", input.Text);
            }
            catch (Exception ex) { failure = ex; }
            finally { window?.Close(); Dispatcher.CurrentDispatcher.InvokeShutdown(); }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        Assert.True(thread.Join(TimeSpan.FromSeconds(30)), "Log follow check timed out.");
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
