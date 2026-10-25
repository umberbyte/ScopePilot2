using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ScopePilot.Domain;
using ScopePilot.Services.WorkflowScan;
using Xunit;

namespace ScopePilot.Tests;

// DVWA（Damn Vulnerable Web Application）の18脆弱性カテゴリーを模倣するインプロセスサーバー。
// ワークフロー診断の全チェックを、実DVWAに依存せず決定的に検証するためのテストベンチ。
public sealed class FakeDvwaServer : IDisposable
{
    private readonly HttpListener _listener;
    private readonly Task _loop;
    private readonly object _gate = new();
    private const string UserToken = "0123456789abcdef0123456789abcdef";
    private readonly string _username;
    private string _password;
    private int _weakSessionCounter;
    private readonly ConcurrentDictionary<string, byte[]> _uploads = new();
    private readonly List<(string Name, string Message)> _guestbook = [];

    private sealed class FakeUser
    {
        public int Id;
        public string FirstName = "";
        public string Surname = "";
        public int Level;
    }
    private readonly List<FakeUser> _users =
    [
        new() { Id = 1, FirstName = "admin", Surname = "admin", Level = 0 },
        new() { Id = 2, FirstName = "Gordon", Surname = "Brown", Level = 1 },
        new() { Id = 3, FirstName = "Hack", Surname = "Me", Level = 1 }
    ];

    public string SecurityLevel { get; set; } = "low";
    public string BaseUrl { get; }
    public bool LoginAttempted { get; private set; }

    public FakeDvwaServer(string username = "admin", string password = "password")
    {
        _username = username;
        _password = password;
        var port = GetFreePort();
        BaseUrl = $"http://127.0.0.1:{port}/";
        _listener = new HttpListener();
        _listener.Prefixes.Add(BaseUrl);
        _listener.Start();
        _loop = Task.Run(async () =>
        {
            while (_listener.IsListening)
            {
                try
                {
                    var context = await _listener.GetContextAsync();
                    _ = Task.Run(() => { try { Handle(context); } catch (Exception ex) { try { Write(context, 500, "server error: " + ex.Message); } catch { } } });
                }
                catch (HttpListenerException) { break; }
                catch (ObjectDisposedException) { break; }
            }
        });
    }

    public void Dispose()
    {
        try { _listener.Stop(); _listener.Close(); } catch { }
        try { _loop.Wait(TimeSpan.FromSeconds(2)); } catch { }
    }

    private static int GetFreePort()
    {
        var listener = new HttpListener();
        for (var attempt = 0; attempt < 20; attempt++)
        {
            var port = Random.Shared.Next(20000, 40000);
            try
            {
                listener.Prefixes.Clear();
                listener.Prefixes.Add($"http://127.0.0.1:{port}/");
                listener.Start();
                listener.Stop();
                return port;
            }
            catch (HttpListenerException) { }
        }
        throw new InvalidOperationException("空きポートが見つかりません。");
    }

    private static void Write(HttpListenerContext context, int status, string body, string? contentType = null, Dictionary<string, string>? headers = null)
    {
        context.Response.StatusCode = status;
        context.Response.ContentType = contentType ?? "text/html; charset=UTF-8";
        if (headers is not null)
            foreach (var (key, value) in headers)
                context.Response.AddHeader(key, value);
        var bytes = Encoding.UTF8.GetBytes(body);
        context.Response.ContentLength64 = bytes.Length;
        context.Response.OutputStream.Write(bytes);
        context.Response.Close();
    }

    private static void Redirect(HttpListenerContext context, string location)
    {
        context.Response.StatusCode = 302;
        context.Response.AddHeader("Location", location);
        context.Response.ContentLength64 = 0;
        context.Response.Close();
    }

    private static string ReadBody(HttpListenerRequest request)
    {
        using var reader = new StreamReader(request.InputStream, request.ContentEncoding);
        return reader.ReadToEnd();
    }

    private static Dictionary<string, string> ParseForm(string body) =>
        body.Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Select(part => part.Split('=', 2))
            .ToDictionary(pair => Uri.UnescapeDataString(pair[0]).Replace('+', ' '),
                pair => pair.Length > 1 ? Uri.UnescapeDataString(pair[1]).Replace('+', ' ') : "", StringComparer.Ordinal);

    private static Dictionary<string, string> Query(HttpListenerRequest request) =>
        request.QueryString.AllKeys.ToDictionary(key => key ?? "", key => request.QueryString[key] ?? "", StringComparer.Ordinal);

    private bool IsAuthenticated(HttpListenerRequest request) =>
        (request.Headers["Cookie"] ?? "").Contains("PHPSESSID=", StringComparison.Ordinal);

