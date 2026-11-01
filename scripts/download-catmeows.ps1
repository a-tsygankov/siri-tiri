# Authors' download and research/non-commercial terms: https://zenodo.org/records/4008297
$ErrorActionPreference = 'Stop'
& py -3 (Join-Path $PSScriptRoot '../local-service/manage.py') catmeows @args
exit $LASTEXITCODE
