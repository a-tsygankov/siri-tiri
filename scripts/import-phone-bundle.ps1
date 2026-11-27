param(
    [Parameter(Mandatory=$true)][string]$Bundle,
    [Parameter(Mandatory=$true)][string]$AudioDir,
    [string]$ArchiveRoot
)
$cliArgs = @('-3', (Join-Path $PSScriptRoot '../local-service/manage.py'), 'import-bundle', $Bundle, '--audio-dir', $AudioDir)
if ($ArchiveRoot) { $cliArgs += @('--archive-root', $ArchiveRoot) }
& py @cliArgs
exit $LASTEXITCODE
