$ErrorActionPreference = "Stop"
$uiRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$release = Join-Path $uiRoot "release"
$output = Join-Path $release "LOOP-Creator-OS-MVP.exe"
$source = Join-Path $PSScriptRoot "LoopMvpLauncher.cs"
$compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $compiler)) {
  $compiler = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path -LiteralPath $compiler)) {
  throw "Windows C# compiler was not found."
}
New-Item -ItemType Directory -Force -Path $release | Out-Null
& $compiler "/nologo" "/target:winexe" "/optimize+" "/platform:anycpu" "/out:$output" "/reference:System.Windows.Forms.dll" "/reference:System.Drawing.dll" $source
if ($LASTEXITCODE -ne 0) { throw "EXE compilation failed." }
Write-Host "Built $output"
