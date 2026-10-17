using ScopePilot.Services;
using System.Windows;

namespace ScopePilot;

public partial class NewProjectFolderWindow : Window
{
    public string FolderName => FolderNameBox.Text;
    public NewProjectFolderWindow()
    {
        InitializeComponent();
        SourceInitialized += (_, _) => ThemeService.Apply(this);
        Loaded += (_, _) => { FolderNameBox.Focus(); FolderNameBox.SelectAll(); };
    }
    private void Create_Click(object sender, RoutedEventArgs e) => DialogResult = true;
}
