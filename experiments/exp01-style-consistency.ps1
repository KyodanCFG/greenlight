# Experiment 01 — Cross-asset style consistency
#
# Question: does the Image-to-Image -> Image-to-3D funnel (shared 2D style anchor)
# produce a visibly more cohesive set than three independent Text-to-3D calls with
# identical style keywords? The docs offer no deterministic mechanism (no seed), so
# this can only be answered empirically. See docs/API_NOTES.md section 3.
#
# Two arms, same three assets (goblin scout, watchtower, treasure chest):
#   control: text-to-3d preview+refine x3, style words repeated in each prompt
#   funnel:  text-to-image anchor -> image-to-image x3 (shared reference)
#            -> image-to-3d x3 via input_task_id
#
# Estimated cost: ~100 credits. Outputs under generated/exp01/ (gitignored).
# Usage: pwsh -File experiments/exp01-style-consistency.ps1
#   -FunnelOnly -AnchorId <task-id>   resume the funnel arm from an existing anchor

param([switch]$FunnelOnly, [string]$AnchorId)

$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$outDir = Join-Path $repo "generated\exp01"
New-Item -ItemType Directory -Force $outDir | Out-Null
$log = Join-Path $outDir "exp01.log"

# Write-Host + Add-Content, NOT Tee-Object: Tee emits into the pipeline, which
# pollutes function return values (this bug broke the first run).
function Log($msg) {
    $line = "$(Get-Date -Format 'HH:mm:ss') $msg"
    Write-Host $line
    Add-Content -Path $log -Value $line
}

$key = (Get-Content (Join-Path $repo ".env") | Select-String '^MESHY_API_KEY=(.*)$').Matches.Groups[1].Value
if (-not $key -or $key -eq 'replace_with_your_meshy_api_key') { throw "No MESHY_API_KEY in .env" }
$H = @{ Authorization = "Bearer $key" }
$base = "https://api.meshy.ai"

function New-MeshyTask($path, $body) {
    $resp = Invoke-RestMethod -Uri "$base$path" -Method POST -Headers $H -ContentType "application/json" -Body ($body | ConvertTo-Json -Depth 5)
    return $resp.result
}

function Wait-MeshyTask($path, $id, $label, $timeoutSec = 900) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ($true) {
        $t = Invoke-RestMethod -Uri "$base$path/$id" -Method GET -Headers $H
        if ($t.status -in @("SUCCEEDED", "FAILED", "CANCELED")) {
            Log "  [$label] $($t.status) (credits: $($t.consumed_credits); error: $($t.task_error.message))"
            return $t
        }
        if ((Get-Date) -gt $deadline) { Log "  [$label] TIMEOUT after ${timeoutSec}s in status $($t.status)"; return $t }
        Start-Sleep -Seconds 10
    }
}

function Save-Url($url, $file) {
    if ($url) { Invoke-WebRequest -Uri $url -OutFile (Join-Path $outDir $file) | Out-Null }
}

$style = "low-poly stylized game asset, flat shading, muted swamp palette of moss green and bog brown, hand-painted texture look, single object on plain background"
$assets = @(
    @{ key = "goblin";  desc = "a small goblin scout character holding a wooden spear" },
    @{ key = "tower";   desc = "a crooked wooden watchtower on stilts" },
    @{ key = "chest";   desc = "a mossy wooden treasure chest with iron bands" }
)

$balance0 = (Invoke-RestMethod -Uri "$base/openapi/v1/balance" -Headers $H).balance
Log "=== exp01 start. balance: $balance0 ==="
$results = @{ control = @(); funnel = @() }

