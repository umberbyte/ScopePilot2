using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using ScopePilot.Services;
using ScopePilot.ViewModels;
using Xunit;

namespace ScopePilot.Tests;

[Collection("WPF UI")]
public sealed class AuthenticationWindowTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void AuthenticationBannerKeepsRoleAndResumeActionReadable(bool dark)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            MainWindow? window = null;
            try
            {
                window = new MainWindow(false);
                var vm = (MainViewModel)window.DataContext;
                vm.UpdateRoleOptions();
                vm.OnInterventionDetected("{\"requestId\":\"fixture\",\"kind\":\"authentication\",\"reason\":\"認証画面が表示されています。\",\"page\":\"http://192.168.0.27/login.php\",\"instruction\":\"現在の探索ブラウザへユーザー名・パスワードを直接入力してログインしてください。認証後のロールを選択し、再開してください。\"}");
                var nav = (ListBox)window.FindName("Navigation");
                nav.SelectedItem = nav.Items.OfType<ListBoxItem>().First(item => item.Tag is "1");
                ThemeService.Apply(window, dark);
                foreach (var size in new[] { new Size(960, 700), new Size(1360, 900) })
                {
                    var root = (FrameworkElement)window.Content;
                    window.Width = size.Width;
                    window.Height = size.Height;
                    root.Measure(size);
                    root.Arrange(new Rect(size));
                    root.UpdateLayout();
                    window.Dispatcher.Invoke(() => { }, DispatcherPriority.ContextIdle);
                    var role = (ListBox)window.FindName("AuthenticationRoleSelector");
                    var resume = (Button)window.FindName("ResumeInterventionButton");
                    Assert.True(role.IsVisible || role.ActualWidth >= 180);
                    Assert.True(role.ActualHeight >= 30);
                    Assert.True(resume.ActualWidth >= 180);
                    Assert.Equal(vm.AuthenticationRole, role.SelectedItem);
                    Assert.Equal("ログイン後のページを確認して再開", ((TextBlock)resume.Content).Text);
                    var workspace = (TabControl)window.FindName("Workspace");
                    var rolePoint = role.TransformToAncestor(workspace).Transform(new Point());
                    Assert.InRange(rolePoint.Y + role.ActualHeight, 0, workspace.ActualHeight);
                    Assert.Equal(((SolidColorBrush)window.Resources["TextPrimary"]).Color, ((SolidColorBrush)role.Foreground).Color);
                    var statusLabel = (TextBlock)window.FindName("AuthenticationNavigationStatusLabel");
                    Assert.Equal(((SolidColorBrush)window.Resources["TextPrimary"]).Color, ((SolidColorBrush)statusLabel.Foreground).Color);
                    var logButton = (Button)window.FindName("ShowLogButton");
                    var logPoint = logButton.TransformToAncestor(root).Transform(new Point());
                    Assert.True(logButton.ActualHeight >= 28);
                    Assert.InRange(logPoint.Y + logButton.ActualHeight, 0, size.Height);
                    if (Environment.GetEnvironmentVariable("SCOPEPILOT_UI_SNAPSHOTS") is { Length: > 0 } output)
                    {
                        Directory.CreateDirectory(output);
                        var bitmap = new RenderTargetBitmap((int)size.Width, (int)size.Height, 96, 96, PixelFormats.Pbgra32);
                        bitmap.Render(root);
                        var encoder = new PngBitmapEncoder();
                        encoder.Frames.Add(BitmapFrame.Create(bitmap));
                        using var stream = File.Create(Path.Combine(output, $"authentication-wait-{(dark ? "dark" : "light")}-{size.Width}.png"));
                        encoder.Save(stream);
                    }
                }
            }
            catch (Exception ex) { failure = ex; }
            finally { window?.Close(); Dispatcher.CurrentDispatcher.InvokeShutdown(); }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        Assert.True(thread.Join(TimeSpan.FromSeconds(30)), "Authentication UI check timed out.");
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
