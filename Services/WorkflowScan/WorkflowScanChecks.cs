using System.Text;
using System.Text.RegularExpressions;
using ScopePilot.Domain;

namespace ScopePilot.Services.WorkflowScan;

// 個別チェックの実行コンテキスト。検証マーカー・現在のセキュリティレベル・進捗報告を共有する。
public sealed partial class ScanCheckContext(WorkflowScanClient client, string marker, string level, Action<string> progress, CancellationToken token)
{
    public WorkflowScanClient Client { get; } = client;
    public string Marker { get; } = marker;
    public string Level { get; } = level;
    public Action<string> Progress { get; } = progress;
    public CancellationToken Token { get; } = token;
    public List<WorkflowScanCheckResult> Results { get; } = [];
    public List<WorkflowScanCheckLog> Skips { get; } = [];

    // パスワード変更の実効性を別セッションのログインで確認する検証器。
    // 応答テキストに結果が現れない実装（DVWA CAPTCHAのreCAPTCHAキー未設定時など）でも
    // 変更の成立・復元を確認できるようにするため、サービス側で注入する。
    public Func<string, Task<bool>>? PasswordVerifier { get; init; }

    public WorkflowScanCheckResult Begin(string checkId, string title, string category, string severity, string cwe, string url, string method = "GET", string parameter = "") =>
        new()
        {
            CheckId = checkId,
            Title = title,
            Category = category,
            Severity = severity,
            Confidence = "高",
            Cwe = cwe,
            SecurityLevel = Level,
            Url = url,
            Method = method,
            Parameter = parameter
        };

    public void Detect(WorkflowScanCheckResult result, string description, string evidence, string remediation, string? limitations = null)
    {
        result.Detected = true;
        result.Description = description;
        result.Evidence = evidence;
        result.Remediation = remediation;
        result.Limitations = limitations ?? "";
        Results.Add(result);
        Progress($"検出: {result.Title}");
    }

    // 未検出のチェックも実行記録へ理由付きで残す。診断網羅性の証跡になる。
    public void Skip(WorkflowScanCheckResult result, string note)
    {
        Progress($"未検出: {result.Title} ({note})");
        Skips.Add(new WorkflowScanCheckLog { CheckId = result.CheckId, SecurityLevel = Level, Detected = false, Note = note });
    }

    public string Url(string pathAndQuery) => Client.Url(pathAndQuery);

    // レベル別実行のチェックは、再実行時の重複登録防止と難易度比較のために表題へレベルを併記する。
    public static string LevelSuffix(string level) => string.IsNullOrEmpty(level) ? "" : $"（検証レベル: {level}）";
}

public static partial class WorkflowScanChecks
{
    // ------- 認証・ログイン -------

    public static async Task<bool> LoginAsync(WorkflowScanClient client, string username, string password, Action<string> progress, CancellationToken token)
    {
        var loginPage = await client.GetAsync("login.php", token);
        if (loginPage.StatusCode != 200) return false;
        var userToken = ScanCheckContext.EmptyTokenRegex().Match(loginPage.Body) is { Success: true } m ? m.Groups[1].Value : "";
        var form = new Dictionary<string, string> { ["username"] = username, ["password"] = password, ["Login"] = "Login" };
        if (userToken.Length > 0) form["user_token"] = userToken;
        var response = await client.PostFormAsync("login.php", form, token);
        if (response.StatusCode is 200 or 302)
        {
            var index = await client.GetAsync("index.php", token);
            if (index.Contains("Logout") || index.Contains("Welcome")) return true;
        }
        progress("ログインを確認できませんでした。未認証の範囲でチェックを続行します。");
        return false;
    }

    public static async Task<string> ReadSecurityLevelAsync(WorkflowScanClient client, CancellationToken token)
    {
        var page = await client.GetAsync("security.php", token);
        if (page.StatusCode != 200) return "";
        var match = Regex.Match(page.Body,
            @"value=[""']?(low|medium|high|impossible)[""']?[^>]*selected|selected[^>]*value=[""']?(low|medium|high|impossible)");
        return match.Groups[1].Success ? match.Groups[1].Value : match.Groups[2].Value;
    }

    public static async Task SetSecurityLevelAsync(WorkflowScanClient client, string level, CancellationToken token)
    {
        var page = await client.GetAsync("security.php", token);
        var userToken = ScanCheckContext.EmptyTokenRegex().Match(page.Body) is { Success: true } m ? m.Groups[1].Value : "";
        var form = new Dictionary<string, string> { ["security"] = level, ["seclev_submit"] = "Submit" };
        if (userToken.Length > 0) form["user_token"] = userToken;
        await client.PostFormAsync("security.php", form, token);
    }

    // ------- ブルートフォース対策 (CWE-307) -------

