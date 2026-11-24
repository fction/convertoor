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
    $pendingFile = Join-Path $vaultDir ([IO.Path]::GetRandomFileName())
    try {
        [IO.File]::WriteAllText($pendingFile, $encrypted)
        # The first completed initialization publishes its account atomically.
        try { [IO.File]::Move($pendingFile, $vaultFile) }
        catch [IO.IOException] {
            if (![IO.File]::Exists($vaultFile)) { throw }
            Write-Output 'The existing Convertoor account was preserved.'
            exit 0
        }
    } finally { [IO.File]::Delete($pendingFile) }
    Write-Output 'Account fction is stored under the current Windows user with DPAPI protection.'
    exit 0
}
$secret = ConvertTo-SecureString ([IO.File]::ReadAllText($vaultFile))
$record = ([Net.NetworkCredential]::new('', $secret)).Password | ConvertFrom-Json
if ($Action -eq 'CopyPassword') {
    Set-Clipboard -Value $record.password
    Write-Output 'Password copied. Login: fction.'
} elseif ($Action -eq 'Start') {
    $previousAccount = $env:CONVERTOOR_ACCOUNT
    try {
        $env:CONVERTOOR_ACCOUNT = $record.account | ConvertTo-Json -Compress
        & node server.mjs
        $serverExitCode = $LASTEXITCODE
    } finally { $env:CONVERTOOR_ACCOUNT = $previousAccount }
    exit $serverExitCode
} elseif ($Action -eq 'Publish') {
    ($record.account | ConvertTo-Json -Compress) | npm.cmd exec --yes --package=vercel -- vercel env add CONVERTOOR_ACCOUNT production --sensitive --yes
    exit $LASTEXITCODE
}
