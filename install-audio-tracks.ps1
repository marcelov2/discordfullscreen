# Habilita selecao nativa de faixas de audio no patch ja instalado do Discord.
# Uso: iwr -useb https://raw.githubusercontent.com/marcelov2/discordfullscreen/refs/heads/main/install-audio-tracks.ps1 | iex
$ErrorActionPreference = 'Stop'

$installRoot = Join-Path $env:APPDATA 'TransporteFullscreenPatch'
$patcherPath = Join-Path $installRoot 'patcher.js'
if (-not (Test-Path -LiteralPath $patcherPath -PathType Leaf)) {
    throw 'O TRANSPORTE Fullscreen Patch nao foi encontrado. Instale primeiro o pacote principal.'
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
$original = [IO.File]::ReadAllText($patcherPath, $utf8)
if ($original.Contains('features.add("AudioVideoTracks")')) {
    Write-Host 'Selecao nativa de faixas de audio ja instalada.' -ForegroundColor Green
    return
}
if (-not $original.Contains('log("patcher:start");')) {
    throw 'Versao do patch desconhecida; nada foi alterado.'
}

$snippet = @'

// Enable native audio track selection for directly played multi-audio media.
try {
  const current = electron.app.commandLine.getSwitchValue("enable-blink-features");
  const features = new Set(current.split(",").map((value) => value.trim()).filter(Boolean));
  features.add("AudioVideoTracks");
  electron.app.commandLine.appendSwitch("enable-blink-features", [...features].join(","));
  log("audio-tracks:blink-enabled");
} catch (error) {
  log("audio-tracks:blink-enable-failed", error);
}
'@
$updated = $original.Replace('log("patcher:start");', 'log("patcher:start");' + $snippet)
if ($updated -eq $original) { throw 'Nao foi possivel atualizar o patch.' }

$backupPath = Join-Path $installRoot ('patcher.before-audio-tracks-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.js')
$tempPath = Join-Path $installRoot ('patcher.audio-tracks-' + [guid]::NewGuid().ToString('N') + '.js')
Copy-Item -LiteralPath $patcherPath -Destination $backupPath -ErrorAction Stop
try {
    [IO.File]::WriteAllText($tempPath, $updated, $utf8)
    if (Get-Command node -ErrorAction SilentlyContinue) {
        & node --check $tempPath
        if ($LASTEXITCODE -ne 0) { throw 'Falha na validacao do patch JavaScript.' }
    }
    Move-Item -LiteralPath $tempPath -Destination $patcherPath -Force -ErrorAction Stop
} catch {
    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath $backupPath -Destination $patcherPath -Force -ErrorAction SilentlyContinue
    throw
}

Write-Host 'Selecao nativa de faixas de audio instalada. Feche completamente e reabra o Discord para ativar.' -ForegroundColor Green
Write-Host "Backup: $backupPath"