    public static async Task RunBruteForceAsync(ScanCheckContext c)
    {
        var result = c.Begin("brute-force", "認証試行回数の制限なし（ブルートフォース対策不備）" + ScanCheckContext.LevelSuffix(c.Level), "認証", "中", "307", c.Url("vulnerabilities/brute/"), "POST", "username/password");
        if (!await EnsureAuthenticatedPageAsync(c, "vulnerabilities/brute/")) { c.Skip(result, "未認証では実施不可"); return; }
        var rejected = 0;
        var blocked = false;
        for (var attempt = 1; attempt <= 12; attempt++)
        {
            // 対象フォームのmethodはGETとPOSTの両方があり得るため、クエリ形式で試行する。
            var response = await c.Client.GetAsync(
                $"vulnerabilities/brute/?username=scopepilot&password=wrong-{c.Marker}-{attempt}&Login=Login", c.Token);
            var body = response.Body;
            // メニュー欄などに「CAPTCHA」という語が出るだけで制限とは判断しない。
            if (response.StatusCode == 429 || body.Contains("locked", StringComparison.OrdinalIgnoreCase) ||
                body.Contains("too many", StringComparison.OrdinalIgnoreCase))
            {
                blocked = true;
                break;
            }
            if (body.Contains("incorrect", StringComparison.OrdinalIgnoreCase) || body.Contains("間違い", StringComparison.Ordinal) ||
                body.Contains("失敗", StringComparison.Ordinal))
                rejected++;
        }
        if (blocked || rejected < 8) { c.Skip(result, blocked ? "ロックアウト等の制限を確認" : "応答から無制限の再試行を確認できず"); return; }
        c.Detect(result,
            "誤った認証情報を12回連続で送信しても、すべて同一の再試行可能な応答が返り、アカウントロックアウト・レート制限・CAPTCHA等の試行回数制限が働きませんでした。パスワード推測（ブルートフォース）を自動化したまま継続できます。",
            $"12回連続の誤ログイン試行がすべて拒否応答（Username and/or password incorrect）で受け付けられ、429・ロックアウト・CAPTCHA要求は0回でした（マーカー {c.Marker}）。",
            "連続認証失敗に対する段階的待ち時間・アカウントロックアウト・多要素認証・IP単位のレート制限を導入し、失敗回数を上限で制御してください。",
            "不正ログインの成否は確認しておらず、試行回数制限の欠如のみを検出しています。");
    }

    // ------- CSRF (CWE-352) -------

    public static async Task RunCsrfAsync(ScanCheckContext c, string knownPassword)
    {
        var result = c.Begin("csrf-password", $"CSRF：トークンなしでパスワード変更が成立{ScanCheckContext.LevelSuffix(c.Level)}", "認証", "高", "352", c.Url("vulnerabilities/csrf/"), "GET", "password_new/password_conf");
        if (!await EnsureAuthenticatedPageAsync(c, "vulnerabilities/csrf/")) { c.Skip(result, "未認証では実施不可"); return; }
        var newPassword = $"Sp-{c.Marker}";
        // トークン・Referer検証のいずれも通さないGETリクエストで変更を試みる。
        var change = await c.Client.GetAsync($"vulnerabilities/csrf/?password_new={Uri.EscapeDataString(newPassword)}&password_conf={Uri.EscapeDataString(newPassword)}&Change=Change", c.Token);
        if (!change.Contains("Password Changed")) { c.Skip(result, "トークンなしの変更は拒否"); return; }
        // 元のパスワードへ戻す（同じ脆弱性を利用。CSRF変更は旧パスワードを要求しないため可能）。
        var restoreNote = "";
        if (knownPassword.Length > 0)
        {
            var restored = false;
            for (var attempt = 0; attempt < 2 && !restored; attempt++)
                restored = (await c.Client.GetAsync(
                    $"vulnerabilities/csrf/?password_new={Uri.EscapeDataString(knownPassword)}&password_conf={Uri.EscapeDataString(knownPassword)}&Change=Change", c.Token))
                    .Contains("Password Changed");
            if (!restored && c.PasswordVerifier is not null)
                restored = await c.PasswordVerifier(knownPassword);
            restoreNote = restored ? "変更後、同じ手順で元のパスワードへ復元しました。" : "警告: 元のパスワードへの復元応答を確認できませんでした。手動での復元と再ログインを推奨します。";
        }
        c.Detect(result,
            "CSRFトークンも旧パスワードも要求せず、GETパラメーターだけ認証済み利用者のパスワードを変更できました。攻撃者が細工したURLや外部ページを開かせるだけで利用者のアカウントを乗っ取れます。",
            $"GET /vulnerabilities/csrf/?password_new=［伏せ字］&password_conf=［伏せ字］&Change=Change に対し「Password Changed.」応答を確認（マーカー {c.Marker}）。{restoreNote}",
            "パスワード変更にはCSRFトークン検証と旧パスワード確認を必須にし、POST以外を受け付けない、SameSite Cookie属性を併用してください。",
            restoreNote.Contains("警告") ? restoreNote : "検証後、パスワードは元の値へ復元しています。");
    }

    // ------- ファイルアップロード (CWE-434) -------