    private void Handle(HttpListenerContext context)
    {
        var request = context.Request;
        var path = request.Url!.AbsolutePath.TrimEnd('/');
        var query = Query(request);
        var form = request.HasEntityBody && (request.ContentType ?? "").StartsWith("application/x-www-form-urlencoded", StringComparison.Ordinal)
            ? ParseForm(ReadBody(request)) : [];

        switch (path)
        {
            case "/login.php":
                HandleLogin(context, request, form);
                return;
            case "/index.php":
                if (!IsAuthenticated(request)) { Redirect(context, "login.php"); return; }
                Write(context, 200, "<html><body>Welcome to DVWA <a href='logout.php'>Logout</a></body></html>");
                return;
            case "/security.php":
                HandleSecurity(context, request, form);
                return;
            case "/hackable/uploads":
                Write(context, 200, "uploads index");
                return;
        }
        if (path.StartsWith("/hackable/uploads/", StringComparison.Ordinal))
        {
            ServeUpload(context, path["/hackable/uploads/".Length..]);
            return;
        }
        if (path.StartsWith("/vulnerabilities/", StringComparison.Ordinal) && !IsAuthenticated(request))
        {
            Redirect(context, "login.php");
            return;
        }
        switch (path)
        {
            case "/vulnerabilities/brute":
                Write(context, 200, "<html><body>" + (query.ContainsKey("username") || form.ContainsKey("username")
                    ? "<pre>Username and/or password incorrect.</pre>" : "<form>Brute Force</form>") + "</body></html>");
                return;
            case "/vulnerabilities/csrf":
                HandleCsrf(context, query);
                return;
            case "/vulnerabilities/upload":
                HandleUpload(context, request);
                return;
            case "/vulnerabilities/captcha":
                HandleCaptcha(context, form);
                return;
            case "/vulnerabilities/weak_id":
                HandleWeakSession(context, request);
                return;
            case "/vulnerabilities/xss_r":
                HandleXssReflected(context, query);
                return;
            case "/vulnerabilities/xss_s":
                HandleXssStored(context, request, form);
                return;
            case "/vulnerabilities/xss_d":
                Write(context, 200, SecurityLevel switch
                {
                    "high" => "<html><select name='default'></select><script>var config = JSON.parse('{}'); setTimeout(function () { init(config); }, 0);</script></html>",
                    _ => "<html><select name='default'></select><script>if (window.location.search) { var lang = location.href.substring(location.href.indexOf('default=') + 8); document.write(decodeURIComponent(lang)); }</script></html>"
                });
                return;
            case "/vulnerabilities/csp":
                HandleCsp(context, request, form);
                return;
            case "/vulnerabilities/javascript":
                HandleJavascript(context, form);
                return;
            case "/vulnerabilities/authbypass/get_user_data.php":
                HandleGetUserData(context, request);
                return;
            case "/vulnerabilities/authbypass/change_user_details.php":
                HandleChangeUserDetails(context, request);
                return;
            case "/vulnerabilities/bac":
            case "/vulnerabilities/bac/index.php":
                Write(context, 200, "<html><div class='log-container'><h3>Access Log</h3><table><tr><td>user_id: 2</td><td>target_id: 1</td><td>ip_address: 10.0.0.9</td><td>action: view</td></tr></table></div></html>");
                return;
            case "/vulnerabilities/open_redirect/source/low.php":
            case "/vulnerabilities/open_redirect/source/medium.php":
            case "/vulnerabilities/open_redirect/source/high.php":
                HandleOpenRedirect(context, path, query);
                return;
            case "/vulnerabilities/fi":
            case "/vulnerabilities/fi/index.php":
                HandleFileInclusion(context, query);
                return;
            case "/vulnerabilities/sqli":
                HandleSqli(context, request, query, form, blind: false);
                return;
            case "/vulnerabilities/sqli_blind":
                HandleSqli(context, request, query, form, blind: true);
                return;
            case "/vulnerabilities/cryptography":
                HandleCryptography(context, request, SecurityLevel, form);
                return;
            case "/vulnerabilities/cryptography/source/check_token_high.php":
                HandleCheckTokenHigh(context, request);
                return;
            case "/vulnerabilities/api/v1/user":
                Write(context, 200, JsonSerializer.Serialize(_users.Select(u => new { id = u.Id, name = u.FirstName, level = u.Level, password = new string('a', 64) })),
                    "application/json");
                return;
            case "/vulnerabilities/api/v2/user":
                HandleApiUserCollection(context, request);
                return;
            case "/vulnerabilities/api/v2/health/connectivity":
                HandleConnectivity(context, request);
                return;
        }
        if (path.StartsWith("/vulnerabilities/api/v2/user/", StringComparison.Ordinal) && int.TryParse(path.AsSpan("/vulnerabilities/api/v2/user/".Length), out var userId))
        {
            HandleApiUserItem(context, request, userId);
            return;
        }
        if (path.StartsWith("/vulnerabilities/xss_d/source/", StringComparison.Ordinal))
        {
            HandleXssDomScript(context, path);
            return;
        }
        Write(context, 404, "Not Found");
    }

    private void HandleLogin(HttpListenerContext context, HttpListenerRequest request, Dictionary<string, string> form)
    {
        if (request.HttpMethod == "GET")
        {
            Write(context, 200, $"<html><form><input type='hidden' name='user_token' value='{UserToken}' /><input name='username' /><input name='password' /></form></html>");
            return;
        }
        LoginAttempted = true;
        var ok = form.GetValueOrDefault("username") == _username && form.GetValueOrDefault("password") == _password &&
                  form.GetValueOrDefault("Login") == "Login" && form.ContainsKey("user_token");
        if (ok)
        {
            context.Response.AddHeader("Set-Cookie", "PHPSESSID=sp-session-1; path=/");
            Redirect(context, "index.php");
        }
        else
            Write(context, 200, "<html><body>Login failed</body></html>");
    }

