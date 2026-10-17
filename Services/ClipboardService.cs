using System.Runtime.InteropServices;
using System.Windows;

namespace ScopePilot.Services;

internal sealed record ClipboardCopyResult(bool Success, string Message);

internal static class ClipboardService
{
    public static Task<ClipboardCopyResult> CopyTextAsync(string text) =>
        CopyTextAsync(text, value => Clipboard.SetDataObject(value, true), () => Task.Delay(100));

    internal static async Task<ClipboardCopyResult> CopyTextAsync(string text, Action<string> write, Func<Task> wait)
    {
        if (string.IsNullOrEmpty(text)) return new(false, "コピーするログがありません。");
        for (var attempt = 0; attempt < 5; attempt++)
        {
            try
            {
                // Keep the text available after ScopePilot closes. Retry when another app owns the clipboard.
                write(text);
                return new(true, "クリップボードにコピーしました。");
            }
            catch (ExternalException) when (attempt < 4) { await wait(); }
            catch (Exception ex) when (ex is ExternalException or InvalidOperationException or System.Security.SecurityException)
            {
                return new(false, $"コピーできませんでした（0x{ex.HResult:X8}）。もう一度コピーするか、ログ画面の［TXT保存］を使用してください。");
            }
        }
        throw new InvalidOperationException("Unexpected clipboard retry state.");
    }
}
