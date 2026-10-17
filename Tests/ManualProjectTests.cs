using System.IO;
using ScopePilot.Domain;
using ScopePilot.Services;
using ScopePilot.ViewModels;
using Xunit;

namespace ScopePilot.Tests;

public sealed class ManualProjectTests
{
    [Fact]
    public async Task NewActionCreatesNewFolderAndInitialFile()
    {
        using var temp = new TestFolder();
        var viewModel = new MainViewModel { ChooseNewProjectFile = () => ProjectWorkspaceService.CreateFolder(temp.Path, "新規案件") };
        Assert.True(await viewModel.CreateNewProjectAsync());
        Assert.Equal("新規案件", viewModel.Project.Name);
        Assert.Equal(viewModel.Project.ProjectFilePath, ProjectWorkspaceService.FindProjectFile(Path.Combine(temp.Path, "新規案件")));
        Assert.False(viewModel.HasUnsavedChanges);
    }

    [Fact]
    public void FolderOpeningRequiresExactlyOneProjectFileAndCreationRejectsExistingPaths()
    {
        using var temp = new TestFolder();
        Assert.Throws<InvalidDataException>(() => ProjectWorkspaceService.FindProjectFile(temp.Path));
        var path = ProjectWorkspaceService.CreateFolder(temp.Path, "案件");
        File.WriteAllText(path, "{}");
        Assert.Equal(path, ProjectWorkspaceService.FindProjectFile(Path.GetDirectoryName(path)!));
        Assert.Throws<IOException>(() => ProjectWorkspaceService.CreateFolder(temp.Path, "案件"));
        Assert.Throws<InvalidDataException>(() => ProjectWorkspaceService.CreateFolder(temp.Path, "../outside"));
        File.WriteAllText(Path.Combine(Path.GetDirectoryName(path)!, "second.scopepilot.json"), "{}");
        Assert.Throws<InvalidDataException>(() => ProjectWorkspaceService.FindProjectFile(Path.GetDirectoryName(path)!));
    }

    [Fact]
    public async Task EditingImportAndCandidateDecisionsDoNotSaveUntilExplicitSave()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        await new ProjectStore().SaveAsync(project);
        var original = await File.ReadAllTextAsync(project.ProjectFilePath);
        var vm = new MainViewModel();
        Assert.True(await vm.OpenProjectAsync(project.ProjectFilePath));
        Assert.False(vm.HasUnsavedChanges);
        vm.Project.Name = "入力中の案件";
        var input = Path.Combine(temp.Path, "urls.txt");
        await File.WriteAllTextAsync(input, "https://example.test/api/items/42\n");
        Assert.Equal(1, await vm.ImportAsync(input));
        var candidate = Assert.Single(vm.Project.Candidates);
        candidate.Selected = true;
        await vm.UpdateCandidateDecisionAsync(candidate);
        await vm.ApplyGuidelineSelectionAsync();
        var document = Path.Combine(temp.Path, "api.yaml");
        await File.WriteAllTextAsync(document, "openapi: 3.0.0");
        await vm.ReadApiDocumentAsync(document);
        Assert.True(vm.HasUnsavedChanges);
        Assert.Equal(original, await File.ReadAllTextAsync(project.ProjectFilePath));
        Assert.True(await vm.SaveCurrentProjectAsync());
        Assert.False(vm.HasUnsavedChanges);
        var saved = await new ProjectStore().LoadAsync(project.ProjectFilePath);
        Assert.Equal("入力中の案件", saved.Name);
        Assert.Single(saved.Requests);
        Assert.Equal(2, saved.Inputs.Count);
    }

    [Fact]
    public async Task SwitchingProjectsCanCancelOrDiscardWithoutSavingPreviousFile()
    {
        using var temp = new TestFolder();
        var first = temp.Project("first");
        var second = temp.Project("second");
        var store = new ProjectStore();
        await store.SaveAsync(first);
        await store.SaveAsync(second);
        var original = await File.ReadAllTextAsync(first.ProjectFilePath);
        var vm = new MainViewModel();
        Assert.True(await vm.OpenProjectAsync(first.ProjectFilePath));
        vm.Project.Name = "未保存の入力";
        vm.ConfirmDiscardChanges = () => false;
        Assert.False(await vm.OpenProjectAsync(second.ProjectFilePath));
        Assert.Equal(first.ProjectFilePath, vm.Project.ProjectFilePath);
        Assert.Equal("未保存の入力", vm.Project.Name);
        vm.ConfirmDiscardChanges = () => true;
        Assert.True(await vm.OpenProjectAsync(second.ProjectFilePath));
        Assert.Equal(second.ProjectFilePath, vm.Project.ProjectFilePath);
        Assert.False(vm.HasUnsavedChanges);
        Assert.Equal(original, await File.ReadAllTextAsync(first.ProjectFilePath));
    }

    [Fact]
    public async Task CancelledStartupSelectionCreatesNoFilesAndDoesNotRestoreAnything()
    {
        using var temp = new TestFolder();
        var vm = new MainViewModel { ChooseNewProjectFile = () => null, ChooseOpenProjectFile = () => null };
        await vm.InitializeAsync();
        Assert.False(await vm.CreateNewProjectAsync());
        Assert.False(await vm.OpenSelectedProjectAsync());
        Assert.Empty(vm.Project.ProjectFilePath);
        Assert.Empty(Directory.EnumerateFileSystemEntries(temp.Path));
    }

    [Fact]
    public async Task SaveRefusesUncommittedInputAndLeavesFileUnchanged()
    {
        using var temp = new TestFolder();
        var project = temp.Project();
        await new ProjectStore().SaveAsync(project);
        var original = await File.ReadAllTextAsync(project.ProjectFilePath);
        var vm = new MainViewModel();
        Assert.True(await vm.OpenProjectAsync(project.ProjectFilePath));
        vm.CommitPendingEdits = () => false;
        Assert.False(await vm.SaveCurrentProjectAsync());
        Assert.Equal(original, await File.ReadAllTextAsync(project.ProjectFilePath));
        vm.ConfirmDiscardChanges = () => false;
        Assert.False(vm.CanDiscardChanges());
    }
}