    private void HandleSecurity(HttpListenerContext context, HttpListenerRequest request, Dictionary<string, string> form)
    {
        if (request.HttpMethod == "POST" && form.ContainsKey("user_token"))
        {
            var level = form.GetValueOrDefault("security");
            if (level is "low" or "medium" or "high" or "impossible") SecurityLevel = level;
            Redirect(context, "security.php");
            return;
        }
        var options = new StringBuilder();
        foreach (var level in new[] { "low", "medium", "high", "impossible" })
            options.Append($"<option value='{level}'{(level == SecurityLevel ? " selected='selected'" : "")}>{level}</option>");
        Write(context, 200, $"<html><form method='post'><input type='hidden' name='user_token' value='{UserToken}' /><select name='security'>{options}</select><input type='submit' name='seclev_submit' value='Submit' /></form></html>");
    }

    private void HandleCsrf(HttpListenerContext context, Dictionary<string, string> query)
    {
        if (!query.ContainsKey("Change")) { Write(context, 200, "<html><form>password_new password_conf</form></html>"); return; }
        if (SecurityLevel is "low" or "medium")
        {
            if (query.GetValueOrDefault("password_new") == query.GetValueOrDefault("password_conf") &&
                query.GetValueOrDefault("password_new").Length > 0)
                _password = query["password_new"];
            Write(context, 200, "<html><pre>Password Changed.</pre></html>");
            return;
        }
        Write(context, 200, "<html><pre>Your CSRF token is incorrect.</pre></html>");
    }

    private void HandleUpload(HttpListenerContext context, HttpListenerRequest request)
    {
        var contentType = request.ContentType ?? "";
        if (!contentType.StartsWith("multipart/form-data", StringComparison.Ordinal) || request.HttpMethod != "POST")
        {
            Write(context, 200, "<html><form><input type='file' name='uploaded' /></form></html>");
            return;
        }
        var boundary = "--" + contentType.Split("boundary=", 2)[1];
        var body = ReadBodyBytes(request);
        var file = ParseMultipartFile(body, boundary);
        if (file is null) { Write(context, 200, "<html><pre>Your image was not uploaded.</pre></html>"); return; }
        var (name, mime, bytes) = file.Value;
        var accepted = SecurityLevel switch
        {
            "low" => true,
            "medium" => mime == "image/jpeg",
            "high" => mime == "image/jpeg" && bytes.AsSpan().StartsWith("GIF89a"u8),
            _ => false
        };
        if (!accepted) { Write(context, 200, "<html><pre>Your image was not uploaded.</pre></html>"); return; }
        _uploads[name] = bytes;
        Write(context, 200, $"<html><pre>../../hackable/uploads/{name} succesfully uploaded!</pre></html>");
    }

    private static byte[] ReadBodyBytes(HttpListenerRequest request)
    {
        using var memory = new MemoryStream();
        request.InputStream.CopyTo(memory);
        return memory.ToArray();
    }

    private static (string Name, string Mime, byte[] Bytes)? ParseMultipartFile(byte[] body, string boundary)
    {
        var text = Encoding.UTF8.GetString(body);
        var parts = text.Split(boundary, StringSplitOptions.RemoveEmptyEntries);
        foreach (var part in parts)
        {
            if (!part.Contains("filename=", StringComparison.Ordinal)) continue;
            var separator = part.IndexOf("\r\n\r\n", StringComparison.Ordinal);
            if (separator < 0) continue;
            var header = part[..separator];
            var content = part[(separator + 4)..].TrimEnd('\r', '\n');
            var nameMatch = System.Text.RegularExpressions.Regex.Match(header, "filename=\"([^\"]+)\"");
            var mimeMatch = System.Text.RegularExpressions.Regex.Match(header, "Content-Type:\\s*([^\\r\\n]+)");
            if (!nameMatch.Success) continue;
            return (nameMatch.Groups[1].Value, mimeMatch.Success ? mimeMatch.Groups[1].Value.Trim() : "application/octet-stream", Encoding.UTF8.GetBytes(content));
        }
        return null;
    }

    private void ServeUpload(HttpListenerContext context, string name)
    {
        if (!_uploads.TryGetValue(name, out var bytes)) { Write(context, 404, "Not Found"); return; }
        if (name.EndsWith(".php", StringComparison.Ordinal))
        {
            // PHPとして実行された結果を模倣する（echo の引数を出力）。
            var echo = System.Text.RegularExpressions.Regex.Match(Encoding.UTF8.GetString(bytes), "echo\\s+\"([^\"]+)\"");
            Write(context, 200, echo.Success ? echo.Groups[1].Value : "");
            return;
        }
        context.Response.ContentType = "application/octet-stream";
        context.Response.ContentLength64 = bytes.Length;
        context.Response.OutputStream.Write(bytes);
        context.Response.Close();
    }

