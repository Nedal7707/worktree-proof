# read-shot.ps1 - wrapper for screenshot-reader
# Usage: .\read-shot.ps1 <image-path> [--json]
param(
    [Parameter(Mandatory = $true)][string]$Image,
    [switch]$Json
)
$reader = "C:\VectorHQ\screenshot-reader\reader.py"
if (-not (Test-Path -LiteralPath $Image)) {
    Write-Error "image not found: $Image"
    exit 1
}
if (-not (Test-Path -LiteralPath $reader)) {
    Write-Error "reader.py not found at $reader"
    exit 1
}
if ($Json) {
    python $reader $Image --json
} else {
    python $reader $Image
}
exit $LASTEXITCODE