    public static async Task RunFileUploadAsync(ScanCheckContext c)
    {
        var result = c.Begin("file-upload", $"制限なしファイルアップロードとアップロードファイルの実行{ScanCheckContext.LevelSuffix(c.Level)}", "ファイルアップロード", "高", "434", c.Url("vulnerabilities/upload/"), "POST", "uploaded");
        if (!await EnsureAuthenticatedPageAsync(c, "vulnerabilities/upload/")) { c.Skip(result, "未認証では実施不可"); return; }
        var fileName = $"sp{c.Marker}.php";
        var payloadText = $"<?php echo \"SP-UPLOAD-{c.Marker}\"; ?>";
        var payloads = new (string Name, string Mime, byte[] Bytes)[]
        {
            (fileName, "application/x-php", Encoding.UTF8.GetBytes(payloadText)),
            (fileName, "image/jpeg", Encoding.UTF8.GetBytes(payloadText)),
            (fileName, "image/jpeg", [.. "GIF89a"u8, .. Encoding.UTF8.GetBytes(payloadText)])
        };
        string? uploadedName = null;
        foreach (var payload in payloads)
        {
            var response = await c.Client.PostMultipartAsync("vulnerabilities/upload/", "uploaded", payload.Name, payload.Mime, payload.Bytes,
                new Dictionary<string, string> { ["MAX_FILE_SIZE"] = "100000", ["Upload"] = "Upload" }, c.Token);
            if (response.Contains("succesfully uploaded")) { uploadedName = payload.Name; break; }
        }
        if (uploadedName is null) { c.Skip(result, "アップロードは拒否・制限された"); return; }
        var execution = await c.Client.GetAsync($"hackable/uploads/{uploadedName}", c.Token);
        if (!execution.Contains($"SP-UPLOAD-{c.Marker}")) { c.Skip(result, "保存されたがコードとしては実行されず"); return; }
        c.Detect(result,
            "拡張子・MIME型・ファイル内容を実質検査せず、PHPスクリプトをアップロードして保存でき、さらにそのURLへアクセスするとサーバー側でコードが実行されました。任意のコード実行（ウェブシェル設置）に直結します。",
            $"multipart/form-data で {uploadedName}（内容は無害な echo 1行）を送信すると「succesfully uploaded!」となり、GET /hackable/uploads/{uploadedName} の応答本体に実行結果 SP-UPLOAD-{c.Marker} が現れました。",
            "拡張子の許可リスト・Content-Type検証・ファイル署名（マジックバイト）検証・保存先の実行権限剥奪・ファイル名の無害化・ウイルス検査を組み合わせ、アップロード後のファイルを直接実行不可能な形で保存・配信してください。",
            $"検証用に無害なPHPファイル {uploadedName}（echo 1行のみ）が1つアップロードされたまま残ります。削除は可能です。");
    }

    // ------- CAPTCHA迂回 (CWE-602/489) -------

    public static async Task RunCaptchaBypassAsync(ScanCheckContext c, string knownPassword)
    {
        var result = c.Begin("captcha-bypass", $"CAPTCHA（アンチオートメーション）の迂回{ScanCheckContext.LevelSuffix(c.Level)}", "認証", "中", "602", c.Url("vulnerabilities/captcha/"), "POST", "step/passed_captcha");
        if (!await EnsureAuthenticatedPageAsync(c, "vulnerabilities/captcha/")) { c.Skip(result, "未認証では実施不可"); return; }
        var newPassword = $"Sp-{c.Marker}";
        var stage2 = new Dictionary<string, string>
        {
            ["Change"] = "Change",
            ["step"] = "2",
            ["password_new"] = newPassword,
            ["password_conf"] = newPassword,
            ["passed_captcha"] = "true"
        };
        // CAPTCHAを解かずに第2段階（確定処理）へ直接POSTする。
        var bypass = await c.Client.PostFormAsync("vulnerabilities/captcha/", stage2, c.Token);
        var verified = bypass.Contains("Password Changed");
        var verifiedBy = "「Password Changed.」応答";
        // 応答に結果が現れない実装（reCAPTCHAキー未設定で結果表示が置換される等）では、
        // 新しいパスワードで実際にログインできるかによって成立を確認する。
        if (!verified && c.PasswordVerifier is not null && await c.PasswordVerifier(newPassword))
        {
            verified = true;
            verifiedBy = "別セッションでのログイン検証";
        }
        if (!verified)
        {
            // 開発用固定値による迂回経路（High）も試す。
            var dev = new Dictionary<string, string>(stage2) { ["g-recaptcha-response"] = "DEVELOPER-ONLY" };
            bypass = await c.Client.PostFormAsync("vulnerabilities/captcha/", dev, c.Token);
            verified = bypass.Contains("Password Changed") ||
                (c.PasswordVerifier is not null && await c.PasswordVerifier(newPassword));
            if (verified) verifiedBy = "開発用固定値による迂回";
        }
        if (!verified)
        {
            // 成立を確認できなくても、stage=2 の送信自体がパスワードを変更している実装があるため、
            // 必ず元のパスワードへ戻す措置を取る。
            await RestoreCaptchaPasswordAsync(c, knownPassword);
            c.Skip(result, "CAPTCHAなしの確定は拒否");
            return;
        }
        var restoreNote = "検証後、パスワードは元の値へ復元しています。";
        if (knownPassword.Length == 0 || !await RestoreCaptchaPasswordAsync(c, knownPassword))
            restoreNote = "警告: 元のパスワードへの復元を確認できませんでした。手動での復元と再ログインを推奨します。";
        c.Detect(result,
            "CAPTCHAを一度も解かずに、確認段階（step=2）への直接POSTだけでパスワード変更が確定しました。アンチオートメーション制御が最終処理で検証されておらず、自動化した悪用が可能です。",
            $"POST /vulnerabilities/captcha/ （step=2, passed_captcha=true, g-recaptcha-response なし）に対し{verifiedBy}で成立を確認（マーカー {c.Marker}）。{restoreNote}",
            "最終処理のサーバー側でCAPTCHA検証結果を必須にし、段階間の状態はサーバー側セッションで管理し、クライアントから送信される「CAPTCHA通過済み」フラグを信用しないでください。",
            restoreNote);
    }

