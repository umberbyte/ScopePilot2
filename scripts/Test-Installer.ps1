param(
    [ValidateSet('win-x64', 'win-arm64')]
    [string]$Runtime = 'win-arm64'
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$version = ([xml](Get-Content -LiteralPath (Join-Path $root 'ScopePilot.csproj'))).Project.PropertyGroup.Version
$testRoot = Join-Path $root 'artifacts\installer-smoke'
$installDir = Join-Path $testRoot 'app'
$setup = Join-Path $root "artifacts\ScopePilot-$version-$Runtime-Setup.exe"
$payload = Join-Path $root "artifacts\ScopePilot-$version-$Runtime"
$registryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{A53F4838-7D84-4B92-A9FD-8BF8D66A41AF}_is1'
$shortcutRoot = Join-Path ([Environment]::GetFolderPath('Programs')) 'ScopePilot'
if ((Test-Path -LiteralPath $shortcutRoot) -and -not (Test-Path $registryPath)) { throw 'Existing user shortcuts found. Use a disposable Windows user profile.' }
if (Test-Path $registryPath) {
    $existingPath = (Get-ItemProperty $registryPath).'Inno Setup: App Path'
    if ($existingPath -ne $installDir) { throw 'A real ScopePilot installation exists. Run this test in a disposable Windows user profile.' }
}
if (-not ([IO.Path]::GetFullPath($installDir)).StartsWith($root + '\artifacts\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test installation path.' }
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null

function Get-DataManifest {
    $dataRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ScopePilot'
    if (Test-Path -LiteralPath $dataRoot) {
        Get-ChildItem -LiteralPath $dataRoot -File -Recurse | Sort-Object FullName | ForEach-Object {
            "$($_.FullName)|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)"
        }
    }
}
function Invoke-Setup([string]$logName) {
    $p = Start-Process -FilePath $setup -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/NOCLOSEAPPLICATIONS',('/DIR="' + $installDir + '"'),('/LOG="' + (Join-Path $testRoot $logName) + '"')) -WindowStyle Hidden -Wait -PassThru
    return $p.ExitCode
}
$before = @(Get-DataManifest)
if ((Invoke-Setup "install-$Runtime.log") -ne 0) { throw 'Initial installation failed.' }
$files = @(Get-ChildItem -LiteralPath $payload -File -Recurse)
foreach ($file in $files) {
    $relative = $file.FullName.Substring($payload.Length + 1)
    $installed = Join-Path $installDir $relative
    if ((Get-FileHash -LiteralPath $file.FullName).Hash -ne (Get-FileHash -LiteralPath $installed).Hash) { throw "Installed file mismatch: $relative" }
}
if (-not (Test-Path -LiteralPath (Join-Path $installDir 'FirstRun.html'))) { throw 'First-run guide missing.' }
$registration = Get-ItemProperty $registryPath
if ($registration.DisplayVersion -ne $version) { throw 'Registered version mismatch.' }
$shortcut = Join-Path $shortcutRoot 'ScopePilot.lnk'
if (-not (Test-Path -LiteralPath $shortcut)) { throw 'Start menu shortcut missing.' }
$shell = New-Object -ComObject WScript.Shell
if ($shell.CreateShortcut($shortcut).TargetPath -ne (Join-Path $installDir 'ScopePilot.exe')) { throw 'Shortcut points to wrong binary.' }
$mutex = [System.Threading.Mutex]::new($false, 'Local\ScopePilot.Application')
try {
    if ((Invoke-Setup "running-app-$Runtime.log") -eq 0) { throw 'Setup did not block a running application.' }
} finally { $mutex.Dispose() }
if ((Invoke-Setup "repair-$Runtime.log") -ne 0) { throw 'Same-version reinstallation failed.' }
$uninstall = Join-Path $installDir 'unins000.exe'
$p = Start-Process -FilePath $uninstall -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/LOG="' + (Join-Path $testRoot "uninstall-$Runtime.log") + '"')) -WindowStyle Hidden -Wait -PassThru
if ($p.ExitCode -ne 0) { throw 'Uninstallation failed.' }
if ((Test-Path -LiteralPath (Join-Path $installDir 'ScopePilot.exe')) -or (Test-Path $registryPath)) { throw 'Application/uninstall registration remained.' }
if (Test-Path -LiteralPath $shortcut) { throw 'Start menu shortcut remained after uninstall.' }
$after = @(Get-DataManifest)
if (($before -join "`n") -cne ($after -join "`n")) { throw 'Project data changed during installation test.' }
$report = [ordered]@{ runtime=$Runtime; version=$version; installedFilesVerified=$files.Count; install=$true; reinstallation=$true; runningApplicationBlocked=$true; shortcuts=$true; uninstall=$true; projectFilesUnchanged=$before.Count; executedAt=[DateTimeOffset]::Now.ToString('o') }
$report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $testRoot "result-$Runtime.json") -Encoding utf8
$report | ConvertTo-Json
