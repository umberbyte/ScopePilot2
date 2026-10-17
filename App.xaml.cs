using System.Configuration;
using System.Data;
using System.Windows;

namespace ScopePilot;

/// <summary>
/// Interaction logic for App.xaml
/// </summary>
public partial class App : Application
{
    // Inno Setup checks this mutex before replacing application files.
    private readonly System.Threading.Mutex installerMutex = new(false, @"Local\ScopePilot.Application");

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        ShutdownMode = ShutdownMode.OnExplicitShutdown;
        var workspace = new MainWindow(false);
        try
        {
            while (true)
            {
                var chooser = new ProjectStartupWindow();
                MainWindow = chooser;
                if (chooser.ShowDialog() != true || chooser.SelectedAction == ProjectStartupAction.Cancel)
                {
                    workspace.Close();
                    Shutdown();
                    return;
                }
                MainWindow = workspace;
                var opened = await workspace.StartProjectAsync(chooser.SelectedAction);
                if (!opened) continue;
                MainWindow = workspace;
                ShutdownMode = ShutdownMode.OnMainWindowClose;
                workspace.Show();
                return;
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show($"プロジェクトを準備できませんでした。\n{ex.Message}", "ScopePilot", MessageBoxButton.OK, MessageBoxImage.Error);
            workspace.Close();
            Shutdown(1);
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        installerMutex.Dispose();
        base.OnExit(e);
    }
}