    private void HandleCaptcha(HttpListenerContext context, Dictionary<string, string> form)
    {
        if (!form.ContainsKey("Change")) { Write(context, 200, "<html><form><input name='password_new' /><input name='g-recaptcha-response' /></form></html>"); return; }
        var changed = SecurityLevel switch
        {
            "low" => true,
            "medium" => form.GetValueOrDefault("step") == "2" && form.GetValueOrDefault("passed_captcha") == "true",
            "high" => form.GetValueOrDefault("g-recaptcha-response") == "DEVELOPER-ONLY",
            _ => false
        };
        if (changed && form.GetValueOrDefault("password_new") == form.GetValueOrDefault("password_conf") &&
            form.GetValueOrDefault("password_new").Length > 0)
            _password = form["password_new"];
        // 実機のDVWAはreCAPTCHAキー未設定の場合、結果表示を警告で置き換える（変更自体は実行される）。
        var suppressed = changed && SecurityLevel == "low";
        Write(context, 200, changed
            ? (suppressed ? "<html><em>Please register for a key</em> from reCAPTCHA</html>" : "<html><pre>Password Changed.</pre></html>")
            : "<html><pre>You have not passed the CAPTCHA.</pre></html>");
    }

    private void HandleWeakSession(HttpListenerContext context, HttpListenerRequest request)
    {
        if (request.HttpMethod != "POST") { Write(context, 200, "<html><form method='post'><input type='submit' name='generate' /></form></html>"); return; }
        lock (_gate) { _weakSessionCounter++; }
        string value;
        switch (SecurityLevel)
        {
            case "medium":
                value = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString();
                break;
            case "high":
                value = Convert.ToHexString(MD5.HashData(Encoding.ASCII.GetBytes(_weakSessionCounter.ToString()))).ToLowerInvariant();
                break;
            default:
                value = _weakSessionCounter.ToString();
                break;
        }
        Write(context, 200, "<html><body>Session set</body></html>", headers: new Dictionary<string, string> { ["Set-Cookie"] = $"dvwaSession={value}" });
    }

    private void HandleXssReflected(HttpListenerContext context, Dictionary<string, string> query)
    {
        if (!query.TryGetValue("name", out var name)) { Write(context, 200, "<html><form><input name='name' /></form></html>"); return; }
        string output;
        switch (SecurityLevel)
        {
            case "medium":
                output = name.Replace("<script>", "").Replace("</script>", "");
                break;
            case "high":
                output = WebUtility.HtmlEncode(name);
                break;
            default:
                output = name;
                break;
        }
        Write(context, 200, $"<html><pre>Hello {output}</pre></html>");
    }

    private void HandleXssStored(HttpListenerContext context, HttpListenerRequest request, Dictionary<string, string> form)
    {
        if (request.HttpMethod == "POST" && form.ContainsKey("btnSign"))
            lock (_gate) { _guestbook.Add((form.GetValueOrDefault("txtName"), form.GetValueOrDefault("mtxMessage"))); }
        var builder = new StringBuilder("<html><div id='guestbook'>");
        lock (_gate)
        {
            foreach (var (name, message) in _guestbook)
            {
                var renderedName = SecurityLevel is "high" or "impossible" ? WebUtility.HtmlEncode(name) : name;
                var renderedMessage = SecurityLevel switch
                {
                    "medium" => message.Replace("<script>", "").Replace("</script>", ""),
                    "high" or "impossible" => WebUtility.HtmlEncode(message),
                    _ => message
                };
                builder.Append($"<div class='name'>{renderedName}</div><div class='message'>{renderedMessage}</div>");
            }
        }
        builder.Append("</div><form method='post'><input name='txtName' /><textarea name='mtxMessage'></textarea><input type='submit' name='btnSign' value='Sign' /></form></html>");
        Write(context, 200, builder.ToString());
    }

    private static void HandleXssDomScript(HttpListenerContext context, string path)
    {
        var script = path.EndsWith("/low.js", StringComparison.Ordinal)
            ? "var lang = location.href.substring(location.href.indexOf('default=') + 8);\ndocument.write('<option>' + decodeURIComponent(lang) + '</option>');"
            : path.EndsWith("/medium.js", StringComparison.Ordinal)
                ? "document.write(document.location.hash.substring(1));"
                : "var config = JSON.parse('{}');\nsetTimeout(function () { init(config); }, 0);";
        Write(context, 200, script, "application/javascript");
    }

    private void HandleCsp(HttpListenerContext context, HttpListenerRequest request, Dictionary<string, string> form)
    {
        var policy = "script-src 'self' https://pastebin.com hastebin.com www.toptal.com example.com code.jquery.com https://ssl.google-analytics.com unpkg.com cdn.jsdelivr.net digi.ninja;";
        var headers = new Dictionary<string, string> { ["Content-Security-Policy"] = policy };
        if (request.HttpMethod == "POST" && form.TryGetValue("include", out var include))
        {
            Write(context, 200, $"<html><script src='{include}'></script></html>", headers: headers);
            return;
        }
        Write(context, 200, "<html><form method='post'><input name='include' id='include' /></form></html>", headers: headers);
    }

