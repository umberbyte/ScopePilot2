using System.Collections.Concurrent;
using System.Collections.Specialized;
using System.IO;
using System.Reflection;
using ScopePilot.Domain;
using ScopePilot.ViewModels;

// ScopePilotの動作シミュレーション実行器。GUIが呼ぶのと同じ MainViewModel のコマンド本体
// （探索・候補生成・採用・ZAP診断）をヘッドレスで段階的に実行し、実行ログをファイルへ残す。
// 使い方: ScopePilot.Simulation <phase> [--project <project.scopepilot.json>] [--logdir <directory>]
//   phase = open        案件を開き、文書ヒント抽出AIと画面探索AIをGLM（z.ai・zcode）へ切り替えて保存する
//   phase = explore     探索（文書ヒント抽出→高速クロール→AI画面探索）を実行する
//   phase = candidates  候補を生成し「すべて」を表示して全候補を採用する
//   phase = zap         ZAPアクティブ診断をACTIVE承認付きで実行し、結果を取り込む
internal static class Program
{
    [STAThread]
    private static async Task<int> Main(string[] args)
    {
        // GUIではProgress<string>のハンドラがUIスレッドへ整列される。ヘッドレスでは同期コンテキストが
        // 無いため、VMのログ追加が並行して競合しないよう、単一ワーカーへ整列するコンテキストを置く。
        SynchronizationContext.SetSynchronizationContext(new SerialLogContext());
        if (args.Length == 0) { Console.Error.WriteLine("phase (open|explore|candidates|zap) を指定してください。"); return 2; }
        var phase = args[0];
        var projectPath = Arg(args, "--project") ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "DVWA", "DVWA", "project.scopepilot.json");
        var logDir = Arg(args, "--logdir") ?? Path.Combine(Path.GetDirectoryName(Path.GetFullPath(projectPath)) ?? ".", "simulation", "logs");
        Directory.CreateDirectory(logDir);
        var logPath = Path.Combine(logDir, $"{phase}-{DateTimeOffset.Now:yyyyMMdd-HHmmss}.log");
        await using var logWriter = new StreamWriter(logPath, append: false) { AutoFlush = true };

        var vm = new MainViewModel();
        vm.Logs.CollectionChanged += (_, e) =>
        {
            if (e.Action != NotifyCollectionChangedAction.Add) return;
            foreach (string line in e.NewItems ?? Array.Empty<string>())
            {
                Console.WriteLine(line);
                logWriter.WriteLine(line);
            }
        };
        void Note(string message)
        {
            Console.WriteLine(message);
            logWriter.WriteLine(message);
        }

        if (!await vm.OpenProjectAsync(projectPath, discardConfirmed: true))
        {
            Note($"案件を開けませんでした: {projectPath}");
            return 1;
        }
        Note($"[{phase}] 案件を開きました: {vm.Project.Name} / Status={vm.Project.Status} / Requests={vm.Project.Requests.Count}");

        switch (phase)
        {
            case "open":
                vm.Project.ExplorationDocument.AiProvider = DocumentAiProvider.Glm;
                vm.Project.ExplorationDocument.Model = DocumentAiCatalog.NormalizeModel(DocumentAiProvider.Glm, "glm-5.3");
                vm.Project.ExplorationAi.Provider = DocumentAiProvider.Glm;
                vm.Project.ExplorationAi.Model = DocumentAiCatalog.NormalizeModel(DocumentAiProvider.Glm, "glm-5.3");
                Note($"[$open] 文書ヒントAI={vm.Project.ExplorationDocument.AiProvider}({vm.Project.ExplorationDocument.Model}) / 画面探索AI={vm.Project.ExplorationAi.Provider}({vm.Project.ExplorationAi.Model}) へ切替えます。");
                break;
            case "explore":
                await InvokeTask(vm, "StartExplorationAsync");
                Note($"[$explore] 探索終了 Status={vm.Project.Status} Requests={vm.Project.Requests.Count} Findings={vm.Project.Findings.Count}");
                break;
            case "candidates":
                InvokeVoid(vm, "GenerateCandidates");
                InvokeVoid(vm, "SetCandidateReviewFilter", "すべて");
                var visible = vm.FilteredCandidates.Count;
                Note($"[$candidates] 候補{vm.Project.Candidates.Count}件（表示{visible}件）をすべて採用します。");
                await InvokeTask(vm, "SetVisibleCandidateDecisionAsync", true);
                Note($"[$candidates] 採用後 Selected={vm.Project.Candidates.Count(c => c.Selected)} / 採用済みパターン={vm.Project.AdoptedCandidatePatterns.Count}");
                break;
            case "zap":
                var role = Arg(args, "--role");
                if (!string.IsNullOrWhiteSpace(role) && vm.Project.Roles.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Contains(role))
                {
                    vm.Project.ActiveRole = role;
                    Note($"[$zap] 探索対象ロールを {role} へ切替えます（診断パッケージはこのロールで記録されたHARを使用します）。");
                }
                vm.ZapActiveScanConfirmation = "ACTIVE";
                await InvokeTask(vm, "StartZapAsync");
                Note($"[$zap] ZAP終了 Findings={vm.Project.Findings.Count} LastHandoff={vm.LastBurpExportDirectory}");
                break;
            default:
                Note($"不明なphase: {phase}");
                return 2;
        }

        await InvokeTask(vm, "SaveAsync");
        Note($"[{phase}] 案件を保存しました: {projectPath}");
        return 0;
    }

    private static string? Arg(string[] args, string name)
    {
        for (var i = 0; i < args.Length - 1; i++)
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
        return null;
    }

    private sealed class SerialLogContext : SynchronizationContext
    {
        private readonly BlockingCollection<(SendOrPostCallback Callback, object? State)> _queue = new();
        private readonly int _worker = Environment.CurrentManagedThreadId;

        public SerialLogContext() =>
            Task.Factory.StartNew(() =>
            {
                // ワーカー自身にも同じコンテキストを置く。こうすると await の再開や
                // 再開後に生成される Progress<T> も同じ直列キューへ整列される。
                SynchronizationContext.SetSynchronizationContext(this);
                foreach (var (callback, state) in _queue.GetConsumingEnumerable())
                    callback(state);
            }, TaskCreationOptions.LongRunning);

        public override void Post(SendOrPostCallback d, object? state) => _queue.Add((d, state));

        public override void Send(SendOrPostCallback d, object? state)
        {
            if (Environment.CurrentManagedThreadId == _worker) { d(state); return; }
            using var done = new ManualResetEventSlim();
            Post(_ => { try { d(state); } finally { done.Set(); } }, null);
            done.Wait();
        }
    }

    private static async Task InvokeTask(MainViewModel vm, string name, params object?[] args)
    {
        var method = typeof(MainViewModel).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Instance)
            ?? throw new MissingMethodException(nameof(MainViewModel), name);
        var task = (Task)(method.Invoke(vm, args) ?? throw new InvalidOperationException($"{name} がTaskを返しませんでした。"));
        await task;
    }

    private static void InvokeVoid(MainViewModel vm, string name, params object?[] args)
    {
        var method = typeof(MainViewModel).GetMethod(name, BindingFlags.NonPublic | BindingFlags.Instance)
            ?? throw new MissingMethodException(nameof(MainViewModel), name);
        method.Invoke(vm, args);
    }
}
