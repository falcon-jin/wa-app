param(
    [string]$Image = "registry.cn-hangzhou.aliyuncs.com/falcon-tools/wa-app:latest",
    [string]$Context = "",
    [string]$Dockerfile = "",
    [switch]$NoCache,
    [switch]$SkipPush
)

$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
    $scriptDir = Split-Path -Parent $PSCommandPath
    return (Resolve-Path -LiteralPath (Join-Path $scriptDir "..")).Path
}

function Run-Step {
    param(
        [string]$Name,
        [string[]]$Command
    )

    Write-Host "==> $Name"
    $exe = $Command[0]
    $args = @($Command | Select-Object -Skip 1)
    & $exe @args
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "docker command was not found. Install Docker or add it to PATH."
}

$repoRoot = Resolve-RepoRoot
if ([string]::IsNullOrWhiteSpace($Context)) {
    $Context = $repoRoot
}
if ([string]::IsNullOrWhiteSpace($Dockerfile)) {
    $Dockerfile = Join-Path $repoRoot "Dockerfile"
}

$resolvedContext = (Resolve-Path -LiteralPath $Context).Path
$resolvedDockerfile = (Resolve-Path -LiteralPath $Dockerfile).Path

$buildArgs = @("build", "--pull", "-f", $resolvedDockerfile, "-t", $Image)
if ($NoCache) {
    $buildArgs += "--no-cache"
}
$buildArgs += $resolvedContext

Run-Step -Name "Docker daemon check" -Command @("docker", "version")
Run-Step -Name "Build image $Image" -Command (@("docker") + $buildArgs)

if ($SkipPush) {
    Write-Host "SkipPush set; image was built but not pushed."
    exit 0
}

Run-Step -Name "Push image $Image" -Command @("docker", "push", $Image)
Write-Host "Published $Image"