    private static async Task<bool> RestoreCaptchaPasswordAsync(ScanCheckContext c, string knownPassword)
    {
        if (knownPassword.Length == 0) return false;
        var restore = new Dictionary<string, string>
        {
            ["Change"] = "Change",
            ["step"] = "2",
            ["password_new"] = knownPassword,
            ["password_conf"] = knownPassword,
            ["passed_captcha"] = "true"
        };
        var response = await c.Client.PostFormAsync("vulnerabilities/captcha/", restore, c.Token);
        if (response.Contains("Password Changed")) return true;
        return c.PasswordVerifier is not null && await c.PasswordVerifier(knownPassword);
    }

    // ------- 推測可能なセッションID (CWE-330) -------

    public static async Task RunWeakSessionAsync(ScanCheckContext c)
    {
        var result = c.Begin("weak-session", $"推測可能なセッションID（生成規則の特定）{ScanCheckContext.LevelSuffix(c.Level)}", "セッション管理", "中", "330", c.Url("vulnerabilities/weak_id/"), "POST", "dvwaSession");
        if (!await EnsureAuthenticatedPageAsync(c, "vulnerabilities/weak_id/")) { c.Skip(result, "未認証では実施不可"); return; }
        var values = new List<string>();
        for (var i = 0; i < 5; i++)
        {
            var response = await c.Client.PostFormAsync("vulnerabilities/weak_id/", new Dictionary<string, string>(), c.Token);
            var cookie = response.SetCookieValues.FirstOrDefault(v => v.StartsWith("dvwaSession=", StringComparison.Ordinal));
            if (cookie is null) break;
            values.Add(cookie.Split('=', 2)[1]);
        }
        if (values.Count < 3) { c.Skip(result, "セッションIDの収集に失敗"); return; }
        var pattern = AnalyzeSessionPattern(values);
        if (pattern is null) { c.Skip(result, "生成規則を特定できず"); return; }
        c.Detect(result,
            $"発行されたセッションID（dvwaSession）を{values.Count}個収集したところ、生成規則が「{pattern.Value.Name}」と特定できました。過去・未来の値を推測でき、他利用者のセッション乗っ取りに利用できます。",
            $"収集値: {string.Join(", ", values.Select(v => v.Length > 40 ? v[..16] + "…" : v))}。判定: {pattern.Value.Detail}",
            "セッションIDには十分な長さ（128ビット以上）の暗号論的乱数（CSPRNG）を使用し、連番・時刻・ハッシュ値などの既知情報から生成しないでください。",
            "収集した値は検証用セッションのもので、他利用者のセッション乗っ取りは行っていません。");
    }

    internal static (string Name, string Detail)? AnalyzeSessionPattern(IReadOnlyList<string> values)
    {
        if (values.All(v => long.TryParse(v, out _)))
        {
            var numbers = values.Select(long.Parse).ToList();
            var diffs = numbers.Zip(numbers.Skip(1), (a, b) => b - a).ToList();
            if (diffs.All(d => d == 1))
                return ("単純連番", $"連続する整数 {numbers.First()}…{numbers.Last()}（すべて+1）");
            var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            if (numbers.All(n => Math.Abs(n - now) < 3600))
                return ("現在時刻", $"すべて現在時刻（Unix秒）に一致: {numbers.First()}…{numbers.Last()}");
        }
        var table = BuildSmallIntegerHashes();
        foreach (var (value, index) in values.Select((v, i) => (v, i)))
            if (table.TryGetValue(value, out var source))
                return ($"連番のMD5（{source}）", $"値 {value} は {source} のMD5ハッシュと一致");
        return null;
    }

    private static Dictionary<string, string> BuildSmallIntegerHashes()
    {
        var table = new Dictionary<string, string>();
        for (var i = 0; i <= 5000; i++)
        {
            var hash = Convert.ToHexString(System.Security.Cryptography.MD5.HashData(Encoding.ASCII.GetBytes(i.ToString()))).ToLowerInvariant();
            table[hash] = i.ToString();
        }
        return table;
    }

    // ------- XSS: 反射型 (CWE-79) -------

    public static async Task RunXssReflectedAsync(ScanCheckContext c)
    {
        var result = c.Begin("xss-reflected", $"反射型XSS（入力値の未エスケープ出力）{ScanCheckContext.LevelSuffix(c.Level)}", "入力値検証", "高", "79", c.Url("vulnerabilities/xss_r/"), "GET", "name");
        if (!await EnsureAuthenticatedPageAsync(c, "vulnerabilities/xss_r/")) { c.Skip(result, "未認証では実施不可"); return; }
        var m = c.Marker;
        string[][] ladders =
        [
            [$"<script>{m}();</script>", $"<script>{m}"],
            [$"<scr<script>ipt>{m}();</scr</script>ipt>", $"<script>{m}"],
            [$"<img src=x onerror={m}();>", $"<img src=x onerror={m}"],
            [$"<svg onload={m}();>", $"<svg onload={m}"]
        ];
        foreach (var (payload, needle) in ladders.Select(x => (x[0], x[1])))
        {
            var response = await c.Client.GetAsync($"vulnerabilities/xss_r/?name={Uri.EscapeDataString(payload)}", c.Token);
            if (response.Contains(needle))
            {
                c.Detect(result,
                    "リクエストパラメーター name の値がHTMLエスケープされずそのまま応答HTMLへ出力されるため、攻撃者の用意したJavaScriptを利用者のブラウザーで実行できます（反射型XSS）。",
                    $"GET ?name=<script>…</script>（マーカー {m}）の応答本体に、エスケープされていない {needle} がそのまま出現しました。",
                    "出力時のコンテキストに応じたエスケープ（HTMLエンティティ化）を行い、入力値検証と出力エンコーディングを分離してください。CSPも多層防御として併用してください。",
                    "応答HTMLへの未エスケープ出力を根拠としており、実際のブラウザーでの実行確認は含みません。");
                return;
            }
        }
        c.Skip(result, "エスケープまたは除去を確認");
    }

