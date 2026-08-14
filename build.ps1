# Build cno + ext-oxc and collect everything into dist\exe\
# ext-oxc is OPTIONAL: it needs a Rust toolchain. If cargo is missing the
# ext-oxc step is skipped with a notice and the build still succeeds.
$ErrorActionPreference = "Stop"

$BuildDir    = "build"
$OxcBuildDir = "ext-oxc\build"
$DistDir     = "dist\exe"
$Root        = $PSScriptRoot

# CMake's `-S .` and all relative output paths must refer to the checkout,
# even when this script is launched from another working directory.
Push-Location $Root
try {

# ── 1. Main project ───────────────────────────────────────────────────────────
cmake -S . -B $BuildDir -DCMAKE_BUILD_TYPE=Release
cmake --build $BuildDir --config Release --parallel

# ── 2. ext-oxc (optional) ─────────────────────────────────────────────────────
# The extension calls QuickJS JS_* APIs. Those live in qjs.dll (circu.js forces
# BUILD_SHARED_LIBS=ON for QuickJS on Windows), so the import library to link is
# deps\quickjs\qjs.lib — NOT cjs.lib, which exports only the TJS_* host API and
# zero JS_* symbols.
$OxcBuilt = $false
$CnoLib   = $null

# Single-config generators (Ninja, the default here) put it directly under
# circu.js\deps\quickjs\; multi-config (Visual Studio) adds a per-config subdir.
foreach ($cand in @(
    "$Root\$BuildDir\circu.js\deps\quickjs\qjs.lib",
    "$Root\$BuildDir\circu.js\deps\quickjs\Release\qjs.lib",
    "$Root\$BuildDir\circu.js\deps\quickjs\Debug\qjs.lib"
)) {
    if (Test-Path $cand) { $CnoLib = $cand; break }
}

# Rust is not part of the required toolchain — probe before doing anything.
$HasCargo = $false
try {
    cargo --version *> $null
    if ($LASTEXITCODE -eq 0) { $HasCargo = $true }
} catch { $HasCargo = $false }

if (-not $HasCargo) {
    Write-Host "note: cargo not found — skipping ext-oxc (optional native TS transform)."
    Write-Host "      CTS falls back to the bundled Sucrase transformer."
    Write-Host "      Install a Rust toolchain and re-run to build it."
} elseif (-not $CnoLib) {
    Write-Warning "qjs.lib not found under $BuildDir\circu.js\deps\quickjs\ — skipping ext-oxc."
} else {
    # Release for the extension even when the host is Debug: the Rust staticlib is
    # always linked against the release dynamic CRT, and it is linked INTO this
    # DLL. Forcing Debug here mixes two CRTs inside one module. Nothing is
    # allocated on one side and freed on the other across the host boundary
    # (JS_* memory is freed inside qjs.dll, Rust memory via cjs_oxc_result_free),
    # so one clean CRT per module is correct.
    # ext-oxc's CMake target defines USING_QJS_SHARED on Windows so the JS_*
    # prototypes use __declspec(dllimport), as required for qjs.dll.
    try {
        cmake -S ext-oxc -B $OxcBuildDir -DCMAKE_BUILD_TYPE=Release `
          -DCJS_DIR="$Root\circu.js" `
          -DCNO_IMPLIB="$CnoLib"
        cmake --build $OxcBuildDir --config Release --parallel
        $OxcBuilt = $true
    } catch {
        Write-Warning "ext-oxc build failed: $_"
        Write-Warning "Continuing without it — CTS falls back to Sucrase."
    }
}

# ── 3. Collect into dist\exe\ ─────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path "$DistDir\ext" | Out-Null

Copy-Item "$BuildDir\stage\cno.exe" "$DistDir\cno.exe" -Force
Copy-Item "$BuildDir\stage\qjs.dll" "$DistDir\qjs.dll" -Force

if ($OxcBuilt) {
    # oxc.dll lands directly in the build dir (Ninja) or under Release\ (VS).
    $OxcDll = @(
        "$OxcBuildDir\oxc.dll",
        "$OxcBuildDir\Release\oxc.dll"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1

    if ($OxcDll) {
        Copy-Item $OxcDll "$DistDir\ext\oxc.dll" -Force
    } else {
        Write-Warning "oxc.dll not found — ext-oxc may have failed to build"
    }
}

Write-Host ""
Write-Host "dist\exe\ contents:"
Get-ChildItem "$DistDir", "$DistDir\ext" | Format-Table Name, Length
} finally {
    Pop-Location
}
