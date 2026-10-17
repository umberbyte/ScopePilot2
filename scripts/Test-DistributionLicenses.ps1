param(
    [Parameter(Mandatory)][string]$PublishDirectory,
    [Parameter(Mandatory)][ValidateSet('win-x64', 'win-arm64')][string]$Runtime,
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$requiredFiles = @('LICENSE', 'THIRD-PARTY-NOTICES.md',
    'tools\playwright-runtime\node_modules\@playwright\mcp\LICENSE',
    'tools\playwright-runtime\node_modules\playwright\LICENSE',
    'tools\playwright-runtime\node_modules\playwright\NOTICE',
    'tools\playwright-runtime\node_modules\playwright\ThirdPartyNotices.txt',
    'tools\playwright-runtime\node_modules\playwright-core\LICENSE',
    'tools\playwright-runtime\node_modules\playwright-core\NOTICE',
    'tools\playwright-runtime\node_modules\playwright-core\ThirdPartyNotices.txt')

$runtimeConfigPath = Join-Path $PublishDirectory 'ScopePilot.runtimeconfig.json'
$runtimeConfig = Get-Content -LiteralPath $runtimeConfigPath -Raw | ConvertFrom-Json
foreach ($frameworkName in @('Microsoft.NETCore.App', 'Microsoft.WindowsDesktop.App')) {
    $framework = $runtimeConfig.runtimeOptions.includedFrameworks | Where-Object name -eq $frameworkName | Select-Object -First 1
    if (-not $framework) { throw "Self-contained runtime metadata is missing: $frameworkName" }
    $licenseDirectory = "licenses\dotnet\$frameworkName.Runtime.$Runtime\$($framework.version)"
    if ($frameworkName -eq 'Microsoft.NETCore.App') {
        $requiredFiles += "$licenseDirectory\LICENSE.TXT"
        $requiredFiles += "$licenseDirectory\THIRD-PARTY-NOTICES.TXT"
    } else {
        $requiredFiles += "$licenseDirectory\LICENSE"
    }
}
foreach ($relative in $requiredFiles) {
    $path = Join-Path $PublishDirectory $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -eq 0) {
        throw "Missing or empty distribution license file: $relative"
    }
}
if ((Get-FileHash -LiteralPath (Join-Path $PublishDirectory 'LICENSE') -Algorithm SHA256).Hash -ne
    (Get-FileHash -LiteralPath (Join-Path $ProjectRoot 'LICENSE') -Algorithm SHA256).Hash) {
    throw 'Payload license does not match the source license. Rebuild the publish directory.'
}
if (Test-Path -LiteralPath (Join-Path $PublishDirectory 'tools\mcp-proxy-all.jar')) {
    throw 'The external GPL Burp proxy must not be included in the ScopePilot payload. Rebuild the publish directory.'
}
Write-Host "LICENSES OK $Runtime"
