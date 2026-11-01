$ErrorActionPreference = 'Stop'
& py -3 (Join-Path $PSScriptRoot '../local-service/manage.py') tests @args
exit $LASTEXITCODE
