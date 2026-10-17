param(
    [string]$Version,
    [ValidateSet('win-x64', 'win-arm64')]
    [string]$Runtime = 'win-x64',
    [string]$IsccPath,
    [switch]$SkipTests,
    [switch]$SkipPublish
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Version) { $Version = ([xml](Get-Content -LiteralPath (Join-Path $projectRoot 'ScopePilot.csproj'))).Project.PropertyGroup.Version }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version must contain major.minor.patch only.' }
$parsedVersion = [version]$Version
if ($parsedVersion.Major -gt 255 -or $parsedVersion.Minor -gt 255 -or $parsedVersion.Build -gt 65535) { throw 'Version components are out of range.' }

if (-not $IsccPath) {
    $compiler = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($compiler) { $IsccPath = $compiler.Source }
    else {
        $candidates = @(
            "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
            "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
        )
        $IsccPath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    }
}
if (-not $IsccPath -or -not (Test-Path -LiteralPath $IsccPath)) { throw 'Install Inno Setup 6.7.3+ or provide -IsccPath.' }

if (-not $SkipPublish) {
    & (Join-Path $PSScriptRoot 'Publish.ps1') -Version $Version -Runtime $Runtime -SkipTests:$SkipTests
} elseif (-not $SkipTests) {
    & dotnet test (Join-Path $projectRoot 'Tests\ScopePilot.Tests.csproj') -c Release
    if ($LASTEXITCODE -ne 0) { throw 'Automated tests failed.' }
}
$artifactsRoot = Join-Path $projectRoot 'artifacts'
$publishDirectory = Join-Path $artifactsRoot "ScopePilot-$Version-$Runtime"
foreach ($relative in @('ScopePilot.exe','ScopePilot.dll','VERSION.txt','LICENSE','THIRD-PARTY-NOTICES.md','tools\fast-crawl.js','tools\zap-browser-record.js','tools\playwright-runtime\node_modules\@playwright\mcp\cli.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $publishDirectory $relative))) { throw "Incomplete payload: $relative" }
}
& (Join-Path $PSScriptRoot 'Test-DistributionLicenses.ps1') -PublishDirectory $publishDirectory -Runtime $Runtime -ProjectRoot $projectRoot
if ((Get-Content -LiteralPath (Join-Path $publishDirectory 'VERSION.txt') -Raw).Trim() -ne $Version) { throw 'Payload version mismatch.' }
if ((Get-Item (Join-Path $publishDirectory 'ScopePilot.dll')).VersionInfo.FileVersion -ne "$Version.0") { throw 'Assembly version mismatch.' }

# Reject a renamed/mixed payload before producing an architecture-labelled installer.
$expectedMachine = if ($Runtime -eq 'win-arm64') { 0xAA64 } else { 0x8664 }
foreach ($nativeFile in @('ScopePilot.exe', 'coreclr.dll', 'hostfxr.dll')) {
    $bytes = [IO.File]::ReadAllBytes((Join-Path $publishDirectory $nativeFile))
    $peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
    if ([BitConverter]::ToUInt16($bytes, $peOffset + 4) -ne $expectedMachine) { throw "Architecture mismatch in $nativeFile for $Runtime" }
}

$versionMS = ([long]$parsedVersion.Major * 65536) + $parsedVersion.Minor
$versionLS = [long]$parsedVersion.Build * 65536
$architecture = if ($Runtime -eq 'win-arm64') { 'arm64' } else { 'x64compatible' }
& $IsccPath '/Qp' "/DAppVersion=$Version" "/DRuntime=$Runtime" "/DArchitecture=$architecture" "/DVersionMS=$versionMS" "/DVersionLS=$versionLS" "/DPublishDir=$publishDirectory" "/DArtifactDir=$artifactsRoot" (Join-Path $projectRoot 'installer\ScopePilot.iss')
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
$installerPath = Join-Path $artifactsRoot "ScopePilot-$Version-$Runtime-Setup.exe"
$hash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$installerPath.sha256" -Encoding ascii -Value "$hash  $([IO.Path]::GetFileName($installerPath))"
Write-Host "INSTALLER $installerPath"
Write-Host "SHA256 $hash"
