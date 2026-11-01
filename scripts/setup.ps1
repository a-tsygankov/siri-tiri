$ErrorActionPreference = 'Stop'
& py -3.13 (Join-Path $PSScriptRoot '../local-service/manage.py') setup @args
exit $LASTEXITCODE