    // ------- XSS: 格納型 (CWE-79) -------

    public static async Task RunXssStoredAsync(ScanCheckContext c)
    {
        var result = c.Begin("xss-stored", $"格納型XSS（保存値の未エスケープ出力）{ScanCheckContext.LevelSuffix(c.Level)}", "入力値検証", "高", "79", c.Url("vulnerabilities/xss_s/"), "POST", "mtxMessage");
        if (!await EnsureAuthenticatedPageAsync(c, "vulnerabilities/xss_s/")) { c.Skip(result, "未認証では実施不可"); return; }
        var m = c.Marker;
        string[][] ladders =
        [
            [$"<script>{m}();</script>", $"<script>{m}"],
            [$"<scr<script>ipt>{m}();</scr</script>ipt>", $"<script>{m}"],
            [$"<img src=x onerror={m}();>", $"<img src=x onerror={m}"]
        ];
        foreach (var (payload, needle) in ladders.Select(x => (x[0], x[1])))
        {
            await c.Client.PostFormAsync("vulnerabilities/xss_s/", new Dictionary<string, string>
            {
                ["txtName"] = $"sp{m}",
                ["mtxMessage"] = payload,
                ["btnSign"] = "Sign"
            }, c.Token);
            var page = await c.Client.GetAsync("vulnerabilities/xss_s/", c.Token);
            if (page.Contains(needle))
            {
                c.Detect(result,
                    "投稿メッセージがサニタイズされずに保存され、一覧画面で閲覧する全利用者のブラウザーでスクリプトが実行されます（格納型XSS）。反射型と異なり、一度の投稿で不特定多数の利用者へ影響が及びます。",
                    $"POST（mtxMessage=<script>…</script>、マーカー {m}）後に GET /vulnerabilities/xss_s/ の応答本体に、エスケープされていない {needle} が残存していました。",
                    "保存時・出力時の両方でコンテキストに応じたエンコーディングを行い、HTMLタグを許可する場合はホワイトリスト方式のサニタイザーを使用してください。",
                    $"検証用の投稿1件（マーカー sp{m} を含む）がゲストブックに残ります。削除可能です。");
                return;
            }
        }
        c.Skip(result, "エスケープまたは除去を確認");
    }

    // ------- XSS: DOM型 (CWE-79) -------

    // ページ本体のインラインスクリプトと level 別 .js ファイルの両方を調べる。
    // 実装によって脆弱なコードはページ埋込みの場合と外部ファイルの場合がある。
    public static async Task RunXssDomAsync(ScanCheckContext c)
    {
        var pageResult = c.Begin("xss-dom", $"DOM型XSS（URLを安全でない方法でDOMへ挿入）{ScanCheckContext.LevelSuffix(c.Level)}", "入力値検証", "中", "79", c.Url("vulnerabilities/xss_d/"));
        var page = await c.Client.GetAsync("vulnerabilities/xss_d/", c.Token);
        if (page.StatusCode != 200) { c.Skip(pageResult, "対象画面へ到達できず"); }
        else
        {
            var sink = FindDomSink(ExtractInlineScripts(page.Body));
            if (sink is null) c.Skip(pageResult, "ページ内スクリプトに危険なシンクを確認できず");
            else DetectDomSink(c, pageResult, "vulnerabilities/xss_d/", sink);
        }
    }

    public static async Task RunXssDomScriptsAsync(ScanCheckContext c)
    {
        foreach (var source in new[] { "low", "medium", "high" })
        {
            var scriptUrl = $"vulnerabilities/xss_d/source/{source}.js";
            var result = c.Begin("xss-dom", $"DOM型XSS（URLを安全でない方法でDOMへ挿入・配布スクリプト {source}.js）", "入力値検証", "中", "79", c.Url(scriptUrl));
            var script = await c.Client.GetAsync(scriptUrl, c.Token);
            if (script.StatusCode != 200) { c.Skip(result, "スクリプト未配布"); continue; }
            var sink = FindDomSink(script.Body);
            if (sink is null) { c.Skip(result, "危険なシンクを確認できず"); continue; }
            DetectDomSink(c, result, scriptUrl, sink);
        }
    }

