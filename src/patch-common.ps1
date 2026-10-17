$ErrorActionPreference = 'Stop'

$script:PatchName = 'TRANSPORTE Fullscreen Patch'
$script:PatchMarker = '.harbor-fullscreen-patch.json'
$script:Ac3RuntimeName = 'TRANSPORTE Discord AC3/E-AC3 + RTC'
$script:Ac3RuntimeMarker = '.harbor-electron-ac3.json'
$script:Ac3RuntimeVersion = '42.11.11'

function Get-HarborFileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Test-HarborFileSha256 {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256
    )
    return (Get-HarborFileSha256 -Path $Path) -eq $ExpectedSha256.Trim().ToUpperInvariant()
}

function Test-HarborDiscordExecutableIdentity {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    try {
        $versionInfo = (Get-Item -LiteralPath $Path).VersionInfo
        return $versionInfo.ProductName -eq 'Discord' -and
            $versionInfo.FileDescription -eq 'Discord' -and
            $versionInfo.InternalName -eq 'Discord.exe' -and
            $versionInfo.OriginalFilename -eq 'Discord.exe'
    } catch {
        return $false
    }
}

function Install-HarborAc3RuntimeIntoApp {
    param(
        [Parameter(Mandatory = $true)][string]$AppDir,
        [Parameter(Mandatory = $true)][string]$ArchivePath,
        [Parameter(Mandatory = $true)][string]$BackupRoot,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [Parameter(Mandatory = $true)][string]$RceditPath
    )

    if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) {
        throw "$script:Ac3RuntimeName: pacote nao encontrado em $ArchivePath"
    }
    if (-not (Test-HarborFileSha256 -Path $ArchivePath -ExpectedSha256 $ExpectedSha256)) {
        $actualHash = Get-HarborFileSha256 -Path $ArchivePath
        throw "$script:Ac3RuntimeName: SHA-256 invalido. Esperado $ExpectedSha256, recebido $actualHash"
    }
    if (-not (Test-Path -LiteralPath $RceditPath -PathType Leaf)) {
        throw "$script:Ac3RuntimeName: rcedit nao encontrado em $RceditPath"
    }

    $appName = Split-Path -Leaf $AppDir
    $markerPath = Join-Path $AppDir $script:Ac3RuntimeMarker
    $discordExe = Join-Path $AppDir 'Discord.exe'
    if ((Test-Path -LiteralPath $markerPath -PathType Leaf) -and
        (Test-Path -LiteralPath $discordExe -PathType Leaf)) {
        try {
            $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
            $ffmpegPath = Join-Path $AppDir 'ffmpeg.dll'
            if ($marker.archiveSha256 -eq $ExpectedSha256.Trim().ToUpperInvariant() -and
                $marker.electronSha256 -eq (Get-HarborFileSha256 -Path $discordExe) -and
                (Test-Path -LiteralPath $ffmpegPath -PathType Leaf) -and
                $marker.ffmpegSha256 -eq (Get-HarborFileSha256 -Path $ffmpegPath) -and
                (Test-HarborDiscordExecutableIdentity -Path $discordExe)) {
                Write-Host "$script:Ac3RuntimeName ja esta instalado em $appName."
                return $true
            }
        } catch {
            Write-Warning "$script:Ac3RuntimeName: marcador invalido; o runtime sera reparado."
        }
    }

    $extractRoot = Join-Path ([IO.Path]::GetTempPath()) ("harbor-electron-ac3-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $extractRoot | Out-Null
    try {
        Expand-Archive -LiteralPath $ArchivePath -DestinationPath $extractRoot -Force
        $sourceExe = Join-Path $extractRoot 'electron.exe'
        $sourceFfmpeg = Join-Path $extractRoot 'ffmpeg.dll'
        $versionFile = Join-Path $extractRoot 'version'
        if (-not (Test-Path -LiteralPath $sourceExe -PathType Leaf) -or
            -not (Test-Path -LiteralPath $sourceFfmpeg -PathType Leaf) -or
            -not (Test-Path -LiteralPath $versionFile -PathType Leaf)) {
            throw "$script:Ac3RuntimeName: o pacote nao contem electron.exe, ffmpeg.dll e version"
        }
        $runtimeVersion = (Get-Content -LiteralPath $versionFile -Raw).Trim()
        if ($runtimeVersion -ne $script:Ac3RuntimeVersion) {
            throw "$script:Ac3RuntimeName: versao $runtimeVersion incompativel; esperado $script:Ac3RuntimeVersion"
        }

        $fileMap = @(
            @{ Source = 'electron.exe'; Destination = 'Discord.exe' },
            @{ Source = 'ffmpeg.dll'; Destination = 'ffmpeg.dll' },
            @{ Source = 'chrome_100_percent.pak'; Destination = 'chrome_100_percent.pak' },
            @{ Source = 'chrome_200_percent.pak'; Destination = 'chrome_200_percent.pak' },
            @{ Source = 'd3dcompiler_47.dll'; Destination = 'd3dcompiler_47.dll' },
            @{ Source = 'dxcompiler.dll'; Destination = 'dxcompiler.dll' },
            @{ Source = 'dxil.dll'; Destination = 'dxil.dll' },
            @{ Source = 'icudtl.dat'; Destination = 'icudtl.dat' },
            @{ Source = 'libEGL.dll'; Destination = 'libEGL.dll' },
            @{ Source = 'libGLESv2.dll'; Destination = 'libGLESv2.dll' },
            @{ Source = 'resources.pak'; Destination = 'resources.pak' },
            @{ Source = 'snapshot_blob.bin'; Destination = 'snapshot_blob.bin' },
            @{ Source = 'v8_context_snapshot.bin'; Destination = 'v8_context_snapshot.bin' },
            @{ Source = 'vk_swiftshader.dll'; Destination = 'vk_swiftshader.dll' },
            @{ Source = 'vk_swiftshader_icd.json'; Destination = 'vk_swiftshader_icd.json' },
            @{ Source = 'vulkan-1.dll'; Destination = 'vulkan-1.dll' }
        )
        foreach ($locale in @(Get-ChildItem -LiteralPath (Join-Path $extractRoot 'locales') -File -Filter '*.pak' -ErrorAction SilentlyContinue)) {
            $fileMap += @{ Source = "locales/$($locale.Name)"; Destination = "locales/$($locale.Name)" }
        }

        foreach ($entry in $fileMap) {
            if (-not (Test-Path -LiteralPath (Join-Path $extractRoot $entry.Source) -PathType Leaf)) {
                throw "$script:Ac3RuntimeName: arquivo obrigatorio ausente no pacote: $($entry.Source)"
            }
        }

        $backupDir = Join-Path $BackupRoot $appName
        $backupManifestPath = Join-Path $backupDir 'runtime-backup.json'
        if (-not (Test-Path -LiteralPath $backupManifestPath -PathType Leaf)) {
            New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
            $originalFiles = @()
            foreach ($entry in $fileMap) {
                $targetPath = Join-Path $AppDir $entry.Destination
                if (Test-Path -LiteralPath $targetPath -PathType Leaf) {
                    $backupPath = Join-Path $backupDir $entry.Destination
                    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $backupPath) | Out-Null
                    Copy-Item -LiteralPath $targetPath -Destination $backupPath -Force
                    $originalFiles += $entry.Destination
                }
            }
            $backupManifest = [ordered]@{
                appName = $appName
                createdAt = (Get-Date).ToUniversalTime().ToString('o')
                originalFiles = @($originalFiles)
                installedFiles = @($fileMap | ForEach-Object { $_.Destination })
            }
            $backupManifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $backupManifestPath -Encoding UTF8
        }

        foreach ($entry in $fileMap) {
            $sourcePath = Join-Path $extractRoot $entry.Source
            $targetPath = Join-Path $AppDir $entry.Destination
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetPath) | Out-Null
            Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
        }

        $discordIcon = Join-Path $AppDir 'app.ico'
        $brandingArguments = @(
            $discordExe,
            '--set-version-string', 'ProductName', 'Discord',
            '--set-version-string', 'FileDescription', 'Discord',
            '--set-version-string', 'InternalName', 'Discord.exe',
            '--set-version-string', 'OriginalFilename', 'Discord.exe',
            '--set-version-string', 'CompanyName', 'Discord Inc.',
            '--set-version-string', 'LegalCopyright', 'Copyright Discord Inc.'
        )
        if (Test-Path -LiteralPath $discordIcon -PathType Leaf) {
            $brandingArguments += @('--set-icon', $discordIcon)
        }
        & $RceditPath @brandingArguments
        if ($LASTEXITCODE -ne 0) {
            throw "$script:Ac3RuntimeName: nao foi possivel aplicar a identidade Discord ao executavel"
        }
        if (-not (Test-HarborDiscordExecutableIdentity -Path $discordExe)) {
            throw "$script:Ac3RuntimeName: o executavel instalado ainda possui identidade Electron"
        }

        $installedMarker = [ordered]@{
            name = $script:Ac3RuntimeName
            runtimeVersion = $runtimeVersion
            archiveSha256 = $ExpectedSha256.Trim().ToUpperInvariant()
            electronSha256 = (Get-HarborFileSha256 -Path $discordExe)
            sourceElectronSha256 = (Get-HarborFileSha256 -Path $sourceExe)
            ffmpegSha256 = (Get-HarborFileSha256 -Path $sourceFfmpeg)
            installedAt = (Get-Date).ToUniversalTime().ToString('o')
            backupDirectory = $backupDir
            krisp = 'indisponivel em executavel sem assinatura oficial da Discord'
            executableIdentity = 'Discord'
        }
        $installedMarker | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $markerPath -Encoding UTF8
        Write-Host "$script:Ac3RuntimeName instalado em $appName."
        return $true
    } finally {
        if (Test-Path -LiteralPath $extractRoot -PathType Container) {
            Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Uninstall-HarborAc3RuntimeFromApp {
    param(
        [Parameter(Mandatory = $true)][string]$AppDir,
        [Parameter(Mandatory = $true)][string]$BackupRoot
    )

    $appName = Split-Path -Leaf $AppDir
    $markerPath = Join-Path $AppDir $script:Ac3RuntimeMarker
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { return $false }

    $backupDir = Join-Path $BackupRoot $appName
    $backupManifestPath = Join-Path $backupDir 'runtime-backup.json'
    if (-not (Test-Path -LiteralPath $backupManifestPath -PathType Leaf)) {
        throw "$script:Ac3RuntimeName: backup nao encontrado em $backupDir; nada foi restaurado"
    }
    $manifest = Get-Content -LiteralPath $backupManifestPath -Raw | ConvertFrom-Json
    $originalFiles = @($manifest.originalFiles)
    foreach ($relativePath in @($manifest.installedFiles)) {
        $targetPath = Join-Path $AppDir $relativePath
        if ($relativePath -in $originalFiles) {
            $backupPath = Join-Path $backupDir $relativePath
            if (-not (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
                throw "$script:Ac3RuntimeName: backup incompleto; faltando $relativePath"
            }
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetPath) | Out-Null
            Copy-Item -LiteralPath $backupPath -Destination $targetPath -Force
        } elseif (Test-Path -LiteralPath $targetPath -PathType Leaf) {
            Remove-Item -LiteralPath $targetPath -Force
        }
    }
    Remove-Item -LiteralPath $markerPath -Force
    Write-Host "$script:Ac3RuntimeName removido de $appName e binarios originais restaurados."
    return $true
}

function Get-HarborDiscordApps {
    param([string]$DiscordRoot = (Join-Path $env:LOCALAPPDATA 'Discord'))

    if (-not (Test-Path -LiteralPath $DiscordRoot -PathType Container)) { return @() }
    return @(Get-ChildItem -LiteralPath $DiscordRoot -Directory -Filter 'app-*' |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'resources') } |
        Sort-Object { try { [version]($_.Name -replace '^app-', '') } catch { [version]'0.0' } } -Descending)
}

