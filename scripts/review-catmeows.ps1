# Commands: review-init/export/label/score; detector-calibrate/freeze/evaluate.
$ErrorActionPreference = 'Stop'
& py -3 (Join-Path $PSScriptRoot '../local-service/manage.py') @args
exit $LASTEXITCODE
