param([switch]$CatMeows)
# Optional research dataset: https://zenodo.org/records/4008297
$ErrorActionPreference = 'Stop'
$taskSetupArgs = @('setup')
if ($CatMeows) { $taskSetupArgs += '--catmeows' }
& py -3.13 (Join-Path $PSScriptRoot '../local-service/manage.py') @taskSetupArgs @args
exit $LASTEXITCODE
