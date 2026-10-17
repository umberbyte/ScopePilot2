using ScopePilot.Services;

namespace ScopePilot.ViewModels;

public sealed partial class MainViewModel
{
    private bool _authenticationWaiting;
    private string _authenticationRole = "";
    private string _authenticationStatusText = "";
    public Action<string>? ShowAuthenticationPrompt { get; set; }
    public bool AuthenticationWaiting { get => _authenticationWaiting; private set => SetProperty(ref _authenticationWaiting, value); }
    public string AuthenticationRole { get => _authenticationRole; set => SetProperty(ref _authenticationRole, value); }
    public string AuthenticationStatusText { get => _authenticationStatusText; private set => SetProperty(ref _authenticationStatusText, value); }
    public string ResumeActionText => AuthenticationWaiting ? "ログイン後のページを確認して再開" : "手動操作を完了して再開";
    public string[] AuthenticationRoleOptions => RoleOptions.Where(role => !AuthenticationFlow.IsAnonymous(role))
        .DefaultIfEmpty("認証済み（ロール未確認）").ToArray();

    internal void PrepareAuthenticationIntervention(string detail)
    {
        var request = AuthenticationFlow.ParseRequest(detail);
        AuthenticationWaiting = request?.Authentication == true;
        RaisePropertyChanged(nameof(ResumeActionText));
        RaisePropertyChanged(nameof(AuthenticationRoleOptions));
        if (!AuthenticationWaiting) return;
        AuthenticationRole = AuthenticationFlow.IsAnonymous(Project.ActiveRole) ? AuthenticationRoleOptions[0] : Project.ActiveRole;
        AuthenticationStatusText = "認証待ち：現在の探索ブラウザにユーザー名・パスワードを入力してください。";
        var message = $"認証情報の入力が必要です。\nページ: {AuthenticationFlow.DisplayUrl(request!.Page)}\n\n現在開いている探索ブラウザにユーザー名・パスワードを直接入力してログインしてください。\nその後、このアプリで認証後のロールを選び、［ログイン後のページを確認して再開］を押してください。";
        // 入力ドキュメントの認証記載（所在・方式のみ。秘密値は文書本体にある）を参考として併記する。
        var hints = Project.ExplorationDocument.Hints;
        if (hints?.Authentication.Length > 0)
        {
            var references = string.Join("\n", hints.Authentication.Take(3)
                .Select(h => $"・{h.Role}: {h.Method}（{h.Location}）{(string.IsNullOrWhiteSpace(h.Note) ? string.Empty : " " + h.Note)}"));
            message += $"\n\n参考（入力ドキュメント{hints.SourceDocumentName}の記載。パスワード等の値は文書本体を確認してください）:\n{references}";
        }
        ShowAuthenticationPrompt?.Invoke(message);
    }

    private void OnAuthenticationNavigationDetected(string json)
    {
        try
        {
            var text = AuthenticationFlow.FormatNavigation(json, Project);
            if (text == AuthenticationStatusText) return;
            AuthenticationStatusText = text;
            Log(text);
        }
        catch (Exception ex) when (ex is System.Text.Json.JsonException or KeyNotFoundException or InvalidOperationException) { }
    }

    private void ResetAuthenticationState()
    {
        AuthenticationWaiting = false;
        AuthenticationStatusText = "";
        AuthenticationRole = "";
        RaisePropertyChanged(nameof(ResumeActionText));
    }
}
