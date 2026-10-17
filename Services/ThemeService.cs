using Microsoft.Win32;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;

namespace ScopePilot.Services;

public static class ThemeService
{
    public static bool IsDarkMode()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return key?.GetValue("AppsUseLightTheme") is int value && value == 0;
        }
        catch { return false; }
    }

    public static void Apply(Window window, bool? darkOverride = null)
    {
        var dark = darkOverride ?? IsDarkMode();
        var colors = dark
            ? new Dictionary<string, string>
            {
                ["WindowBackground"] = "#17191D", ["Surface"] = "#202328", ["ControlBackground"] = "#2A2E34",
                ["TextPrimary"] = "#E6EDF3", ["TextSecondary"] = "#AAB6C4", ["Border"] = "#34404D",
                ["HeaderBackground"] = "#202328", ["FooterBackground"] = "#202328", ["Primary"] = "#245FBD",
                ["Link"] = "#72A7FF", ["InfoBackground"] = "#15243B", ["InfoBorder"] = "#315A8C",
                ["WarningBackground"] = "#332814", ["WarningBorder"] = "#9B762B", ["Success"] = "#237A57",
                ["DisabledButtonBackground"] = "#27313B", ["DisabledButtonForeground"] = "#AAB6C4",
                ["ConsoleBackground"] = "#090D12", ["ConsoleForeground"] = "#CDD9E5", ["Selection"] = "#264F78"
            }
            : new Dictionary<string, string>
            {
                ["WindowBackground"] = "#F4F6F8", ["Surface"] = "#FFFFFF", ["ControlBackground"] = "#FFFFFF",
                ["TextPrimary"] = "#172033", ["TextSecondary"] = "#5E6C84", ["Border"] = "#DDE2E8",
                ["HeaderBackground"] = "#172033", ["FooterBackground"] = "#FFFFFF", ["Primary"] = "#165DFF",
                ["Link"] = "#165DFF", ["InfoBackground"] = "#EEF4FF", ["InfoBorder"] = "#BCD2FF",
                ["WarningBackground"] = "#FFF7E6", ["WarningBorder"] = "#F0B429", ["Success"] = "#18794E",
                ["DisabledButtonBackground"] = "#E5E9EF", ["DisabledButtonForeground"] = "#596579",
                ["ConsoleBackground"] = "#101827", ["ConsoleForeground"] = "#D9E2F2", ["Selection"] = "#D7E6FF"
            };

        foreach (var (key, value) in colors)
            window.Resources[key] = new SolidColorBrush((Color)ColorConverter.ConvertFromString(value));

        if (SystemParameters.HighContrast)
        {
            foreach (var key in new[] { "WindowBackground", "Surface", "ControlBackground", "InfoBackground", "WarningBackground", "ConsoleBackground", "DisabledButtonBackground" })
                window.Resources[key] = SystemColors.WindowBrush;
            foreach (var key in new[] { "TextPrimary", "TextSecondary", "Border", "Link", "InfoBorder", "WarningBorder", "ConsoleForeground", "DisabledButtonForeground" })
                window.Resources[key] = SystemColors.WindowTextBrush;
            window.Resources["Selection"] = SystemColors.HighlightBrush;
            window.Resources["Primary"] = SystemColors.HighlightBrush;
        }

        if (new WindowInteropHelper(window).Handle is var handle && handle != IntPtr.Zero)
        {
            var enabled = dark ? 1 : 0;
            if (DwmSetWindowAttribute(handle, 20, ref enabled, sizeof(int)) != 0)
                DwmSetWindowAttribute(handle, 19, ref enabled, sizeof(int));
        }
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
}
