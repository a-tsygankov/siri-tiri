$ErrorActionPreference = 'Stop'
& py -3 (Join-Path $PSScriptRoot '../local-service/manage.py') evaluate-catmeows @args
exit $LASTEXITCODE
