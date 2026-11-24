# 生成免安装绿色包：内置 Node、程序、模型、ADB 和启动器。构建机执行，不要求 BD 安装开发环境。
param(
  [switch]$SkipModel,
  [string]$OutDir = 'dist-release'
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root
$Stage = Join-Path $Root (Join-Path $OutDir 'TakeoutPriceMonitor')
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Path $Stage -Force | Out-Null

Write-Host '1/7 构建程序'
npm run build | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'npm run build 失败' }

Write-Host '2/7 复制运行程序和生产依赖'
foreach ($name in @('dist','public','node_modules','package.json','package-lock.json','README.md','LICENSE','ARCHITECTURE.md')) {
  if (Test-Path $name) { Copy-Item $name (Join-Path $Stage $name) -Recurse -Force }
}
Push-Location $Stage
try {
  npm prune --omit=dev --no-audit --no-fund 2>&1 | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'npm prune 失败' }
} finally { Pop-Location }

Write-Host '3/7 复制 Node 运行环境'
$node = (Get-Command node).Source
if (-not (Test-Path $node)) { throw '找不到 node.exe' }
New-Item -ItemType Directory -Path (Join-Path $Stage 'runtime') -Force | Out-Null
Copy-Item $node (Join-Path $Stage 'runtime\node.exe') -Force

Write-Host '4/7 复制 ADB'
$adbSource = if ($env:MIDSCENE_ADB_PATH) { Split-Path -Parent $env:MIDSCENE_ADB_PATH } else { Join-Path $Root '.runtime\adb-official-probe\platform-tools' }
if (Test-Path (Join-Path $adbSource 'adb.exe')) {
  New-Item -ItemType Directory -Path (Join-Path $Stage 'tools\adb') -Force | Out-Null
  Copy-Item (Join-Path $adbSource '*') (Join-Path $Stage 'tools\adb') -Recurse -Force
} else { Write-Warning '没有找到 ADB，自动采集在目标机器上不可用' }

Write-Host '5/7 复制模型'
$modelSource = Join-Path $Root '.runtime\local-model-lab'
if ($SkipModel) {
  Write-Warning '跳过模型复制，生成的是测试包，不能用于交付'
  New-Item -ItemType Junction -Path (Join-Path $Stage 'model') -Target $modelSource | Out-Null
} elseif (Test-Path (Join-Path $modelSource 'vulkan\llama-server.exe')) {
  New-Item -ItemType Directory -Path (Join-Path $Stage 'model') -Force | Out-Null
  Copy-Item (Join-Path $modelSource 'vulkan') (Join-Path $Stage 'model\vulkan') -Recurse -Force
  foreach ($file in @('Qwen3-VL-2B-Instruct-Q8_0.gguf','mmproj-Qwen3-VL-2B-Instruct-Q8_0.gguf','api-key')) {
    Copy-Item (Join-Path $modelSource $file) (Join-Path $Stage 'model') -Force
  }
} else { throw '模型目录不完整，不能生成完整安装包' }

Write-Host '6/7 编译并复制启动器'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw '找不到 Windows 自带 C# 编译器 csc.exe' }
$launcherOut = Join-Path $Stage 'TakeoutPriceMonitor.exe'
& $csc /nologo /target:winexe /codepage:65001 "/out:$launcherOut" (Join-Path $Root 'packaging\launcher\Launcher.cs')
if ($LASTEXITCODE -ne 0) { throw '启动器编译失败' }
if (Test-Path 'android-sources.example.json') { New-Item -ItemType Directory -Path (Join-Path $Stage 'config') -Force | Out-Null; Copy-Item 'android-sources.example.json' (Join-Path $Stage 'config') -Force }
Copy-Item '.env.example' (Join-Path $Stage 'config\.env.example') -Force -ErrorAction SilentlyContinue

Write-Host '7/7 写版本信息'
$pkg = Get-Content 'package.json' -Raw | ConvertFrom-Json
"三平台比价工具 $($pkg.version)`r`n构建时间：$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" | Set-Content (Join-Path $Stage 'VERSION.txt') -Encoding UTF8
$hint = @'
双击 TakeoutPriceMonitor.exe 启动工具。
第一次启动会打开设置向导；数据保存在 data 目录（或 TAKEOUT_DATA_DIR 指定的目录）。
不要删除 data 目录；升级时只替换程序文件，保留 data。
'@
$hint | Set-Content (Join-Path $Stage '使用说明.txt') -Encoding UTF8

$size = (Get-ChildItem $Stage -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
Write-Host ("完成：{0}  约 {1:N0} MB" -f $Stage, ($size / 1MB))
exit 0
