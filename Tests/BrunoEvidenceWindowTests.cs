using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using ScopePilot.Domain;
using ScopePilot.Services;
using Xunit;

namespace ScopePilot.Tests;

[Collection("WPF UI")]
public sealed class BrunoEvidenceWindowTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ImportWindowUsesReadableThemeAndKeepsActionsVisible(bool dark)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            BrunoEvidenceWindow? window = null;
            try
            {
                window = new BrunoEvidenceWindow(new EngagementProject());
                ThemeService.Apply(window, dark);
                var size = new Size(900, 740);
                var root = (Grid)window.Content;
                root.Measure(size);
                root.Arrange(new Rect(size));
                root.UpdateLayout();
                var foreground = Assert.IsType<SolidColorBrush>(window.FindResource("TextPrimary"));
                Assert.Equal(dark ? Color.FromRgb(0xE6, 0xED, 0xF3) : Color.FromRgb(0x17, 0x20, 0x33), foreground.Color);
                Assert.True(((Button)window.FindName("ImportButton")).ActualHeight >= 24);
                Assert.True(((DataGrid)window.FindName("EntriesGrid")).ActualHeight >= 130);
                var actions = (Grid)root.Children[4];
                Assert.True(actions.TransformToAncestor(root).Transform(new Point()).Y + actions.ActualHeight <= size.Height);
                var fields = (StackPanel)((ScrollViewer)root.Children[3]).Content;
                var label = (TextBlock)fields.Children[0];
                Assert.Equal(foreground.Color, Assert.IsType<SolidColorBrush>(label.Foreground).Color);
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