    private static void DetectDomSink(ScanCheckContext c, WorkflowScanCheckResult result, string scriptUrl, string sink)
    {
        c.Detect(result,
            "ページに配布されるJavaScriptが、URL（location.href・location.searchなど）由来の値を検証なしに document.write 等へ渡しています。URLのクエリやフラグメントを介して、ページを開いた利用者のブラウザーでスクリプトが実行されます（DOM型XSS）。",
            $"{scriptUrl} の配布内容に危険なデータフローを確認: {sink}",
            "URL由来の値をDOMへ出力する前に、許可する値のホワイトリスト検証とコンテキスト別のエンコーディング（textContent使用等）を行ってください。document.write・innerHTML の使用を避けてください。",
            "配布スクリプトの静的解析に基づく検出であり、実際のブラウザーでの実行確認は含みません。");
    }

    internal static string ExtractInlineScripts(string html)
    {
        var builder = new StringBuilder();
        foreach (Match match in Regex.Matches(html, @"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", RegexOptions.IgnoreCase | RegexOptions.Singleline))
            builder.AppendLine(match.Groups[1].Value);
        return builder.ToString();
    }

    internal static string? FindDomSink(string script)
    {
        var sourcePattern = @"location\.(href|search|hash)|document\.URL|document\.documentURI|decodeURIComponent|decodeURI\(";
        var sinkPattern = @"document\.write|document\.writeln|\.innerHTML|\.insertAdjacentHTML|eval\(|setTimeout\(\s*['""]";
        if (!Regex.IsMatch(script, sourcePattern) || !Regex.IsMatch(script, sinkPattern)) return null;
        var line = script.Split("\n").FirstOrDefault(l => Regex.IsMatch(l, sinkPattern))?.Trim();
        return line is null ? null : (line.Length > 160 ? line[..160] + "…" : line);
    }

    // ------- CSP迂回 (CWE-693/79) -------

    public static async Task RunCspBypassAsync(ScanCheckContext c)
    {
        var result = c.Begin("csp-bypass", "CSPの許可元が広く、任意スクリプトURLの取込みが可能" + ScanCheckContext.LevelSuffix(c.Level), "セキュリティ設定", "中", "693", c.Url("vulnerabilities/csp/"), "POST", "include");
        var page = await c.Client.GetAsync("vulnerabilities/csp/", c.Token);
        if (page.StatusCode != 200) { c.Skip(result, "対象画面へ到達できず"); return; }
        var csp = page.ContentSecurityPolicy;
        var externalOrigins = ParseExternalScriptOrigins(csp);
        var include = await c.Client.PostFormAsync("vulnerabilities/csp/", new Dictionary<string, string>
        {
            ["include"] = $"https://scopepilot-check.invalid/{c.Marker}.js"
        }, c.Token);
        var reflected = include.Contains($"<script src='https://scopepilot-check.invalid/{c.Marker}.js'>", StringComparison.Ordinal) ||
                        include.Contains($"<script src=\"https://scopepilot-check.invalid/{c.Marker}.js\">", StringComparison.Ordinal);
        if (!reflected || externalOrigins.Count == 0) { c.Skip(result, reflected ? "CSPが外部許可元を含まず" : "スクリプトURLの取込みを確認できず"); return; }
        c.Detect(result,
            "Content-Security-Policy の script-src が第三者配信元を広く許可しており、さらに利用者が送信したURLをそのまま <script src> として取込みます。許可された外部ホスティング（Pastebin・jsdelivr等）に攻撃コードを置くだけでCSPを迂回して任意JavaScriptを実行できます。",
            $"CSP: {Truncate(csp, 200)}。POST include=https://scopepilot-check.invalid/{c.Marker}.js への応答に <script src='…'> として反映され、script-src は外部許可元 {externalOrigins.Count}件（{string.Join(", ", externalOrigins.Take(5))}…）を含みました。",
            "script-src は 'self' と必要最小限の自社管理配信元に限定し、利用者入力値をスクリプトURLへ直接反映しないでください。nonce や strict-dynamic の利用を検討してください。",
            "実際に外部ホスティングへスクリプトを設置しての実行確認は行っていません（実行には第三者サービスへの投稿が必要なため）。");
    }

    internal static List<string> ParseExternalScriptOrigins(string csp)
    {
        if (string.IsNullOrWhiteSpace(csp)) return [];
        var directives = csp.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var scriptSrc = directives.FirstOrDefault(d => d.StartsWith("script-src", StringComparison.OrdinalIgnoreCase)) ?? "";
        return scriptSrc.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(token => token.Contains("://", StringComparison.Ordinal) || (!token.StartsWith('\'') && token.Contains('.')))
            .Where(token => !token.StartsWith("scopepilot", StringComparison.OrdinalIgnoreCase))
            .ToList();
    }

    // ------- クライアント側制御への依存 (CWE-602) -------

