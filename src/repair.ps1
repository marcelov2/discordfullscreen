param(
    [string]$DiscordRoot = (Join-Path $env:LOCALAPPDATA 'Discord'),
    [string]$InstallRoot = (Join-Path $env:APPDATA 'TransporteFullscreenPatch')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'patch-common.ps1')

$apps = @(Get-HarborDiscordApps -DiscordRoot $DiscordRoot)
if ($apps.Count -eq 0) { exit 0 }

$patcher = Join-Path $InstallRoot 'patcher.js'
if (-not (Test-Path -LiteralPath $patcher -PathType Leaf)) { exit 0 }

try {
    $markerPath = Join-Path $apps[0].FullName $script:Ac3RuntimeMarker
    $archivePath = Join-Path $InstallRoot 'discord-electron-37.6.0-ac3-win-x64.zip'
    if ((Test-Path -LiteralPath $markerPath -PathType Leaf) -and
        (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
        $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
        Install-HarborAc3RuntimeIntoApp -AppDir $apps[0].FullName -ArchivePath $archivePath -BackupRoot (Join-Path $InstallRoot 'runtime-backups') -ExpectedSha256 $marker.archiveSha256 -RceditPath (Join-Path $InstallRoot 'rcedit-x64.exe') | Out-Null
    }
    Install-HarborPatchIntoApp -AppDir $apps[0].FullName -PatcherPath $patcher | Out-Null
} catch {
    $log = Join-Path $InstallRoot 'repair-error.log'
    "$(Get-Date -Format o) $($_.Exception.Message)" | Add-Content -LiteralPath $log -Encoding UTF8
    exit 1
}
