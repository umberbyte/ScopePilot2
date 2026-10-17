param(
    [ValidateSet('Debug', 'Release')][string]$Configuration = 'Release',
    [string]$BuildDirectory = ''
)

$ErrorActionPreference = 'Stop'
$taskRepository = Split-Path -Parent $PSScriptRoot
$taskBuildRoot = if ([string]::IsNullOrWhiteSpace($BuildDirectory)) {
    Join-Path $taskRepository "bin\$Configuration\net10.0-windows"
} else {
    [IO.Path]::GetFullPath((Join-Path $taskRepository $BuildDirectory))
}
if (-not $taskBuildRoot.StartsWith($taskRepository + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'ビルド先はリポジトリ内のフォルダーを指定してください。'
}
$taskExecutable = Join-Path $taskBuildRoot 'ScopePilot.exe'
if (-not (Test-Path -LiteralPath $taskExecutable)) {
    throw "ビルド済みアプリがありません。dotnet build ScopePilot.csproj -c $Configuration を実行してください。"
}
$taskRuntime = Join-Path $taskRepository '.cache\dotnet'
$taskVariables = @('DOTNET_ROOT', 'DOTNET_ROOT_ARM64', 'DOTNET_ROOT_X64', 'SCOPEPILOT_NODE_PATH', 'PATH')
$taskPreviousValues = @{}
foreach ($taskVariable in $taskVariables) {
    $taskPreviousValues[$taskVariable] = [Environment]::GetEnvironmentVariable($taskVariable, 'Process')
}
try {
    $taskNodeCandidates = @(
        [Environment]::GetEnvironmentVariable('SCOPEPILOT_NODE_PATH', 'Process'),
        (Join-Path $taskBuildRoot 'tools\node\node.exe'),
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    )
    $taskNodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($taskNodeCommand) { $taskNodeCandidates += $taskNodeCommand.Source }
    $taskNodeCandidates += Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    $taskNode = $taskNodeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
    if ($taskNode) {
        $taskNode = [IO.Path]::GetFullPath($taskNode)
        [Environment]::SetEnvironmentVariable('SCOPEPILOT_NODE_PATH', $taskNode, 'Process')
        [Environment]::SetEnvironmentVariable('PATH', (Split-Path -Parent $taskNode) + ';' + $taskPreviousValues['PATH'], 'Process')
    }
    if (Test-Path -LiteralPath (Join-Path $taskRuntime 'dotnet.exe')) {
        foreach ($taskVariable in @('DOTNET_ROOT', 'DOTNET_ROOT_ARM64', 'DOTNET_ROOT_X64')) {
            [Environment]::SetEnvironmentVariable($taskVariable, $taskRuntime, 'Process')
        }
    }
    $taskStart = @{ FilePath = $taskExecutable; WorkingDirectory = $taskRepository; WindowStyle = 'Normal'; PassThru = $true }
    $taskApplication = Start-Process @taskStart
    [pscustomobject]@{ ProcessId = $taskApplication.Id }
}
finally {
    foreach ($taskVariable in $taskVariables) {
        [Environment]::SetEnvironmentVariable($taskVariable, $taskPreviousValues[$taskVariable], 'Process')
    }
}
