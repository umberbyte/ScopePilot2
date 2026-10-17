using ScopePilot.Domain;

namespace ScopePilot.Services;

public sealed class CandidateSelector
{
    public IReadOnlyList<DiagnosticCandidate> Select(IEnumerable<ObservedRequest> requests, GuidelineSelectionOptions? guidelines = null) => requests
        .Where(x => Uri.TryCreate(x.Url, UriKind.Absolute, out _))
        .GroupBy(x => $"{(x.Method ?? "GET").ToUpperInvariant()} {UrlPatternNormalizer.NormalizeForSelection(x.Url ?? string.Empty)}", StringComparer.OrdinalIgnoreCase)
        .Select(group => CreateCandidate(group, guidelines ?? new GuidelineSelectionOptions()))
        .OrderByDescending(x => x.Selected)
        .ThenByDescending(x => Score(x))
        .ThenBy(x => x.Pattern, StringComparer.OrdinalIgnoreCase)
        .ToArray();

    private static DiagnosticCandidate CreateCandidate(IGrouping<string, ObservedRequest> group, GuidelineSelectionOptions guidelines)
    {
        var assessed = group.Select(request => (Request: request, Assessment: GuidelineSelectionPolicy.Evaluate(request, guidelines))).ToArray();
        var chosen = assessed.OrderByDescending(x => x.Assessment.Selected)
            .ThenByDescending(x => x.Request.FormCount)
            .ThenByDescending(x => x.Request.PageInspected)
            .First();
        var evidence = assessed.Where(x => x.Assessment.Selected == chosen.Assessment.Selected)
            .SelectMany(x => x.Assessment.Signals).Distinct(StringComparer.Ordinal).ToArray();
        var references = assessed.SelectMany(x => x.Assessment.References).Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal).ToArray();
        var roles = assessed.Select(x => ObservedRequestIdentity.NormalizeRole(x.Request.Role))
            .Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase).ToArray();
        var count = assessed.Length;
        var reason = chosen.Assessment.Reason;
        if (count > 1) reason += $" 同一URL構造の{count:N0}件をまとめ、このURLを代表にしています。";
        var trace = string.Join(Environment.NewLine, new[]
        {
            $"1. URL構造: {group.Key}（同一構造 {count:N0}件）",
            $"2. 代表通信: {chosen.Request.Method} {chosen.Request.Url}",
            $"3. 応答: Status {chosen.Request.StatusCode?.ToString() ?? "不明"}, Content-Type {(string.IsNullOrWhiteSpace(chosen.Request.ContentType) ? "不明" : chosen.Request.ContentType)}",
            $"4. 画面確認: {(chosen.Request.PageInspected ? $"実施、フォーム{chosen.Request.FormCount}件" : "未実施または記録なし")}",
            $"5. 観測ロール: {string.Join("、", roles)}",
            $"6. 判定材料: {string.Join("／", evidence)}",
            $"7. 参照基準: {string.Join("、", references)}",
            $"最終判定: {(chosen.Assessment.Selected ? "採用" : "除外候補")}。メタデータによる一次選定であり、安全性や脆弱性の証明ではありません。"
        });
        return new DiagnosticCandidate
        {
            Selected = chosen.Assessment.Selected,
            Confidence = chosen.Assessment.Confidence,
            Category = chosen.Assessment.Category,
            Decision = chosen.Assessment.Selected ? "候補" : "除外候補",
            Reason = reason,
            DecisionTrace = trace,
            DiagnosticCaution = chosen.Assessment.Caution,
            GuidelineBasis = string.Join("、", references),
            Pattern = group.Key,
            SimilarCount = count,
            Representative = chosen.Request
        };
    }

    private static int Score(DiagnosticCandidate candidate)
    {
        var score = (candidate.Representative.Method ?? "GET").ToUpperInvariant() is not ("GET" or "HEAD" or "OPTIONS") ? 20 : 0;
        score += candidate.Category switch
        {
            "認証・セッション" => 40,
            "管理・権限" => 35,
            "ファイル処理" => 30,
            "AI機能" => 30,
            "運用・クラウド機能" => 27,
            "外部連携" => 25,
            "状態変更" => 20,
            "API" or "検索・入力" or "入力パラメーター" => 15,
            _ => 5
        };
        return score;
    }
}
