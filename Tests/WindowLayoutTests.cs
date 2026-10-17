using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using ScopePilot.Services;
using ScopePilot.Domain;
using ScopePilot.ViewModels;
using Xunit;

namespace ScopePilot.Tests;

[Collection("WPF UI")]
public sealed class WindowLayoutTests
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public void ProjectButtonsAlignAndLabelsFollowTheme(bool dark, bool longPath)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            MainWindow? window = null;
            try
            {
                window = new MainWindow(false);
                var model = (MainViewModel)window.DataContext;
                if (longPath)
                {
                    model.Project.ProjectFilePath = @"C:\案件フォルダー\" + new string('長', 100) + @"\project.scopepilot.json";
                    window.DataContext = null;
                    window.DataContext = model;
                }
                var section = (GroupBox)window.FindName("ProjectFileSection");
                var label = (TextBlock)window.FindName("ProjectLocationLabel");
                var open = (Button)window.FindName("OpenProjectFileButton");
                var migrate = (Button)window.FindName("ImportLegacyProjectButton");
                ThemeService.Apply(window, dark);
                var root = (FrameworkElement)window.Content;
                foreach (var size in new[] { new Size(960, 700), new Size(1360, 900) })
                {
                    window.Width = size.Width;
                    window.Height = size.Height;
                    root.Measure(size);
                    root.Arrange(new Rect(size));
                    root.UpdateLayout();
                    window.Dispatcher.Invoke(() => { }, DispatcherPriority.ContextIdle);
                    var openPoint = open.TransformToAncestor(section).Transform(new Point());
                    var migratePoint = migrate.TransformToAncestor(section).Transform(new Point());
                    var labelPoint = label.TransformToAncestor(section).Transform(new Point());
                    Assert.InRange(Math.Abs(openPoint.Y - migratePoint.Y), 0, 1);
                    Assert.InRange(Math.Abs(open.ActualWidth - migrate.ActualWidth), 0, 1);
                    Assert.InRange(Math.Abs(open.ActualHeight - migrate.ActualHeight), 0, 1);
                    Assert.True(openPoint.Y >= labelPoint.Y + label.ActualHeight + 10);
                    var expected = ((SolidColorBrush)window.Resources["TextPrimary"]).Color;
                    Assert.Equal(expected, ((SolidColorBrush)label.Foreground).Color);
                    Assert.DoesNotContain(Descendants<TextBlock>(root), x => x.Text.Contains("診断の条件情報"));
                    Assert.Null(window.FindName("DiagnosticConditionsExpander"));
                    if (Environment.GetEnvironmentVariable("SCOPEPILOT_UI_SNAPSHOTS") is { Length: > 0 } output)
                    {
                        Directory.CreateDirectory(output);
                        var bitmap = new RenderTargetBitmap((int)size.Width, (int)size.Height, 96, 96, PixelFormats.Pbgra32);
                        bitmap.Render(root);
                        var encoder = new PngBitmapEncoder();
                        encoder.Frames.Add(BitmapFrame.Create(bitmap));
                        using var stream = File.Create(Path.Combine(output, $"settings-{(dark ? "dark" : "light")}-{(longPath ? "long" : "empty")}-{size.Width}.png"));
                        encoder.Save(stream);
                    }
                }
            }
            catch (Exception ex) { failure = ex; }
            finally { window?.Close(); Dispatcher.CurrentDispatcher.InvokeShutdown(); }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        Assert.True(thread.Join(TimeSpan.FromSeconds(30)), "Project UI check timed out.");
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void Pages_RenderAtMinimumAndDefaultSizes_InBothThemes(bool zapTarget)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            MainWindow? window = null;
            var bindingErrors = new BindingErrors();
            try
            {
                PresentationTraceSources.DataBindingSource.Listeners.Add(bindingErrors);
                window = new MainWindow(false);
                var workspace = (TabControl)window.FindName("Workspace");
                var navigation = (ListBox)window.FindName("Navigation");
                var layoutRoot = (FrameworkElement)window.Content;
                var snapshotDirectory = Environment.GetEnvironmentVariable("SCOPEPILOT_UI_SNAPSHOTS");
                var model = (MainViewModel)window.DataContext;
                model.HandoffTargetIndex = zapTarget ? 1 : 0;
                // Long detail text exercises overflow independently of empty-state rendering.
                var request = new ObservedRequest { Method = "GET", Url = "https://example.test/account/profile?section=notifications", StatusCode = 200, Role = "一般ユーザー", ContentType = "text/html", Source = "fast-crawl" };
                var candidate = new DiagnosticCandidate { Selected = true, Representative = request, Category = "認証・認可", SimilarCount = 24, Reason = "利用者ごとの表示内容が変わるため、静的ページとは断定できません。", DiagnosticCaution = "異なる認証ロールで参照可能な情報を確認してください。" + new string('。', 200), DecisionTrace = string.Join(Environment.NewLine, Enumerable.Repeat("GETリクエスト → 認証状態による応答の違い → 診断対象として採用", 20)), GuidelineBasis = "選択された参照基準" };
                var finding = new DiagnosticFinding { Title = "アクセス制御の確認", Description = candidate.Reason };
                model.SelectedFinding = new DiagnosticFinding { Title = "アクセス制御の確認", Description = candidate.Reason, Evidence = candidate.DecisionTrace, Limitations = "別のロールでの検証は未実施です。" };
                model.SelectedRun = new ExplorationRunSummary("preview", "C:\\example\\runs\\preview", DateTimeOffset.Now, "partial", "部分結果", 123, 22, 18, 4, "一部の通信を取得できませんでした。", candidate.DecisionTrace);
                foreach (var populated in new[] { false, true })
                {
                if (populated)
                {
                    model.Project.ExplorationDocument = new()
                    {
                        FileName = "操作手順と画面仕様_" + new string('長', 80) + ".md",
                        Content = "# 操作手順\n一覧から詳細を閲覧する。"
                    };
                    model.Project.Requests.Add(request);
                    model.Project.Candidates.Add(candidate);
                    model.FilteredCandidates.Add(candidate);
                    model.Project.Findings.Add(finding);
                    model.Project.DiagnosticObservations.Add(new DiagnosticObservation
                    {
                        Title = "Missing anti-clickjacking header", Severity = "1", Confidence = "2",
                        Url = "https://example.test/account/profile", RuleId = "10020", Method = "GET", Role = "一般ユーザー"
                    });
                    model.RunHistory.Add(model.SelectedRun!);
                    model.Project.ApiRequests.Add(new ApiRequestDraft
                    {
                        Method = "POST", Url = "https://example.test/v1/pets", HeadersText = "Content-Type: application/json\nAuthorization: <TOKEN>",
                        Body = "{\"name\":\"sample\"}", Summary = "文書に記載された登録処理", SourceReference = "#/paths/~1pets/post",
                        UnresolvedValues = ["Authorization: <TOKEN>"], Notes = [new string('注', 200)]
                    });
                    window.DataContext = null;
                    window.DataContext = model;
                }
                foreach (var apiMode in new[] { false, true })
                {
                model.ProjectModeIndex = apiMode ? 1 : 0;
                window.Dispatcher.Invoke(() => { }, DispatcherPriority.ContextIdle);
                foreach (var dark in new[] { false, true })
                foreach (var size in new[] { new Size(960, 700), new Size(1360, 900) })
                {
                    ThemeService.Apply(window, dark);
                    window.Width = size.Width;
                    window.Height = size.Height;
                    foreach (var item in navigation.Items.OfType<ListBoxItem>().Where(x => x.Tag is string))
                    {
                        navigation.SelectedItem = item;
                        Assert.Equal(int.Parse((string)item.Tag), workspace.SelectedIndex);
                        layoutRoot.Measure(size);
                        layoutRoot.Arrange(new Rect(size));
                        layoutRoot.UpdateLayout();
                        window.Dispatcher.Invoke(() => { }, DispatcherPriority.ContextIdle);
                        if (populated && workspace.SelectedIndex == 3) model.SelectedCandidate = candidate;
                        if (populated && workspace.SelectedIndex == 8) model.SelectedApiRequest = model.Project.ApiRequests.First();
                        Assert.True(workspace.ActualWidth >= 680, $"Workspace width: {workspace.ActualWidth}");
                        Assert.True(workspace.ActualHeight >= 400);
                        if (item.Tag is string page && new[] { "0", "1", "2", "3", "4", "5", "6", "7", "8" }.Contains(page))
                            Assert.Contains(Descendants<Button>(workspace).Where(IsShownInLayout), button => button.Command == model.SaveCommand ||
                                System.Windows.Automation.AutomationProperties.GetName(button) == "APIリクエストを保存");
                        if (item.Tag is "0")
                        {
                            var documentSection = (GroupBox)window.FindName("ExplorationDocumentSection");
                            Assert.Equal(apiMode ? Visibility.Collapsed : Visibility.Visible, documentSection.Visibility);
                            var proxySection = (GroupBox)window.FindName("ExplorationProxySection");
                            Assert.Equal(apiMode ? Visibility.Collapsed : Visibility.Visible, proxySection.Visibility);
                            if (!apiMode)
                            {
                                var proxyHeading = Assert.Single(Descendants<TextBlock>(proxySection), x => x.Text == "探索用プロキシ");
                                Assert.Equal(((SolidColorBrush)window.Resources["TextPrimary"]).Color, ((SolidColorBrush)proxyHeading.Foreground).Color);
                                var providerSelector = Assert.Single(Descendants<ListBox>(proxySection));
                                Assert.Equal(3, providerSelector.Items.Count);
                                Assert.Equal(model.ExplorationProxyModeIndex, providerSelector.SelectedIndex);
                                var documentLabel = (TextBlock)window.FindName("ExplorationDocumentLabel");
                                var selectButton = (Button)window.FindName("ReadExplorationDocumentButton");
                                var selectPoint = selectButton.TransformToAncestor(documentSection).Transform(new Point());
                                var labelPoint = documentLabel.TransformToAncestor(documentSection).Transform(new Point());
                                Assert.True(selectPoint.Y >= labelPoint.Y + documentLabel.ActualHeight);
                                Assert.Equal(((SolidColorBrush)window.Resources["TextPrimary"]).Color, ((SolidColorBrush)documentLabel.Foreground).Color);
                                var heading = Assert.Single(Descendants<TextBlock>(documentSection), x => x.Text == "入力ドキュメント（仕様書・操作手順）");
                                Assert.Equal(((SolidColorBrush)window.Resources["TextPrimary"]).Color, ((SolidColorBrush)heading.Foreground).Color);
                                Assert.Equal(model.ExplorationDocumentName, documentLabel.Text);
                                if (!string.IsNullOrWhiteSpace(snapshotDirectory))
                                {
                                    var documentBitmap = new RenderTargetBitmap((int)Math.Ceiling(documentSection.ActualWidth),
                                        (int)Math.Ceiling(documentSection.ActualHeight), 96, 96, PixelFormats.Pbgra32);
                                    var documentVisual = new DrawingVisual();
                                    using (var drawing = documentVisual.RenderOpen())
                                        drawing.DrawRectangle(new VisualBrush(documentSection), null,
                                            new Rect(0, 0, documentSection.ActualWidth, documentSection.ActualHeight));
                                    documentBitmap.Render(documentVisual);
                                    var documentEncoder = new PngBitmapEncoder();
                                    documentEncoder.Frames.Add(BitmapFrame.Create(documentBitmap));
                                    Directory.CreateDirectory(snapshotDirectory);
                                    using var documentStream = File.Create(Path.Combine(snapshotDirectory,
                                        $"reference-document-{(populated ? "filled" : "empty")}-{(dark ? "dark" : "light")}-{size.Width}.png"));
                                    documentEncoder.Save(documentStream);
                                    var proxyBitmap = new RenderTargetBitmap((int)Math.Ceiling(proxySection.ActualWidth),
                                        (int)Math.Ceiling(proxySection.ActualHeight), 96, 96, PixelFormats.Pbgra32);
                                    var proxyVisual = new DrawingVisual();
                                    using (var drawing = proxyVisual.RenderOpen())
                                        drawing.DrawRectangle(new VisualBrush(proxySection), null,
                                            new Rect(0, 0, proxySection.ActualWidth, proxySection.ActualHeight));
                                    proxyBitmap.Render(proxyVisual);
                                    var proxyEncoder = new PngBitmapEncoder();
                                    proxyEncoder.Frames.Add(BitmapFrame.Create(proxyBitmap));
                                    using var proxyStream = File.Create(Path.Combine(snapshotDirectory,
                                        $"exploration-proxy-{(dark ? "dark" : "light")}-{size.Width}.png"));
                                    proxyEncoder.Save(proxyStream);
                                }
                            }
                        }
                        foreach (var grid in Descendants<DataGrid>(workspace).Where(IsShownInLayout))
                            Assert.True(grid.ActualHeight >= 90, $"Page {item.Tag}: table lost its usable height.");
                        if (zapTarget && (string)item.Tag == "6")
                        {
                            var reportButton = (Button)window.FindName("ZapJapaneseReportButton");
                            Assert.True(IsShownInLayout(reportButton));
                            var bounds = reportButton.TransformToAncestor(layoutRoot).TransformBounds(new Rect(reportButton.RenderSize));
                            Assert.InRange(bounds.Bottom, 1, size.Height);
                            Assert.InRange(bounds.Right, 1, size.Width);
                        }
                        if (!string.IsNullOrWhiteSpace(snapshotDirectory))
                        {
                            Directory.CreateDirectory(snapshotDirectory);
                            var bitmap = new RenderTargetBitmap((int)size.Width, (int)size.Height, 96, 96, PixelFormats.Pbgra32);
                            bitmap.Render(layoutRoot);
                            var encoder = new PngBitmapEncoder();
                            encoder.Frames.Add(BitmapFrame.Create(bitmap));
                            using var stream = File.Create(Path.Combine(snapshotDirectory, $"{(zapTarget ? "zap" : "burp")}-{(apiMode ? "api" : "web")}-{(populated ? "filled" : "empty")}-{(dark ? "dark" : "light")}-{size.Width}-page{item.Tag}.png"));
                            encoder.Save(stream);
                        }
                    }
                }
                }
                }
                Assert.Empty(bindingErrors.Errors);
            }
            catch (Exception ex) { failure = ex; }
            finally
            {
                window?.Close();
                PresentationTraceSources.DataBindingSource.Listeners.Remove(bindingErrors);
                Dispatcher.CurrentDispatcher.InvokeShutdown();
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        Assert.True(thread.Join(TimeSpan.FromSeconds(60)), "UI layout check timed out.");
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }

    private static IEnumerable<T> Descendants<T>(DependencyObject parent) where T : DependencyObject
    {
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++)
        {
            var child = VisualTreeHelper.GetChild(parent, i);
            if (child is T match) yield return match;
            foreach (var descendant in Descendants<T>(child)) yield return descendant;
        }
    }
    private static bool IsShownInLayout(DependencyObject element)
    {
        for (var current = element; current is not null; current = VisualTreeHelper.GetParent(current))
            if (current is FrameworkElement { Visibility: not Visibility.Visible }) return false;
        return true;
    }

    private sealed class BindingErrors : TraceListener
    {
        public List<string> Errors { get; } = [];
        public override void Write(string? message) { if (message?.Contains("Error:") == true) Errors.Add(message); }
        public override void WriteLine(string? message) => Write(message);
    }
}
