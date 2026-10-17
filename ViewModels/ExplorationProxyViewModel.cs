using ScopePilot.Domain;
using ScopePilot.Services;

namespace ScopePilot.ViewModels;

public sealed partial class MainViewModel
{
    private readonly ExplorationProxyService _explorationProxy = new();
    public bool CanEditExplorationSettings => !IsRunning;
    public int ExplorationProxyModeIndex
    {
        get => (int)Project.ExplorationProxy.Mode;
        set
        {
            if (IsRunning || value is < 0 or > 2) return;
            Project.ExplorationProxy.Mode = (ExplorationProxyMode)value;
            RaisePropertyChanged();
            RefreshSaveState();
        }
    }

    private async Task CaptureZapHarAsync(ExplorationProxySession session, string path, int start, string role, string kind = "har")
    {
        if (session.ZapApi is null || File.Exists(path)) return;
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var count = await session.ZapApi.ExportHarAsync(path, start, Math.Max(1, Project.MaxRequests), Project.AllowedOrigins, timeout.Token);
            if (count > 0) Project.Inputs.Add((await ProjectPaths.EvidenceAsync(Project, path, kind)) with { Role = role });
            Log($"ZAP通信記録: {role} / {count:N0}件 / {Path.GetFileName(path)}");
        }
        catch (Exception ex) { Log($"ZAPのHARを保存できませんでした: {ex.Message}。Playwrightの観測記録を確認してください。"); }
    }
}
