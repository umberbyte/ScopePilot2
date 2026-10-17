using ScopePilot.Domain;

namespace ScopePilot.Services;

public static class GuidelineContext
{
    public const string FileName = "selection-guidance.md";
    public static string Text => Build(new GuidelineSelectionOptions());

    public static string Build(GuidelineSelectionOptions options)
    {
        var sections = new List<string>();
        if (options.Wstg) sections.Add("1. WSTGのエントリーポイント調査を軸に、クエリ、リクエスト本文、フォーム、認証状態、複数段階操作、API、WebSocket、リダイレクト、403/5xxなどを確認候補にする。ScopePilotの高速巡回では本文・Cookie・WebSocketを完全収集していないため、不明点として残す。");
        if (options.Asvs || options.OwaspTop10) sections.Add("2. " + string.Join("と", new[] { options.Asvs ? "ASVS 5.0" : null, options.OwaspTop10 ? "OWASP Top 10:2025" : null }.Where(x => x is not null)) + "は認証、認可、入力処理、設定、例外処理等の確認観点に使う。Top 10の項目名だけで脆弱性を判定しない。特に利用者・ロール・テナント・オブジェクト間の認可境界、認証・セッション、状態変更、ファイル処理、入力点を優先する。");
        if (options.WebAppPentestGuidelines) sections.Add("3. 日本のWebAppPentestGuidelinesは手動診断項目の確認に使う。自動選定で除外したページが安全と証明されたわけではない。CMS記事等の同一テンプレートは代表1件で確認し、個別ページへの繰り返し診断を避ける。");
        if (options.Aisvs) sections.Add("4. AISVS 1.0は実際にAI機能があると確認したときだけ適用する。URLにAI関連語があるだけでは確定しない。");
        if (options.CloudNativeTop10) sections.Add("5. Cloud Native Top 10は対象が該当するクラウドネイティブ構成の場合だけ参考にする。リンク先リポジトリはアーカイブ済み。");
        if (options.Ds221) sections.Add("6. デジタル庁DS-221は公共部門向けの参考資料として、案件への適用可否を人が決める。Webアプリ・API、認証・アクセス制御、業務ロジック等の確認観点を参照する。");

        var sources = new List<string>();
        if (options.WebAppPentestGuidelines) sources.Add("- WebAppPentestGuidelines: https://github.com/WebAppPentestGuidelines/WebAppPentestGuidelines/blob/master/WebAppPentestGuidelines/WebAppPentestGuidelines.pdf");
        if (options.OwaspTop10) sources.Add("- OWASP Top 10:2025: https://top10.owasp.org/2025/");
        if (options.CloudNativeTop10) sources.Add("- OWASP Cloud Native Application Security Top 10: https://github.com/owasp/www-project-cloud-native-application-security-top-10");
        if (options.Aisvs) sources.Add("- OWASP AISVS: https://github.com/OWASP/AISVS");
        if (options.Asvs) sources.Add("- OWASP ASVS: https://owasp.org/projects/asvs");
        if (options.Wstg) sources.Add("- OWASP WSTG: https://owasp.org/projects/web-security-testing-guide");
        if (options.Ds221) sources.Add("- デジタル庁DS-221: https://www.digital.go.jp/resources/standard_guidelines#ds221");

        return $"""
            # 診断対象の一次選定基準

            この文書は案件設定で有効にした公開ガイドラインだけを、ScopePilotの事前調査へ適用するための短い運用要約です。原文の代替や網羅的な診断基準ではありません。URL・メソッド・応答メタデータだけで安全性を断定しないでください。許可originと禁止操作を優先してください。

            {string.Join(Environment.NewLine, sections)}

            成功したGET HTMLでも、画面を確認していない、フォームがある、クライアント側通信がある、認証状態で表示が変わる場合は静的として除外しない。静的画面を代表化しても共通設定やヘッダーの確認は別途必要です。

            出典（特定の要件番号を断定する前に原文を確認すること）:
            {string.Join(Environment.NewLine, sources)}
            """;
    }
}
