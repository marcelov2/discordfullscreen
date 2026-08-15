param(
    [string]$DiscordRoot = (Join-Path $env:LOCALAPPDATA 'Discord'),
    [string]$InstallRoot = (Join-Path $env:APPDATA 'TransporteFullscreenPatch')
)

$ErrorActionPreference = 'Stop'

if (Get-Process -Name Discord -ErrorAction SilentlyContinue) {
    throw 'Feche completamente o Discord antes de remover o TRANSPORTE Fullscreen Patch.'
}

$common = Join-Path $InstallRoot 'patch-common.ps1'
if (-not (Test-Path -LiteralPath $common)) { $common = Join-Path $PSScriptRoot 'patch-common.ps1' }
. $common

foreach ($app in @(Get-HarborDiscordApps -DiscordRoot $DiscordRoot)) {
    Uninstall-HarborPatchFromApp -AppDir $app.FullName | Out-Null
    Uninstall-HarborAc3RuntimeFromApp -AppDir $app.FullName -BackupRoot (Join-Path $InstallRoot 'runtime-backups') | Out-Null
}

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Remove-ItemProperty -Path $runKey -Name 'HarborFullscreenPatchRepair' -ErrorAction SilentlyContinue
Remove-ItemProperty -Path $runKey -Name 'TransporteFullscreenPatchRepair' -ErrorAction SilentlyContinue

$resolvedInstallRoot = Resolve-Path -LiteralPath $InstallRoot -ErrorAction SilentlyContinue
if ($resolvedInstallRoot -and (Resolve-Path -LiteralPath $PSScriptRoot).Path -ne $resolvedInstallRoot.Path) {
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force -ErrorAction SilentlyContinue
} else {
    Write-Host "Os arquivos em $InstallRoot podem ser apagados depois que esta janela fechar."
}

Write-Host 'TRANSPORTE Fullscreen Patch e Electron AC3 removidos; arquivos originais restaurados.'
