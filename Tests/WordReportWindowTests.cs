using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using ScopePilot.Services;
using Xunit;

namespace ScopePilot.Tests;

[Collection("WPF UI")]
public sealed class WordReportWindowTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ReportConversionControlsWrapAndRemainReadableAtMinimumWindowSize(bool dark)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            MainWindow? window = null;
            try
            {
                window = new MainWindow(false); ThemeService.Apply(window, dark);
                var nav = (ListBox)window.FindName("Navigation"); nav.SelectedItem = nav.Items.OfType<ListBoxItem>().First(x => x.Tag is "4");
                var root = (FrameworkElement)window.Content; var size = new Size(960, 700);
                root.Measure(size); root.Arrange(new Rect(size)); root.UpdateLayout();
                window.Dispatcher.Invoke(() => { }, DispatcherPriority.ContextIdle);
                var button = (Button)window.FindName("ConvertMarkdownWordButton"); var label = (TextBlock)window.FindName("WordReportStatusLabel");
                Assert.True(button.ActualWidth >= 150);
                Assert.True(button.ActualHeight >= 36);
                var point = button.TransformToAncestor(root).Transform(new Point());
                Assert.InRange(point.X + button.ActualWidth, 0, size.Width);
                Assert.InRange(point.Y + button.ActualHeight, 0, size.Height);
                Assert.Equal(((SolidColorBrush)window.Resources["TextSecondary"]).Color, ((SolidColorBrush)label.Foreground).Color);
            }
            catch (Exception ex) { failure = ex; }
            finally { window?.Close(); Dispatcher.CurrentDispatcher.InvokeShutdown(); }
        });
        thread.SetApartmentState(ApartmentState.STA); thread.Start();
        Assert.True(thread.Join(TimeSpan.FromSeconds(30)), "Word report UI check timed out.");
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