    private void HandleJavascript(HttpListenerContext context, Dictionary<string, string> form)
    {
        if (form.Count == 0)
        {
            Write(context, 200, "<html><script>function generate_token() { var phrase = document.getElementById('phrase').value; document.getElementById('token').value = md5(rot13(phrase)); }</script><form method='post'><input name='phrase' id='phrase' value='changeit' /><input type='hidden' name='token' id='token' value='' /><input type='submit' name='change' value='Change' /></form></html>");
            return;
        }
        var phrase = form.GetValueOrDefault("phrase");
        var token = form.GetValueOrDefault("token");
        var expected = SecurityLevel switch
        {
            "medium" => new string(("XX" + phrase + "XX").Reverse().ToArray()),
            "high" => Sha256Hex(Sha256Hex("XX" + new string(phrase.Reverse().ToArray())) + "ZZ"),
            _ => Md5Hex(new string(phrase.Select(ch => ch is >= 'a' and <= 'z' ? (char)((ch - 'a' + 13) % 26 + 'a') : ch).ToArray()))
        };
        Write(context, 200, phrase == "success" && token == expected ? "<html><p style='color:red'>Well done!</p></html>" : "<html><p>Invalid token.</p></html>");
    }

    private void HandleGetUserData(HttpListenerContext context, HttpListenerRequest request)
    {
        if (SecurityLevel is "high" or "impossible" && _username != "admin")
        {
            Write(context, 200, "{\"result\": \"fail\", \"error\": \"Access denied\"}", "application/json");
            return;
        }
        lock (_gate)
            Write(context, 200, JsonSerializer.Serialize(_users.Select(u => new { user_id = u.Id, first_name = u.FirstName, surname = u.Surname })), "application/json");
    }

    private void HandleChangeUserDetails(HttpListenerContext context, HttpListenerRequest request)
    {
        if (request.HttpMethod != "POST") { Write(context, 200, "{\"result\": \"fail\", \"error\": \"Only POST requests are accepted\"}", "application/json"); return; }
        try
        {
            using var document = JsonDocument.Parse(ReadBody(request));
            var id = document.RootElement.GetProperty("id").GetInt32();
            var firstName = document.RootElement.GetProperty("first_name").GetString() ?? "";
            var surname = document.RootElement.GetProperty("surname").GetString() ?? "";
            FakeUser? user;
            lock (_gate) user = _users.FirstOrDefault(u => u.Id == id);
            if (user is null) { Write(context, 200, "{\"result\": \"fail\", \"error\": \"not found\"}", "application/json"); return; }
            lock (_gate) { user.FirstName = firstName; user.Surname = surname; }
            Write(context, 200, "{\"result\": \"ok\"}", "application/json");
        }
        catch (JsonException)
        {
            Write(context, 200, "{\"result\": \"fail\", \"error\": \"Invalid format\"}", "application/json");
        }
    }

    private static void HandleOpenRedirect(HttpListenerContext context, string path, Dictionary<string, string> query)
    {
        var target = query.GetValueOrDefault("redirect");
        if (string.IsNullOrEmpty(target)) { Write(context, 500, "Missing redirect target."); return; }
        var level = path.EndsWith("/low.php", StringComparison.Ordinal) ? "low"
            : path.EndsWith("/medium.php", StringComparison.Ordinal) ? "medium" : "high";
        var allowed = level switch
        {
            "low" => true,
            "medium" => !System.Text.RegularExpressions.Regex.IsMatch(target, "https?://", System.Text.RegularExpressions.RegexOptions.IgnoreCase),
            _ => target.Contains("info.php", StringComparison.Ordinal)
        };
        if (allowed) Redirect(context, target);
        else Write(context, 500, level == "medium" ? "Absolute URLs not allowed." : "You can only redirect to the info page.");
    }

    private const string PasswdContent = "root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\nwww-data:x:33:33:www-data:/var/www:/usr/sbin/nologin\n";

    private void HandleFileInclusion(HttpListenerContext context, Dictionary<string, string> query)
    {
        var page = query.GetValueOrDefault("page");
        if (string.IsNullOrEmpty(page)) { Write(context, 200, "<html><a href='?page=include.php'>include</a></html>"); return; }
        var processed = page;
        if (SecurityLevel == "medium")
            processed = processed.Replace("../", "").Replace("..\\", "");
        else if (SecurityLevel == "high" && !processed.StartsWith("file", StringComparison.Ordinal) && processed != "include.php" ||
                 SecurityLevel == "impossible")
        {
            Write(context, 200, "<html>ERROR: File not found!</html>");
            return;
        }
        if (processed.StartsWith("php://filter/convert.base64-encode/resource=", StringComparison.Ordinal))
        {
            var resource = ResolveLocalFile(processed["php://filter/convert.base64-encode/resource=".Length..]);
            Write(context, 200, resource is null ? "<html>ERROR: File not found!</html>" : Convert.ToBase64String(Encoding.UTF8.GetBytes(resource)));
            return;
        }
        if (processed.StartsWith("file://", StringComparison.Ordinal)) processed = processed["file://".Length..];
        var content = ResolveLocalFile(processed);
        Write(context, 200, content is null ? "<html>ERROR: File not found!</html>" : $"<html><pre>{content}</pre></html>");
    }

