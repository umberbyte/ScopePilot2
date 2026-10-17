using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using ScopePilot.Services;
using Xunit;

namespace ScopePilot.Tests;

[Collection("WPF UI")]
public sealed class ProjectStartupWindowTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void StartupShowsExactlyThreeActionsAndDefaultsToCancel(bool dark)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            ProjectStartupWindow? window = null;
            try
            {
                window = new ProjectStartupWindow();
                ThemeService.Apply(window, dark);
                var root = (FrameworkElement)window.Content;
                var size = new Size(720, 340);
                root.Measure(size);
                root.Arrange(new Rect(size));
                root.UpdateLayout();
                Assert.Equal(ProjectStartupAction.Cancel, window.SelectedAction);
                var buttons = ((StackPanel)root).Children.OfType<Button>().ToArray();
                Assert.Equal(3, buttons.Length);
                Assert.Contains("フォルダーを開く", buttons[0].Content.ToString());
                Assert.Contains("新規", buttons[1].Content.ToString());
                Assert.Contains("アプリを閉じる", buttons[2].Content.ToString());
                Assert.True(buttons[2].IsCancel);
                Assert.All(buttons, button => Assert.True(button.ActualHeight >= 48));
                Assert.True(buttons[2].TransformToAncestor(root).Transform(new Point()).Y + buttons[2].ActualHeight <= size.Height);
                if (Environment.GetEnvironmentVariable("SCOPEPILOT_UI_SNAPSHOTS") is { Length: > 0 } output)
                {
                    Directory.CreateDirectory(output);
                    var bitmap = new RenderTargetBitmap(720, 340, 96, 96, PixelFormats.Pbgra32);
                    bitmap.Render(root);
                    var encoder = new PngBitmapEncoder();
                    encoder.Frames.Add(BitmapFrame.Create(bitmap));
                    using var stream = File.Create(Path.Combine(output, $"startup-{(dark ? "dark" : "light")}.png"));
                    encoder.Save(stream);
                }
            }
            catch (Exception ex) { failure = ex; }
            finally { window?.Close(); Dispatcher.CurrentDispatcher.InvokeShutdown(); }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        Assert.True(thread.Join(TimeSpan.FromSeconds(30)));
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
