$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'src\patch-common.ps1')

$probe = Join-Path ([IO.Path]::GetTempPath()) 'harbor-hash-probe.txt'
try {
    [IO.File]::WriteAllText($probe, 'ok')
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $probe).Hash
    if (-not (Test-HarborFileSha256 -Path $probe -ExpectedSha256 $hash)) {
        throw 'Teste de hash falhou.'
    }
} finally {
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
}

$hashParams = (Get-Command Test-HarborFileSha256).Parameters.Keys
$installParams = (Get-Command Install-HarborAc3RuntimeIntoApp).Parameters.Keys
if ('RceditPath' -in $hashParams) {
    throw 'RceditPath foi associado incorretamente a Test-HarborFileSha256.'
}
if ('RceditPath' -notin $installParams) {
    throw 'RceditPath esta ausente de Install-HarborAc3RuntimeIntoApp.'
}

Write-Host 'Teste funcional OK: hash nao pede RceditPath.'