    private static string? ResolveLocalFile(string path)
    {
        // ディレクトリ巡回（../）を解決したうえで、既知のローカルファイルに一致するか判定する。
        var stack = new List<string>();
        foreach (var segment in path.Split('/', StringSplitOptions.RemoveEmptyEntries))
        {
            if (segment == "..") { if (stack.Count > 0) stack.RemoveAt(stack.Count - 1); }
            else stack.Add(segment);
        }
        var normalized = "/" + string.Join("/", stack);
        return normalized is "/etc/passwd" or "etc/passwd" ? PasswdContent : null;
    }

    private void HandleSqli(HttpListenerContext context, HttpListenerRequest request, Dictionary<string, string> query, Dictionary<string, string> form, bool blind)
    {
        var id = query.ContainsKey("id") ? query["id"] : form.GetValueOrDefault("id");
        if (string.IsNullOrEmpty(id)) { Write(context, 200, "<html><form><input name='id' /><input type='submit' name='Submit' /></form></html>"); return; }
        if (SecurityLevel is "high" or "impossible")
        {
            Write(context, 200, blind ? "<html><pre>User ID is MISSING from the database.</pre></html>" : "<html></html>");
            return;
        }
        if (int.TryParse(id, out _))
        {
            Write(context, 200, blind ? "<html><pre>User ID exists in the database.</pre></html>" : "<html><pre>ID: 1</pre><pre>First name: admin</pre><pre>Surname: admin</pre></html>");
            return;
        }
        if (id.Contains("'") && id.Contains("AND", StringComparison.OrdinalIgnoreCase))
        {
            var truthy = id.Contains("'1'='1", StringComparison.Ordinal);
            Write(context, 200, truthy
                ? (blind ? "<html><pre>User ID exists in the database.</pre></html>" : "<html><pre>First name: admin</pre><pre>Surname: admin</pre></html>")
                : (blind ? "<html><pre>User ID is MISSING from the database.</pre></html>" : "<html></html>"));
            return;
        }
        if (id.Contains("'"))
        {
            Write(context, 200, blind ? "<html><pre>User ID is MISSING from the database.</pre></html>" : "<html><pre>You have an error in your SQL syntax; check the manual...</pre></html>");
            return;
        }
        Write(context, 200, blind ? "<html><pre>User ID is MISSING from the database.</pre></html>" : "<html></html>");
    }

    // ---- 暗号モジュール（レベル別: low=XOR / medium=AES-ECB / high=AES-CBC） ----

    private const string XorKey = "wachtwoord";
    private const string EcbKey = "ik ben een aardb"; // PHP openssl は aes-128 の鍵を先頭16バイトへ切詰め
    private const string CbcKey = "rainbowclimbingh";
    private const string CbcIv = "1234567812345678";
    private readonly string _expiredEx = "1723620672";
    private readonly string _validEx = (DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 30 * 24 * 3600).ToString();

    private void HandleCryptography(HttpListenerContext context, HttpListenerRequest request, string level, Dictionary<string, string> form)
    {
        if (level == "low")
        {
            var body = "<html><form method='post'><textarea name='message'></textarea><input type='radio' name='direction' value='encode' checked='checked' /><input type='submit' /></form>";
            if (request.HttpMethod == "POST")
            {
                var message = form.GetValueOrDefault("message");
                body += $"<textarea readonly='readonly' id='encoded' name='encoded'>{Convert.ToBase64String(Xor(Encoding.UTF8.GetBytes(message), Encoding.ASCII.GetBytes(XorKey)))}</textarea>";
            }
            else
            {
                body += $"<p>You have intercepted the following message, decode it and log in below.</p><textarea readonly='readonly' id='encoded' name='encoded'>{Convert.ToBase64String(Xor(Encoding.UTF8.GetBytes("the password is Olifant"), Encoding.ASCII.GetBytes(XorKey)))}</textarea>";
            }
            body += "<form method='post'><input type='password' name='password' /><input type='submit' value='Login' /></form></html>";
            Write(context, 200, body);
            return;
        }
        if (level == "medium")
        {
            if (request.HttpMethod == "POST")
            {
                var token = form.GetValueOrDefault("token");
                string verdict;
                if (token.Length % 32 != 0) verdict = "Token is in wrong format";
                else
                {
                    var decrypted = TryEcbDecrypt(token);
                    if (decrypted is null) verdict = "Decryption failed";
                    else
                    {
                        try
                        {
                            using var document = JsonDocument.Parse(decrypted);
                            var user = document.RootElement.GetProperty("user").GetString();
                            var ex = document.RootElement.GetProperty("ex").GetInt64();
                            var userLevel = document.RootElement.GetProperty("level").GetString();
                            verdict = user == "sweep" && ex > DateTimeOffset.UtcNow.ToUnixTimeSeconds() && userLevel == "admin"
                                ? "Welcome administrator Sweep"
                                : "Login successful but not as the right user.";
                        }
                        catch (JsonException) { verdict = "Could not decode JSON object."; }
                    }
                }
                Write(context, 200, $"<html><div class='message'>{verdict}</div><form method='post'><textarea name='token'></textarea><input type='submit' /></form></html>");
                return;
            }
            var sooty = EcbEncrypt($$"""{"user":"sooty","ex":{{_expiredEx}},"level":"admin","bio":"Izzy wizzy let's get busy"}""");
            var sweep = EcbEncrypt($$"""{"user":"sweep","ex":{{_expiredEx}},"level":"admin","bio":"Sweep the chimney"}""");
            var soo = EcbEncrypt($$"""{"user" : "soo","ex":{{_validEx}},"level": "user","bio": "I won The Weakest Link"}""");
            Write(context, 200, $"<html><p>Sooty (admin), session expired</p><textarea>{sooty}</textarea><p>Sweep (user), session expired</p><textarea>{sweep}</textarea><p>Soo (user), session valid</p><textarea>{soo}</textarea><form method='post'><textarea name='token'></textarea><input type='submit' /></form></html>");
            return;
        }
        if (level == "high")
        {
            var tokenJson = $$"""{"token": "{{CbcEncryptBase64("userid:2")}}", "iv": "{{Convert.ToBase64String(Encoding.ASCII.GetBytes(CbcIv))}}"}""";
            Write(context, 200, $"<html><p>You have managed to steal the following token</p><textarea>{tokenJson}</textarea><form><textarea id='token'>{tokenJson}</textarea></form></html>");
            return;
        }
        Write(context, 200, "<html><p>Cryptography impossible</p></html>");
    }

