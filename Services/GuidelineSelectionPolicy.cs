using System.Text.RegularExpressions;
using ScopePilot.Domain;

namespace ScopePilot.Services;

// These are ScopePilot's observable triage signals, not a claim that any guideline
// can prove a request safe or vulnerable from URL and response metadata alone.
public static class GuidelineSelectionPolicy
{
    private static readonly HashSet<string> CacheKeys = new(StringComparer.OrdinalIgnoreCase)
        { "_", "v", "ver", "version", "cb", "cache", "cachebuster", "rev", "hash" };
    private static readonly string[] AssetExtensions =
        [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico", ".css", ".js", ".mjs", ".woff", ".woff2", ".ttf", ".map", ".mp3", ".mp4"];
    private static readonly Regex AuthPath = PathWords("login|logout|signin|sign-in|signout|sign-out|auth|oauth|sso|password|reset|session|token|mfa|register|signup");
    private static readonly Regex AccessPath = PathWords("admin|role|permission|account|member|user|users|profile|tenant|organization|organisation|invoice|orders?");
    private static readonly Regex FilePath = PathWords("upload|download|file|files|export|import|attachment|attachments|document|documents|report|reports");
    private static readonly Regex InputPath = PathWords("search|query|filter|form|contact|cart|checkout|payment|submit");
    private static readonly Regex IntegrationPath = PathWords("webhook|callback|redirect|integration|proxy|fetch|url");
    private static readonly Regex AiPath = PathWords("ai|llm|chat|prompt|completion|completions|model|models|agent|agents|rag|embedding|embeddings|inference");
    private static readonly Regex CloudPath = PathWords("actuator|metrics|health|ready|readiness|k8s|kube|metadata|openapi|swagger");
    private static readonly Regex ApiPath = PathWords("api|apis|graphql|ajax|rpc|rest|v[0-9]+");

    public static SelectionAssessment Evaluate(ObservedRequest request, GuidelineSelectionOptions? guidelines = null)
    {
        guidelines ??= new GuidelineSelectionOptions();
        if (!Uri.TryCreate(request.Url, UriKind.Absolute, out var uri))
            return new(true, "要確認", "低", "URLを解析できないため手動確認が必要です。", "元の通信を確認してください。", ["URL解析失敗"], Enabled(guidelines.Wstg, "WSTG-INFO-06"), false, false);

        var method = (request.Method ?? "GET").ToUpperInvariant();
        var queryNames = QueryNames(uri.Query).Where(x => !CacheKeys.Contains(x)).ToArray();
        var contentType = (request.ContentType ?? string.Empty).Split(';', 2)[0].Trim();
        var path = uri.AbsolutePath;
        var unusualStatus = request.StatusCode is >= 300 and < 400 or 401 or 403 or >= 500;
        var isAsset = method is "GET" or "HEAD" && !unusualStatus &&
            (AssetExtensions.Any(x => path.EndsWith(x, StringComparison.OrdinalIgnoreCase)) ||
             contentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase) ||
             contentType.StartsWith("font/", StringComparison.OrdinalIgnoreCase) ||
             contentType.StartsWith("audio/", StringComparison.OrdinalIgnoreCase) ||
             contentType.StartsWith("video/", StringComparison.OrdinalIgnoreCase) ||
             contentType.Equals("text/css", StringComparison.OrdinalIgnoreCase) ||
             contentType.Contains("javascript", StringComparison.OrdinalIgnoreCase));
        if (isAsset)
            return new(false, "静的アセット", "高", "画像・スタイル・スクリプト等の参照通信を個別診断から除外します。", "認可が必要な配信や動的生成が判明した場合は再採用してください。", ["静的アセット形式"], Enabled(guidelines.Wstg, "WSTG-INFO-06"), true, false);

        var signals = new List<string>();
        var references = new HashSet<string>(StringComparer.Ordinal);
        AddReference(references, guidelines.Wstg, "WSTG-INFO-06");
        AddReference(references, guidelines.Asvs, "OWASP ASVS 5.0");
        string category;
        AddReference(references, guidelines.WebAppPentestGuidelines, "WebAppPentestGuidelines v1.2");
        if (AuthPath.IsMatch(path) && (guidelines.WebAppPentestGuidelines || guidelines.OwaspTop10 || guidelines.Asvs))
        {
            category = "認証・セッション";
            signals.Add("認証・セッション機能を示すURL");
            AddReference(references, guidelines.OwaspTop10, "OWASP Top 10:2025 A07");
        }
        else if (AccessPath.IsMatch(path) && (guidelines.WebAppPentestGuidelines || guidelines.OwaspTop10 || guidelines.Asvs))
        {
            category = "管理・権限";
            signals.Add("利用者・権限・業務データを示すURL");
            AddReference(references, guidelines.OwaspTop10, "OWASP Top 10:2025 A01");
        }
        else if ((FilePath.IsMatch(path) || contentType.Equals("application/pdf", StringComparison.OrdinalIgnoreCase)) &&
                 (guidelines.WebAppPentestGuidelines || guidelines.OwaspTop10 || guidelines.Asvs))
        {
            category = "ファイル処理";
            signals.Add("ファイルの取得・送信・生成を示すURLまたは応答");
            AddReference(references, guidelines.OwaspTop10, "OWASP Top 10:2025 A01");
        }
        else if (AiPath.IsMatch(path) && guidelines.Aisvs)
        {
            category = "AI機能";
            signals.Add("AI機能を示すURL。実際にAI機能か要確認");
            references.Add("OWASP AISVS 1.0（AI機能の場合のみ）");
        }
        else if (CloudPath.IsMatch(path) && guidelines.CloudNativeTop10)
        {
            category = "運用・クラウド機能";
            signals.Add("管理・運用エンドポイントを示すURL");
            references.Add("OWASP Cloud Native Top 10（該当構成の場合のみ）");
        }
        else if (IntegrationPath.IsMatch(path) && (guidelines.WebAppPentestGuidelines || guidelines.OwaspTop10 || guidelines.Asvs || guidelines.Wstg))
        {
            category = "外部連携";
            signals.Add("外部連携・転送を示すURL");
            AddReference(references, guidelines.OwaspTop10, "OWASP Top 10:2025 A05");
        }
        else if (InputPath.IsMatch(path) && (guidelines.WebAppPentestGuidelines || guidelines.OwaspTop10 || guidelines.Asvs || guidelines.Wstg))
        {
            category = "検索・入力";
            signals.Add("入力機能を示すURL");
            AddReference(references, guidelines.OwaspTop10, "OWASP Top 10:2025 A05");
        }
        else if ((ApiPath.IsMatch(path) || contentType.Contains("json", StringComparison.OrdinalIgnoreCase) ||
                 contentType.Contains("xml", StringComparison.OrdinalIgnoreCase)) &&
                 (guidelines.Ds221 || guidelines.Wstg || guidelines.Asvs))
        {
            category = "API";
            signals.Add("API形式またはAPIを示すURL");
            AddReference(references, guidelines.Ds221, "デジタル庁 DS-221（適用対象の場合のみ）");
        }
        else if (queryNames.Length > 0) category = "入力パラメーター";
        else if (method is not ("GET" or "HEAD" or "OPTIONS")) category = "状態変更";
        else category = "画面・参照API";

        if (method is not ("GET" or "HEAD" or "OPTIONS") && (guidelines.WebAppPentestGuidelines || guidelines.OwaspTop10 || guidelines.Asvs || guidelines.Wstg))
        {
            signals.Add($"{method}メソッド。状態変更やリクエスト本文の可能性");
            AddReference(references, guidelines.OwaspTop10, "OWASP Top 10:2025 A01");
        }
        if (queryNames.Length > 0 && (guidelines.Wstg || guidelines.OwaspTop10 || guidelines.Asvs || guidelines.WebAppPentestGuidelines))
        {
            signals.Add($"入力パラメーター: {string.Join(", ", queryNames.Take(10))}");
            AddReference(references, guidelines.OwaspTop10, "OWASP Top 10:2025 A05");
        }
        if (request.FormCount > 0 && (guidelines.Wstg || guidelines.OwaspTop10 || guidelines.Asvs || guidelines.WebAppPentestGuidelines))
        {
            signals.Add($"画面でフォーム{request.FormCount}件を観測" +
                (request.FormFieldNames is { Length: > 0 } ? $"（{string.Join(", ", request.FormFieldNames.Take(10))}）" : string.Empty));
            AddReference(references, guidelines.OwaspTop10, "OWASP Top 10:2025 A05");
        }
        if (unusualStatus && (guidelines.Wstg || guidelines.OwaspTop10 || guidelines.Asvs || guidelines.Ds221))
        {
            signals.Add($"HTTP {request.StatusCode}。遷移・アクセス制御・例外応答を確認");
            if (request.StatusCode is 401 or 403) AddReference(references, guidelines.OwaspTop10, "OWASP Top 10:2025 A01/A07");
            if (request.StatusCode >= 500) AddReference(references, guidelines.OwaspTop10, "OWASP Top 10:2025 A10");
        }
        if (ObservedRequestIdentity.IsAuthenticatedRole(request.Role) && (guidelines.WebAppPentestGuidelines || guidelines.OwaspTop10 || guidelines.Asvs))
        {
            signals.Add($"認証状態: {request.Role}");
            AddReference(references, guidelines.OwaspTop10, "OWASP Top 10:2025 A01");
        }

        var passiveHtml = signals.Count == 0 && request.PageInspected && request.FormCount == 0 &&
            method is "GET" or "HEAD" && request.StatusCode is >= 200 and < 300 &&
            (guidelines.Wstg || guidelines.WebAppPentestGuidelines) &&
            contentType.Equals("text/html", StringComparison.OrdinalIgnoreCase);
        if (passiveHtml)
            return new(false, "静的画面候補", "中", "画面を確認した範囲ではフォーム・URL入力点・重要機能の手掛かりがありません。同一テンプレートは代表化し、個別診断から除外します。", "静的と証明したわけではありません。クライアント側通信、認証後の表示差、共通ヘッダー等は別途確認してください。", ["画面確認済み", "フォームなし", "URL入力点なし"], EnabledReferences(guidelines, "WSTG-INFO-06", "WebAppPentestGuidelines v1.2"), false, true);

        if (signals.Count == 0) signals.Add("画面の入力要素・認証差・本文を未確認。静的と断定できない");
        var caution = category switch
        {
            "認証・セッション" => "認証回避、セッション失効、試行制御、利用者間の状態分離を確認してください。",
            "管理・権限" => "機能単位・データ単位の認可と利用者・ロール・テナント間の分離を確認してください。",
            "ファイル処理" => "ファイルの形式、保存先、ダウンロード認可、パスや名前の扱いを確認してください。",
            "AI機能" => "実際にAI機能なら、プロンプト、検索知識、ツール実行、出力の権限境界を確認してください。",
            "運用・クラウド機能" => "運用情報の露出とアクセス制御を確認してください。クラウド固有基準は構成が該当する場合だけ適用します。",
            "外部連携" => "転送先・コールバック先の制限と認可を確認してください。",
            "検索・入力" or "入力パラメーター" => "入力値の検証、出力時の扱い、認可条件を確認してください。",
            "API" => "APIの認証、オブジェクト単位の認可、入力・出力の検証を確認してください。",
            _ => "画面内フォーム、クライアント側通信、認証状態による差を確認してください。"
        };
        if (queryNames.Length > 0) caution += $" 入力値（{string.Join(", ", queryNames.Take(10))}）の改変・境界値を確認してください。";
        if (method is not ("GET" or "HEAD" or "OPTIONS")) caution += " 再送時の副作用と操作権限に注意してください。";
        if (unusualStatus) caution += " リダイレクト先またはエラー応答を確認してください。";
        if (request.StatusCode is null) caution += " HTTPステータスが未取得のため実際の応答を確認してください。";
        if (string.IsNullOrWhiteSpace(contentType)) caution += " Content-Typeが未取得のため応答形式を確認してください。";
        return new(true, category, signals.Count > 0 && signals[0].StartsWith("画面の入力要素", StringComparison.Ordinal) ? "低" : "中",
            $"{category}に分類しました。根拠: {string.Join("／", signals)}。", caution, signals.ToArray(), references.Order(StringComparer.Ordinal).ToArray(), false, false);
    }

    private static Regex PathWords(string words) => new($@"(?:^|[/_-])(?:{words})(?=$|[/_.-])", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static string[] Enabled(bool enabled, params string[] values) => enabled ? values : [];

    private static void AddReference(HashSet<string> references, bool enabled, string value)
    {
        if (enabled) references.Add(value);
    }

    private static string[] EnabledReferences(GuidelineSelectionOptions options, params string[] values) => values
        .Where(value => value switch
        {
            "WSTG-INFO-06" => options.Wstg,
            "WebAppPentestGuidelines v1.2" => options.WebAppPentestGuidelines,
            _ => true
        }).ToArray();

    private static IEnumerable<string> QueryNames(string query) => query.TrimStart('?')
        .Split('&', StringSplitOptions.RemoveEmptyEntries)
        .Select(x => Uri.UnescapeDataString(x.Split('=', 2)[0]))
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .Order(StringComparer.OrdinalIgnoreCase);
}

public sealed record SelectionAssessment(bool Selected, string Category, string Confidence, string Reason,
    string Caution, string[] Signals, string[] References, bool StaticAsset, bool PassiveHtml);