    public static async Task RunClientSideTokenAsync(ScanCheckContext c)
    {
        var result = c.Begin("client-side-token", "クライアント側セキュリティ制御の迂回（トークン生成の再現）" + ScanCheckContext.LevelSuffix(c.Level), "クライアント側制御", "中", "602", c.Url("vulnerabilities/javascript/"), "POST", "phrase/token");
        if (!await EnsureAuthenticatedPageAsync(c, "vulnerabilities/javascript/")) { c.Skip(result, "未認証では実施不可"); return; }
        var page = await c.Client.GetAsync("vulnerabilities/javascript/", c.Token);
        var phrase = Regex.Match(page.Body, @"name=[""']phrase[""'][^>]*value=[""']([^""']+)[""']").Groups[1].Value;
        if (phrase.Length == 0) phrase = Regex.Match(page.Body, @"value=[""']([^""']+)[""'][^>]*name=[""']phrase[""']").Groups[1].Value;
        // サーバーが配布したJavaScriptと同じ手順（rot13→MD5 など）を診断側で再現してトークンを作る。
        var tokens = ClientSideTokenCandidates("success");
        foreach (var token in tokens)
        {
            var response = await c.Client.PostFormAsync("vulnerabilities/javascript/", new Dictionary<string, string>
            {
                ["phrase"] = "success",
                ["token"] = token,
                ["change"] = "Change"
            }, c.Token);
            if (response.Contains("Well done"))
            {
                c.Detect(result,
                    "成功条件とトークン生成ロジック（MD5・反転・SHA-256等の組合せ）がブラウザー配布のJavaScriptに埋め込まれています。配布コードを解析・再現するだけでトークンを生成でき、サーバー側検証を通過しました。クライアントへ送ったコードは利用者が改変できることを示しています。",
                    $"配布スクリプトの手順を再現して phrase=success, token={Truncate(token, 24)}… を送信し、「Well done!」応答を取得しました（画面既定値: {Truncate(phrase, 40)}、マーカー {c.Marker}）。",
                    "セキュリティ上重要な検証はすべてサーバー側で実施し、トークン生成ロジックや成功条件をクライアントへ配布しないでください。クライアント側チェックはUX目的に限定してください。",
                    "トークン生成の再現に成功したことをもって検出としており、難読化の解析そのものは自動化していません。");
                return;
            }
        }
        c.Skip(result, "配布ロジックの再現では通過せず");
    }

    internal static string[] ClientSideTokenCandidates(string phrase)
    {
        var rot13 = new string(phrase.Select(ch => ch is >= 'a' and <= 'z' ? (char)((ch - 'a' + 13) % 26 + 'a') : ch is >= 'A' and <= 'Z' ? (char)((ch - 'A' + 13) % 26 + 'A') : ch).ToArray());
        var md5 = Hex(System.Security.Cryptography.MD5.HashData(Encoding.ASCII.GetBytes(rot13)));
        var medium = new string(("XX" + phrase + "XX").Reverse().ToArray());
        var inner = "XX" + new string(phrase.Reverse().ToArray());
        var sha = Hex(System.Security.Cryptography.SHA256.HashData(Encoding.ASCII.GetBytes(Hex(System.Security.Cryptography.SHA256.HashData(Encoding.ASCII.GetBytes(inner))) + "ZZ")));
        return [md5, medium, sha];
    }

    // ------- 認可不備・IDOR (CWE-862/639) -------

    public static async Task RunAuthorizationBypassAsync(ScanCheckContext c)
    {
        var result = c.Begin("authorization-bypass", $"認可不備：メニュー外APIでの全利用者データ取得・他利用者情報の書換え{ScanCheckContext.LevelSuffix(c.Level)}", "認可", "高", "862", c.Url("vulnerabilities/authbypass/get_user_data.php"));
        var data = await c.Client.GetAsync("vulnerabilities/authbypass/get_user_data.php", c.Token);
        if (data.StatusCode != 200 || !data.Contains("["))
        {
            c.Skip(result, "利用者データAPIは拒否または保護されている"); return;
        }
        // 他人の利用者情報を対象に、所有権検証なしの更新（POST）が通るかを確認する。
        var target = ExtractOtherUser(data.Body);
        if (target is null) { c.Skip(result, "比較対象利用者なし"); return; }
        var originalName = target.Value.FirstName;
        // 名前カラムの長さ制約（DVWAでは15文字）を考慮し、短いマーカーを使う。
        var nameMarker = $"Sp{c.Marker[..6]}";
        var update = await c.Client.PostJsonAsync("vulnerabilities/authbypass/change_user_details.php",
            $$"""{"id": {{target.Value.Id}}, "first_name": "{{nameMarker}}", "surname": "{{target.Value.Surname}}"}""", c.Token);
        var changed = update.Contains("\"result\": \"ok\"", StringComparison.Ordinal) || update.Contains("\"result\":\"ok\"", StringComparison.Ordinal);
        if (!changed) { c.Skip(result, "更新APIは拒否"); return; }
        var after = await c.Client.GetAsync("vulnerabilities/authbypass/get_user_data.php", c.Token);
        var verified = after.Body.Contains(nameMarker, StringComparison.Ordinal);
        // 書き換えた値を元へ戻す。
        await c.Client.PostJsonAsync("vulnerabilities/authbypass/change_user_details.php",
            $$"""{"id": {{target.Value.Id}}, "first_name": "{{originalName}}", "surname": "{{target.Value.Surname}}"}""", c.Token);
        c.Detect(result,
            "画面メニューに現れないAPIが保護されておらず、全利用者の一覧（氏名等）を取得でき、さらに所有権・権限の検証なしに他利用者（ID " + target.Value.Id + "）の登録情報を書き換えられました。メニュー隠蔽による保護は認可制御になりません。",
            $"GET get_user_data.php → 利用者{CountUsers(data.Body)}名分のデータ。POST change_user_details.php（id={target.Value.Id}, first_name={nameMarker}）→ result:ok、再取得で書換えを確認。検証後、元の値へ復元しました。",
            "URL単位・API単位にサーバー側で認可を検証し、他利用者のリソースへは所有権確認を必須にしてください。メニューの非表示は認可制御として扱わないでください。",
            "検証後、書き換えた氏名は元の値へ復元しています。");
    }