    private static string EcbEncrypt(string plaintext)
    {
        using var aes = Aes.Create();
        aes.Mode = CipherMode.ECB;
        aes.Padding = PaddingMode.PKCS7;
        aes.Key = Encoding.ASCII.GetBytes(EcbKey);
        using var encryptor = aes.CreateEncryptor();
        var bytes = encryptor.TransformFinalBlock(Encoding.UTF8.GetBytes(plaintext), 0, plaintext.Length);
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    private static string? TryEcbDecrypt(string hex)
    {
        try
        {
            var bytes = Convert.FromHexString(hex);
            using var aes = Aes.Create();
            aes.Mode = CipherMode.ECB;
            aes.Padding = PaddingMode.PKCS7;
            aes.Key = Encoding.ASCII.GetBytes(EcbKey);
            using var decryptor = aes.CreateDecryptor();
            return Encoding.UTF8.GetString(decryptor.TransformFinalBlock(bytes, 0, bytes.Length));
        }
        catch (CryptographicException) { return null; }
    }

    private static string CbcEncryptBase64(string plaintext)
    {
        using var aes = Aes.Create();
        aes.Mode = CipherMode.CBC;
        aes.Padding = PaddingMode.PKCS7;
        aes.Key = Encoding.ASCII.GetBytes(CbcKey);
        aes.IV = Encoding.ASCII.GetBytes(CbcIv);
        using var encryptor = aes.CreateEncryptor();
        var bytes = encryptor.TransformFinalBlock(Encoding.UTF8.GetBytes(plaintext), 0, plaintext.Length);
        return Convert.ToBase64String(bytes);
    }

    private static string? CbcDecrypt(byte[] cipher, byte[] iv)
    {
        try
        {
            using var aes = Aes.Create();
            aes.Mode = CipherMode.CBC;
            aes.Padding = PaddingMode.PKCS7;
            aes.Key = Encoding.ASCII.GetBytes(CbcKey);
            aes.IV = iv;
            using var decryptor = aes.CreateDecryptor();
            return Encoding.UTF8.GetString(decryptor.TransformFinalBlock(cipher, 0, cipher.Length));
        }
        catch (CryptographicException) { return null; }
    }

    private static void HandleCheckTokenHigh(HttpListenerContext context, HttpListenerRequest request)
    {
        if (request.HttpMethod != "POST")
        {
            Write(context, 200, "{\"status\": 405, \"message\": \"Method not supported\"}", "application/json");
            return;
        }
        if ((request.ContentType ?? "") != "application/json")
        {
            Write(context, 200, "{\"status\": 527, \"message\": \"Content type must be application/json\"}", "application/json");
            return;
        }
        string status, extra = "";
        try
        {
            using var document = JsonDocument.Parse(ReadBody(request));
            if (!document.RootElement.TryGetProperty("token", out _))
            {
                Write(context, 200, "{\"status\": 523, \"message\": \"Missing token\"}", "application/json");
                return;
            }
            if (!document.RootElement.TryGetProperty("iv", out _))
            {
                Write(context, 200, "{\"status\": 524, \"message\": \"Missing IV\"}", "application/json");
                return;
            }
            var token = Convert.FromBase64String(document.RootElement.GetProperty("token").GetString() ?? "");
            var iv = Convert.FromBase64String(document.RootElement.GetProperty("iv").GetString() ?? "");
            var decrypted = CbcDecrypt(token, iv);
            if (decrypted is null)
            {
                Write(context, 200, "{\"status\": 526, \"message\": \"Unable to decrypt token\"}", "application/json");
                return;
            }
            var match = System.Text.RegularExpressions.Regex.Match(decrypted, "^userid:(\\d+)$");
            if (!match.Success)
            {
                Write(context, 200, "{\"status\": 527, \"message\": \"No user specified\"}", "application/json");
                return;
            }
            var users = new Dictionary<int, (string Name, string Level)> { [1] = ("Geoffery", "admin"), [2] = ("Bungle", "user"), [3] = ("Zippy", "user"), [4] = ("George", "user") };
            if (users.TryGetValue(int.Parse(match.Groups[1].Value), out var user))
                Write(context, 200, $$"""{"status": 200, "user": "{{user.Name}}", "level": "{{user.Level}}"}""", "application/json");
            else
                Write(context, 200, "{\"status\": 525, \"message\": \"User not found\"}", "application/json");
        }
        catch (JsonException)
        {
            Write(context, 200, "{\"status\": 522, \"message\": \"Data in wrong format\"}", "application/json");
        }
        catch (FormatException)
        {
            Write(context, 200, "{\"status\": 522, \"message\": \"Data in wrong format\"}", "application/json");
        }
    }

    private void HandleApiUserCollection(HttpListenerContext context, HttpListenerRequest request)
    {
        if (request.HttpMethod == "GET")
        {
            lock (_gate)
                Write(context, 200, JsonSerializer.Serialize(_users.Select(u => new { id = u.Id, name = u.FirstName, level = u.Level })), "application/json");
            return;
        }
        Write(context, 405, "Method not allowed");
    }

    private void HandleApiUserItem(HttpListenerContext context, HttpListenerRequest request, int userId)
    {
        if (request.HttpMethod is "PUT" or "PATCH")
        {
            try
            {
                using var document = JsonDocument.Parse(ReadBody(request));
                FakeUser? user;
                lock (_gate) user = _users.FirstOrDefault(u => u.Id == userId);
                if (user is null) { Write(context, 404, "User not found."); return; }
                lock (_gate)
                {
                    if (document.RootElement.TryGetProperty("name", out var name)) user.FirstName = name.GetString() ?? user.FirstName;
                    // マスアサインメント脆弱性: リクエストに level が含まれていると権限まで書き換わる。
                    if (document.RootElement.TryGetProperty("level", out var level)) user.Level = level.GetInt32();
                }
                lock (_gate)
                    Write(context, 200, JsonSerializer.Serialize(new { id = user.Id, name = user.FirstName, level = user.Level }), "application/json");
                return;
            }
            catch (JsonException) { Write(context, 422, "Invalid user object provided"); return; }
        }
        Write(context, 405, "Method not allowed");
    }

    private static void HandleConnectivity(HttpListenerContext context, HttpListenerRequest request)
    {
        if (request.HttpMethod != "POST") { Write(context, 405, "Method not allowed"); return; }
        try
        {
            using var document = JsonDocument.Parse(ReadBody(request));
            if (!document.RootElement.TryGetProperty("target", out var targetElement))
            {
                Write(context, 500, "{\"status\": \"Target not specified\"}", "application/json");
                return;
            }
            var target = targetElement.GetString() ?? "";
            // OSコマンドインジェクションを模倣する: シェル演算子以降をコマンドとして解釈し、
            // 実行結果（echo）と終了コード（true/false）を応答へ反映する。
            var output = new List<string> { $"PING {target.Split(' ', 2)[0]}: 56 data bytes", "64 bytes from 127.0.0.1: icmp_seq=0 ttl=64 time=0.1 ms" };
            var exitCode = target.Contains("scopepilot-probe.invalid", StringComparison.Ordinal) ? 1 : 0;
            foreach (var separator in new[] { "&&", ";", "|", "\n" })
            {
                var index = target.IndexOf(separator, StringComparison.Ordinal);
                if (index < 0) continue;
                var command = target[(index + separator.Length)..].Trim();
                if (command == "true") { exitCode = 0; break; }
                if (command == "false") { exitCode = 1; break; }
                if (command.StartsWith("echo ", StringComparison.Ordinal)) { output.Add(command[5..].Trim()); break; }
                exitCode = 1;
                break;
            }
            if (exitCode == 0)
                Write(context, 200, JsonSerializer.Serialize(new { status = "OK", reply = output }), "application/json");
            else
                Write(context, 500, "{\"status\": \"Connection failed\"}", "application/json");
            return;
        }
        catch (JsonException) { Write(context, 500, "Words not specified"); }
    }

    private static string Md5Hex(string value) => Convert.ToHexString(MD5.HashData(Encoding.ASCII.GetBytes(value))).ToLowerInvariant();
    private static string Sha256Hex(string value) => Convert.ToHexString(SHA256.HashData(Encoding.ASCII.GetBytes(value))).ToLowerInvariant();
    private static byte[] Xor(byte[] value, byte[] key)
    {
        var output = new byte[value.Length];
        for (var i = 0; i < value.Length; i++) output[i] = (byte)(value[i] ^ key[i % key.Length]);
        return output;
    }
}
