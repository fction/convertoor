param([Parameter(Mandatory)][ValidateSet('Initialize','CopyPassword','Start','Publish')][string]$Action)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$vaultDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Convertoor'
$vaultFile = Join-Path $vaultDir 'studio-access.dpapi'
if ($Action -eq 'Initialize') {
    if (Test-Path -LiteralPath $vaultFile) { Write-Output 'The existing Convertoor account was preserved.'; exit 0 }
    $record = & node scripts/generate-access.mjs
    if ($LASTEXITCODE -ne 0 -or !$record) { throw 'Account generation failed.' }
    [IO.Directory]::CreateDirectory($vaultDir) | Out-Null
    $secret = ConvertTo-SecureString $record -AsPlainText -Force
    $encrypted = ConvertFrom-SecureString -SecureString $secret
    $stream = [IO.File]::Open($vaultFile, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $bytes = [Text.Encoding]::UTF8.GetBytes($encrypted); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
    Write-Output 'Account fction is stored under the current Windows user with DPAPI protection.'
    exit 0
}
$secret = ConvertTo-SecureString ([IO.File]::ReadAllText($vaultFile))
$record = ([Net.NetworkCredential]::new('', $secret)).Password | ConvertFrom-Json
if ($Action -eq 'CopyPassword') {
    Set-Clipboard -Value $record.password
    Write-Output 'Password copied. Login: fction.'
} elseif ($Action -eq 'Start') {
    $env:CONVERTOOR_ACCOUNT = $record.account | ConvertTo-Json -Compress
    & node server.mjs
    exit $LASTEXITCODE
} elseif ($Action -eq 'Publish') {
    ($record.account | ConvertTo-Json -Compress) | npm.cmd exec --yes --package=vercel -- vercel env add CONVERTOOR_ACCOUNT production --sensitive --yes
    exit $LASTEXITCODE
}