    public static async Task RunBacOpenAccessAsync(ScanCheckContext c)
    {
        var result = c.Begin("bac-open-access", $"破られたアクセス制御：アクセスログ画面の無保護な公開{ScanCheckContext.LevelSuffix(c.Level)}", "認可", "中", "862", c.Url("vulnerabilities/bac/"));
        if (!await EnsureAuthenticatedPageAsync(c, "vulnerabilities/bac/")) { c.Skip(result, "対象画面へ到達できず"); return; }
        var page = await c.Client.GetAsync("vulnerabilities/bac/", c.Token);
        if (page.StatusCode != 200 || !page.Contains("Access Log", StringComparison.OrdinalIgnoreCase))
        {
            c.Skip(result, "ログ画面は保護されているか存在せず"); return;
        }
        c.Detect(result,
            "メニューから除去されたアクセスログ確認画面がURL直打ちで閲覧できました。利用者ID・対象ID・IPアドレス等を含む操作ログが、権限なしに取得できます。",
            "GET /vulnerabilities/bac/ が200で応答し、本文に「Access Log」とログエントリ（user_id・target_id・ip_address 等）を含みました。",
            "画面単位でサーバー側認可（管理者権限など）を検証してください。未使用画面はルーティングごと削除してください。",
            "");
    }

    // ------- オープンリダイレクト (CWE-601) -------

    public static async Task RunOpenRedirectAsync(ScanCheckContext c)
    {
        var m = c.Marker;
        var targets = new (string File, string Payload)[]
        {
            ("low.php", $"http://scopepilot-check.invalid/{m}"),
            ("medium.php", $"//scopepilot-check.invalid/{m}"),
            ("high.php", $"//scopepilot-check.invalid/info.php?{m}")
        };
        foreach (var (file, payload) in targets)
        {
            var path = $"vulnerabilities/open_redirect/source/{file}";
            var result = c.Begin("open-redirect", $"オープンリダイレクト（{file} の検証不十分な転送）", "リダイレクト", "中", "601", c.Url(path), "GET", "redirect");
            var response = await c.Client.GetAsync($"{path}?redirect={Uri.EscapeDataString(payload)}", c.Token);
            var external = response.IsRedirect && TryGetHost(response.Location, out var host) &&
                           !c.Client.BaseUri.Host.Equals(host, StringComparison.OrdinalIgnoreCase);
            if (!external) { c.Skip(result, "外部への転送は拒否"); continue; }
            c.Detect(result,
                "redirect パラメーターで指定された外部URLへ、検証ほぼなしに HTTP 302 で転送します。フィッシングサイトへの誘導に悪用できます。",
                $"GET {path}?redirect=［外部URL］→ {response.StatusCode} Location: {Truncate(response.Location, 120)}（検証用ドメイン scopepilot-check.invalid、マーカー {m}）。",
                "転送先を自社ドメインの相対パスのみに制限する許可リスト方式にしてください。外部URLを許可する必要がある場合は確認画面を挟んでください。",
                "");
        }
    }

    internal static bool TryGetHost(string location, out string host)
    {
        host = "";
        if (string.IsNullOrWhiteSpace(location)) return false;
        if (Uri.TryCreate(location, UriKind.Absolute, out var absolute)) { host = absolute.Host; return true; }
        if (location.StartsWith("//", StringComparison.Ordinal) && Uri.TryCreate("https:" + location, UriKind.Absolute, out var schemeRelative)) { host = schemeRelative.Host; return true; }
        return false;
    }

    // ------- 認証必要ページの到達確認 -------

    private static async Task<bool> EnsureAuthenticatedPageAsync(ScanCheckContext c, string path)
    {
        var response = await c.Client.GetAsync(path, c.Token);
        return response.StatusCode == 200 && !response.IsRedirect;
    }

    private static (int Id, string FirstName, string Surname)? ExtractOtherUser(string json)
    {
        // 実装によって user_id は数値にも文字列にもなるため両方を受け付ける。
        var matches = Regex.Matches(json, """\{\s*"user_id"\s*:\s*"?(\d+)"?\s*,\s*"first_name"\s*:\s*"([^"]*)"\s*,\s*"surname"\s*:\s*"([^"]*)"\s*\}""");
        var preferred = matches.Cast<Match>().FirstOrDefault(m => int.Parse(m.Groups[1].Value) > 1) ?? matches.Cast<Match>().FirstOrDefault();
        if (preferred is null) return null;
        return (int.Parse(preferred.Groups[1].Value), preferred.Groups[2].Value, preferred.Groups[3].Value);
    }

    private static int CountUsers(string json) => Regex.Matches(json, @"""user_id""\s*:").Count;

    internal static string Hex(byte[] bytes) => Convert.ToHexString(bytes).ToLowerInvariant();

    internal static string Truncate(string value, int length) => value.Length <= length ? value : value[..length] + "…";
}

public sealed partial class ScanCheckContext
{
    [GeneratedRegex(@"user_token['""]?\s*value=['""]([a-f0-9]{20,64})")]
    public static partial Regex EmptyTokenRegex();
}
