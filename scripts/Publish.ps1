param(
    [string]$Version,
    [ValidateSet('win-x64', 'win-arm64')]
    [string]$Runtime = 'win-x64',
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $Version) { $Version = ([xml](Get-Content -LiteralPath (Join-Path $projectRoot 'ScopePilot.csproj'))).Project.PropertyGroup.Version }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version must contain major.minor.patch only.' }
$artifactsRoot = Join-Path $projectRoot "artifacts"
$packageName = "ScopePilot-$Version-$Runtime"
$publishDirectory = Join-Path $artifactsRoot $packageName
$zipPath = Join-Path $artifactsRoot "$packageName.zip"

if (-not ([IO.Path]::GetFullPath($publishDirectory)).StartsWith($artifactsRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Publish output must stay inside the artifacts directory."
}

if (-not $SkipTests) {
    & dotnet test (Join-Path $projectRoot "Tests\ScopePilot.Tests.csproj") -c Release
    if ($LASTEXITCODE -ne 0) { throw "Automated tests failed." }
}

if (Test-Path -LiteralPath $publishDirectory) { Remove-Item -LiteralPath $publishDirectory -Recurse -Force }
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
New-Item -ItemType Directory -Path $artifactsRoot -Force | Out-Null

& dotnet publish (Join-Path $projectRoot "ScopePilot.csproj") -c Release -r $Runtime --self-contained true `
    -p:Version=$Version -p:AssemblyVersion="$Version.0" -p:FileVersion="$Version.0" -o $publishDirectory
if ($LASTEXITCODE -ne 0) { throw "Windows publish failed." }

& (Join-Path $PSScriptRoot 'Test-DistributionLicenses.ps1') -PublishDirectory $publishDirectory -Runtime $Runtime -ProjectRoot $projectRoot

Copy-Item -LiteralPath (Join-Path $projectRoot "DISTRIBUTION.md") -Destination (Join-Path $publishDirectory "START_HERE.md")
Set-Content -LiteralPath (Join-Path $publishDirectory "VERSION.txt") -Value $Version -Encoding ascii
Compress-Archive -Path (Join-Path $publishDirectory "*") -DestinationPath $zipPath -CompressionLevel Optimal
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$zipPath.sha256" -Value "$hash  $packageName.zip" -Encoding ascii

Write-Host "PACKAGE $zipPath"
Write-Host "SHA256 $hash"
