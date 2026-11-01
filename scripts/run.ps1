$ErrorActionPreference = 'Stop'
& py -3 (Join-Path $PSScriptRoot '../local-service/manage.py') run @args
exit $LASTEXITCODE