function Test-HarborPatchOwner {
    param([string]$LoaderDir)
    return Test-Path -LiteralPath (Join-Path $LoaderDir $script:PatchMarker) -PathType Leaf
}

function Install-HarborPatchIntoApp {
    param(
        [Parameter(Mandatory = $true)][string]$AppDir,
        [Parameter(Mandatory = $true)][string]$PatcherPath
    )

    $resources = Join-Path $AppDir 'resources'
    $appAsar = Join-Path $resources 'app.asar'
    $originalAsar = Join-Path $resources '_app.asar'

    if (-not (Test-Path -LiteralPath $appAsar)) {
        Write-Warning "$script:PatchName: app.asar não encontrado em $AppDir"
        return $false
    }

    if (Test-Path -LiteralPath $appAsar -PathType Container) {
        if (Test-HarborPatchOwner -LoaderDir $appAsar) {
            Write-Host "$script:PatchName já está instalado em $($AppDir | Split-Path -Leaf)."
            return $true
        }
        Write-Warning "$($AppDir | Split-Path -Leaf) já usa outro modificador; ele não será sobrescrito."
        return $false
    }

    if (Test-Path -LiteralPath $originalAsar) {
        Write-Warning "Backup _app.asar já existe em $($AppDir | Split-Path -Leaf); instalação ignorada por segurança."
        return $false
    }

    try {
        Move-Item -LiteralPath $appAsar -Destination $originalAsar
        New-Item -ItemType Directory -Path $appAsar | Out-Null
        Set-Content -LiteralPath (Join-Path $appAsar 'package.json') -Encoding UTF8 -NoNewline -Value '{"name":"discord","main":"index.js"}'
        $loader = "// $script:PatchName`r`nrequire($($PatcherPath | ConvertTo-Json -Compress));`r`n"
        Set-Content -LiteralPath (Join-Path $appAsar 'index.js') -Encoding UTF8 -NoNewline -Value $loader
        Set-Content -LiteralPath (Join-Path $appAsar $script:PatchMarker) -Encoding UTF8 -Value '{"name":"TRANSPORTE Fullscreen Patch","version":1}'
        Write-Host "$script:PatchName instalado em $($AppDir | Split-Path -Leaf)."
        return $true
    } catch {
        if (Test-Path -LiteralPath $appAsar -PathType Container) {
            Remove-Item -LiteralPath $appAsar -Recurse -Force
        }
        if ((-not (Test-Path -LiteralPath $appAsar)) -and (Test-Path -LiteralPath $originalAsar -PathType Leaf)) {
            Move-Item -LiteralPath $originalAsar -Destination $appAsar
        }
        throw
    }
}

function Uninstall-HarborPatchFromApp {
    param([Parameter(Mandatory = $true)][string]$AppDir)

    $resources = Join-Path $AppDir 'resources'
    $appAsar = Join-Path $resources 'app.asar'
    $originalAsar = Join-Path $resources '_app.asar'
    if (-not (Test-Path -LiteralPath $appAsar -PathType Container)) { return $false }
    if (-not (Test-HarborPatchOwner -LoaderDir $appAsar)) { return $false }
    if (-not (Test-Path -LiteralPath $originalAsar -PathType Leaf)) {
        throw "O backup original não foi encontrado em $originalAsar. Nada foi removido."
    }

    Remove-Item -LiteralPath $appAsar -Recurse -Force
    Move-Item -LiteralPath $originalAsar -Destination $appAsar
    Write-Host "$script:PatchName removido de $($AppDir | Split-Path -Leaf)."
    return $true
}
