$ErrorActionPreference = 'Stop'
& py -3 (Join-Path $PSScriptRoot '../local-service/manage.py') prepare-catmeows @args
exit $LASTEXITCODE