# ---- CONTROL ARM: independent text-to-3d, shared style words ----
if (-not $FunnelOnly) {
Log "--- control arm: 3x text-to-3d (preview+refine), style words in prompt ---"
$ctrlPreviews = @()
foreach ($a in $assets) {
    $id = New-MeshyTask "/openapi/v2/text-to-3d" @{ mode = "preview"; prompt = "$($a.desc), $style"; ai_model = "meshy-5" }
    Log "  submitted preview $($a.key): $id"
    $ctrlPreviews += @{ asset = $a; id = $id }
}
$ctrlRefines = @()
foreach ($p in $ctrlPreviews) {
    $t = Wait-MeshyTask "/openapi/v2/text-to-3d" $p.id "control-preview-$($p.asset.key)"
    if ($t.status -eq "SUCCEEDED") {
        $rid = New-MeshyTask "/openapi/v2/text-to-3d" @{ mode = "refine"; preview_task_id = $p.id }
        Log "  submitted refine $($p.asset.key): $rid"
        $ctrlRefines += @{ asset = $p.asset; id = $rid }
    }
}
foreach ($r in $ctrlRefines) {
    $t = Wait-MeshyTask "/openapi/v2/text-to-3d" $r.id "control-refine-$($r.asset.key)"
    $t | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $outDir "control-$($r.asset.key).json")
    Save-Url $t.thumbnail_url "control-$($r.asset.key)-thumb.png"
    Save-Url $t.model_urls.glb "control-$($r.asset.key).glb"
    $results.control += @{ asset = $r.asset.key; status = $t.status }
}
}

# ---- FUNNEL ARM ----
Log "--- funnel arm: shared 2D anchor -> image-to-image -> image-to-3d ---"
if ($AnchorId) {
    $anchorTaskId = $AnchorId
    Log "  reusing existing anchor: $anchorTaskId"
} else {
    $anchorTaskId = New-MeshyTask "/openapi/v1/text-to-image" @{ ai_model = "nano-banana"; prompt = "concept art style sheet for a swamp goblin camp game, $style" }
    Log "  submitted anchor: $anchorTaskId"
}
$anchor = Wait-MeshyTask "/openapi/v1/text-to-image" $anchorTaskId "anchor"
if ($anchor.status -ne "SUCCEEDED") { Log "anchor failed, aborting funnel arm"; }
else {
    $anchorUrl = $anchor.image_urls[0]
    Save-Url $anchorUrl "funnel-anchor.png"
    $i2iTasks = @()
    foreach ($a in $assets) {
        $id = New-MeshyTask "/openapi/v1/image-to-image" @{
            ai_model = "nano-banana"
            prompt = "$($a.desc), exactly matching the art style of the reference image"
            reference_image_urls = @($anchorUrl)
        }
        Log "  submitted i2i $($a.key): $id"
        $i2iTasks += @{ asset = $a; id = $id }
    }
    $i3dTasks = @()
    foreach ($t2 in $i2iTasks) {
        $t = Wait-MeshyTask "/openapi/v1/image-to-image" $t2.id "funnel-i2i-$($t2.asset.key)"
        if ($t.status -eq "SUCCEEDED") {
            Save-Url $t.image_urls[0] "funnel-$($t2.asset.key)-concept.png"
            $id = New-MeshyTask "/openapi/v1/image-to-3d" @{ input_task_id = $t2.id; ai_model = "meshy-5"; should_texture = $true }
            Log "  submitted i3d $($t2.asset.key): $id"
            $i3dTasks += @{ asset = $t2.asset; id = $id }
        }
    }
    foreach ($t3 in $i3dTasks) {
        $t = Wait-MeshyTask "/openapi/v1/image-to-3d" $t3.id "funnel-i3d-$($t3.asset.key)"
        $t | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $outDir "funnel-$($t3.asset.key).json")
        Save-Url $t.thumbnail_url "funnel-$($t3.asset.key)-thumb.png"
        Save-Url $t.model_urls.glb "funnel-$($t3.asset.key).glb"
        $results.funnel += @{ asset = $t3.asset.key; status = $t.status }
    }
}

$balance1 = (Invoke-RestMethod -Uri "$base/openapi/v1/balance" -Headers $H).balance
Log "=== exp01 done. balance: $balance0 -> $balance1 (spent $($balance0 - $balance1)) ==="
Log ("control: " + (($results.control | ForEach-Object { "$($_.asset)=$($_.status)" }) -join " "))
Log ("funnel:  " + (($results.funnel | ForEach-Object { "$($_.asset)=$($_.status)" }) -join " "))
