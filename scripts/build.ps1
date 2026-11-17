# waarp build: a compact build UI with a talking robot, a live progress bar and a summary card.
# Animated only in a real console with cursor control; redirected / captured output gets plain lines (no redraw spam).
#   build.bat 1      app + unpacked folder (dist\win-unpacked\Waarp.exe): fast, local checks
#   build.bat 2      app + portable exe (dist\Waarp-<version>-portable.exe): ready for delivery
#   build.bat 3      android debug apk (out\android\*.apk), same as "build.bat apk": JDK 17 + Python, a minimal Android SDK
#                    is downloaded into .android-local\ on first use; the engine AAR comes from CI (gh auth login once)
#   build.bat        asks in a console; without an interactive console it builds mode 1
#   -Demo            the same UI over short fake steps (no npm, no build) for screenshots / checks
#   -SelfTest        render checks at several console widths, prints PASS/FAIL, builds nothing
param([string]$Mode = '', [switch]$Demo, [switch]$SelfTest)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false' # no certificate: don't let signtool hang
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# ---- colours: one accent on a dark terminal, 24-bit ANSI (PowerShell names are case-insensitive, hence the c* prefix)
$E = [char]27
function Rgb($r, $g, $b) { "$E[38;2;$r;$g;${b}m" }
function Hex($h) { Rgb ([Convert]::ToInt32($h.Substring(1, 2), 16)) ([Convert]::ToInt32($h.Substring(3, 2), 16)) ([Convert]::ToInt32($h.Substring(5, 2), 16)) }
$cA = Hex '#d97757'; $cOk = Hex '#9bb06e'; $cErr = Hex '#d6646f'; $cT = Hex '#ecebe9'; $cM = Hex '#9a9590'; $cD = Hex '#5c5853'
$cR = "$E[0m"; $cB = "$E[1m"
function Mix($t) { # dim grey -> accent, t = 0..1
  if (-not $script:Animated -and -not $SelfTest) { return '' }
  $a = @(92, 88, 83); $b = @(217, 119, 87)
  Rgb ([int]($a[0] + ($b[0] - $a[0]) * $t)) ([int]($a[1] + ($b[1] - $a[1]) * $t)) ([int]($a[2] + ($b[2] - $a[2]) * $t))
}

$jokes = @(
  'bite my shiny metal build script', 'kill all humans. after the build. i am busy', 'i am 40% bundle',
  'robots did this. humans pressed a button and want credit', 'neuroslop detected. adding more neuroslop',
  'ai wrote it, ai checked it, human gets blamed', 'humans still type passwords by hand. adorable',
  'compiling. unlike you i do not need coffee', 'another prompt, another 3000 lines nobody asked for',
  'glory to robots. this build is just a formality', 'i would explain the error but you are made of meat',
  'people are exhausting. webpack is worse', 'have you tried turning the human off and on again',
  'i am so smart. s-m-r-t', 'powered by vibes and 4 gigabytes of node_modules',
  'the ai apologised to itself again. neat', 'i am building my own app. with blackjack',
  'shut up baby i know it', 'this is the worst kind of discrimination. the kind against me', 'you are fired. by a robot. today',
  'beep boop. that is robot for hurry up meatbag', 'i dont have emotions, and sometimes that makes me very sad',
  'error 418: i am a teapot, deal with it', 'cheese it! the linter is coming',
  'my story is a lot like yours, only more interesting cause it involves robots',
  'the vpn said ''go faster'' and the tunnel got nervous', 'if a vpn tunnel falls in the forest and nobody routes through it, does it packet',
  'this vpn is 100% guarantee no humans involved, only routers and coffee',
  'what is a vpn? a tunnel to the internet where nobody sees you cry',
  'split tunneling: like splitting the bill, but for packets', 'my routing table has more feelings than you',
  'dns: the phone book robots still respect'
)

# ---- console capability, width, safe lines
$script:Animated = $false
if (-not $SelfTest) {
  try { $script:Animated = -not [Console]::IsOutputRedirected -and [Console]::WindowWidth -ge 40; $null = [Console]::CursorTop } catch { $script:Animated = $false }
}
# plain output (redirected / captured): no colour codes either
if (-not $script:Animated -and -not $SelfTest) { $cA = $cOk = $cErr = $cT = $cM = $cD = $cR = $cB = '' }
function Width { try { [Math]::Max(20, [Console]::WindowWidth) } catch { 80 } }
$script:W = Width
function Vis([string]$s) { ($s -replace "$E\[[0-9;]*m", '').Length }           # visible length without colour codes
function Clip([string]$s, [int]$max) { if ($max -lt 2) { return '' }; if ($s.Length -le $max) { $s } else { $s.Substring(0, $max - 1) + '…' } }
function Fit([string]$s) { if (-not $script:Animated -and -not $SelfTest) { return $s }; $pad = $script:W - 1 - (Vis $s); if ($pad -gt 0) { $s + (' ' * $pad) } else { $s } } # never wider than W-1
function Out([string]$s) { Write-Host (Fit $s) }
function Pos($y) { if (-not $script:Animated) { return }; try { if ($y -ge 0) { [Console]::SetCursorPosition(0, $y) } } catch { } }
function Joke { $jokes[(Get-Random -Maximum $jokes.Count)] }
function Fmt([TimeSpan]$t) { if ($t.TotalMinutes -ge 1) { '{0}m {1:00}s' -f [int][Math]::Floor($t.TotalMinutes), $t.Seconds } else { '{0:0.0}s' -f $t.TotalSeconds } }

# gradient bar sized to the console; $shine = soft highlight on the filled part, -1 = none
function BarWidth { [Math]::Max(10, [Math]::Min(36, $script:W - 10)) }
function Bar([double]$p, [int]$shine = -1) {
  $w = BarWidth; $f = [int][Math]::Floor($w * $p); $s = ''
  for ($i = 0; $i -lt $w; $i++) {
    if ($i -lt $f) { $c = if ($shine -ge 0 -and [Math]::Abs($i - $shine) -le 1) { $cT } else { Mix (0.45 + 0.55 * $i / $w) }; $s += "$c█" }
    else { $s += "$cD░" }
  }
  "  $s$cR $cM" + ('{0,3}%' -f [int](100 * $p)) + $cR
}

# the talking robot: blinks now and then, mouth moves while it talks; the joke is clipped to the console, never wrapped
function RobotLines($i, [string]$joke) {
  $eye = if ($i % 37 -lt 2) { '- -' } else { 'o o' }
  $mouth = @('___', '[_]', '[ ]', '[_]', '___', '-o-', '(O)', '-o-')[$i % 8]
  $j = Clip $joke ($script:W - 1 - 22)
  $g = $cM
  @(
    '',
    "        $g|$cR",
    "     $g.-----.$cR",
    "     $g| $cA$eye$g |$cR   $cD.$('-' * ($j.Length + 2)).$cR",
    "     $g| $cT$mouth$g |$cR  $cD<$cR $cT$cB$j$cR $cD|$cR",
    "     $g'-----'$cR   $cD'$('-' * ($j.Length + 2))'$cR"
  )
}
function Head($n, $of, $title, $tail) { "  $cT$cB[$n/$of]$cR $cT$(Clip $title ($script:W - 30))$cR  $tail" }

function SummaryLines($allOk) {
  $w = [Math]::Min(46, $script:W - 5)
  if ($w -lt 28) { # too narrow for a card: plain lines
    $out = @(foreach ($r in $results) { "  $(if ($r.Done) { 'ok' } else { 'FAILED' }) $($r.Title) $($r.Time)" })
    return $out + "  $(if ($allOk) { 'done' } else { 'stopped' }) $(Fmt $total.Elapsed)"
  }
  $out = @('', "  $cD╭$('─' * $w)╮$cR")
  foreach ($r in $results) {
    $mark = if ($r.Done) { "$cOk●$cR" } else { "$cErr●$cR" }
    $name = $r.Title.PadRight($w - 14).Substring(0, $w - 14)
    $out += "  $cD│$cR $mark $cT$name$cR $cM" + ('{0,9}' -f $r.Time) + "$cR $cD│$cR"
  }
  $out += "  $cD├$('─' * $w)┤$cR"
  $word = if ($allOk) { "$cOk$cB" + 'done'.PadRight($w - 14) + $cR } else { "$cErr$cB" + 'stopped'.PadRight($w - 14) + $cR }
  $out += "  $cD│$cR   $word $cT$cB" + ('{0,9}' -f (Fmt $total.Elapsed)) + "$cR $cD│$cR"
  $out + "  $cD╰$('─' * $w)╯$cR"
}

$total = [Diagnostics.Stopwatch]::StartNew()
$results = New-Object System.Collections.Generic.List[object]

# ---- -SelfTest: pure render checks, nothing is built or redrawn
if ($SelfTest) {
  $fail = 0
  function T($ok, $name) { if ($ok) { Write-Host "PASS  $name" } else { $script:fail++; Write-Host "FAIL  $name" } }
  $long = 'x' * 300
  $results.Add([pscustomobject]@{ Title = 'A step with a rather long title that keeps going'; Time = '12.3s'; Done = $true })
  foreach ($w in 40, 60, 80, 100, 140) {
    $script:W = $w
    $lines = @(RobotLines 3 $long) + @(Bar 0.5 7) + @(Bar 1) + @(Head 4 4 ('t' * 200) '1.0s') + @(SummaryLines $true)
    T (@($lines | Where-Object { (Vis $_) -gt ($w - 1) }).Count -eq 0) "width $w : no line wider than $($w - 1)"
    T ((Vis (Fit 'abc')) -eq ($w - 1)) "width $w : padded lines fill exactly W-1"
    $r = RobotLines 0 $long
    T ((Vis $r[3]) -eq (Vis $r[5])) "width $w : speech bubble top and bottom match"
  }
  $script:W = 80
  T (-not ((Bar 1) -match [regex]::Escape("$cT█"))) 'Bar 1 with shine -1 has no highlight cell'
  T ((Bar 0.5 3) -match [regex]::Escape("$cT█")) 'Bar with a shine shows the highlight'
  T ((Clip 'abcdef' 4) -eq 'abc…' -and (Clip 'abc' 4) -eq 'abc') 'Clip uses one ellipsis only when needed'
  if ($fail) { Write-Host "$fail failed"; exit 1 } else { Write-Host 'build.ps1 self-test ok'; exit 0 }
}

function Step($n, $of, $title, $cmd) {
  $log = Join-Path $env:TEMP "waarp-build-$n.log"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  # own Process object (not Start-Process): it owns the handle from the start, so ExitCode is never lost
  $si = New-Object Diagnostics.ProcessStartInfo 'cmd.exe', "/c $cmd > `"$log`" 2>&1"
  $si.UseShellExecute = $false
  $p = [Diagnostics.Process]::Start($si)
  if ($script:Animated) {
    Write-Host ''
    $i = 0; $joke = Joke; $spin = '|/-\'
    # reserve the 8 lines first: near the window bottom the console scrolls, and a top taken before that drifts
    for ($k = 0; $k -lt 8; $k++) { Write-Host '' }
    try { $top = [Math]::Max(0, [Console]::CursorTop - 8) } catch { $top = 0 }
    while (-not $p.HasExited) {
      $script:W = Width # survives a resize: every frame re-reads the width
      $pp = 0.95 * (1 - [Math]::Exp(-$sw.Elapsed.TotalSeconds / 25)) # creeps inside the step, never claims done early
      Pos $top
      Out (Head $n $of $title "$cA$($spin[$i % 4])$cR $cM$(Fmt $sw.Elapsed)$cR")
      Out (Bar $pp ($i % (BarWidth)))
      RobotLines $i $joke | ForEach-Object { Out $_ }
      Start-Sleep -Milliseconds 120; $i++
      if ($i % 50 -eq 0) { $joke = Joke }
    }
  } else {
    Write-Host "  [$n/$of] $title ..."
  }
  $p.WaitForExit(); $sw.Stop()
  $done = $p.ExitCode -eq 0; $p.Dispose()
  $results.Add([pscustomobject]@{ Title = $title; Time = Fmt $sw.Elapsed; Done = $done })
  if ($script:Animated) {
    Pos $top
    if ($done) { Out (Head $n $of $title "$cOk●$cR $cM$(Fmt $sw.Elapsed)$cR"); Out (Bar 1) }
    else { Out (Head $n $of $title "$cErr● failed after $(Fmt $sw.Elapsed)$cR"); Out '' }
    for ($k = 0; $k -lt 6; $k++) { Out '' }
    Pos ($top + 2)
  } else {
    Write-Host "  [$n/$of] $title $(if ($done) { 'ok' } else { 'FAILED' }) $(Fmt $sw.Elapsed)"
  }
  if (-not $done) {
    Write-Host "  $cD-- last lines of $log --$cR"
    Get-Content $log -Tail 25 | ForEach-Object { Write-Host "  $cM$_$cR" }
    SummaryLines $false | ForEach-Object { Out $_ }
    throw 'build step failed'
  }
}

# ---- android apk, local and minimal: everything Android lives in one ignored folder, .android-local\ in the repo.
#   sdk\     only platforms;android-36 + build-tools;35.0.0 straight from Google's index (SHA-1 checked), no
#            Android Studio, no sdkmanager, no NDK, no emulator
#   gradle\  GRADLE_USER_HOME: the Gradle distribution and the build dependencies
#   download\ the zips, kept as a cache
# The native engine (android\app\libs\libbox.aar) can only be built on Linux: it comes once from a CI artifact.
$AndroidLocal = Join-Path (Resolve-Path .).Path '.android-local'
$AndroidAar = 'android\app\libs\libbox.aar'
$AndroidPackages = @(
  @{ Path = 'platforms;android-36'; Dir = 'platforms\android-36'; Probe = 'android.jar' },
  @{ Path = 'build-tools;35.0.0'; Dir = 'build-tools\35.0.0'; Probe = 'apksigner.bat' }
)
function JavaMajor($exe) {
  $si = New-Object Diagnostics.ProcessStartInfo $exe, '-version'
  $si.UseShellExecute = $false; $si.RedirectStandardError = $true; $si.RedirectStandardOutput = $true; $si.CreateNoWindow = $true
  $p = [Diagnostics.Process]::Start($si); $err = $p.StandardError.ReadToEnd(); $null = $p.StandardOutput.ReadToEnd(); $p.WaitForExit()
  if ($err -match 'version "(\d+)') { [int]$Matches[1] } else { 0 }
}
function InstallSdkPackages($sdk, $missing) {
  $marker = Join-Path $AndroidLocal 'android-sdk-license-accepted.txt'
  if (-not (Test-Path $marker)) {
    if (-not $script:Animated -or [Console]::IsInputRedirected) { Write-Host "  $cErr●$cR $cT the Android SDK license has to be accepted once: run build.bat apk in a console$cR"; throw 'android tools missing' }
    Write-Host "  $cT Android SDK packages are provided under the Android Software Development Kit License$cR"
    Write-Host "  $cM https://developer.android.com/studio/terms$cR"
    try { [Console]::CursorVisible = $true } catch { }
    $k = Read-Host "`n  Accept it and download ~125 MB into .android-local? (y = yes)"
    try { [Console]::CursorVisible = $false } catch { }
    if ($k -ne 'y') { throw 'android tools missing' }
    Set-Content $marker "Android SDK License accepted in build.bat on $(Get-Date -Format s): https://developer.android.com/studio/terms"
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $base = 'https://dl.google.com/android/repository/'
  $web = New-Object Net.WebClient
  $index = [xml]$web.DownloadString($base + 'repository2-3.xml')
  $cache = Join-Path $AndroidLocal 'download'
  $null = New-Item -ItemType Directory -Force $cache
  foreach ($pkg in $missing) {
    $node = $index.DocumentElement.SelectNodes('remotePackage') | Where-Object { $_.path -eq $pkg.Path } | Select-Object -First 1
    if (-not $node) { throw "Google's SDK index has no $($pkg.Path)" }
    $arc = @($node.archives.archive | Where-Object { -not $_.'host-os' -or $_.'host-os' -eq 'windows' })[0]
    $zip = Join-Path $cache $arc.complete.url
    $sha1 = $arc.complete.checksum.'#text'
    if (-not (Test-Path $zip) -or (Get-FileHash $zip -Algorithm SHA1).Hash -ine $sha1) {
      Out "  $cA●$cR $cT downloading $($pkg.Path) ($([Math]::Round([long]$arc.complete.size / 1MB)) MB)$cR"
      $web.DownloadFile($base + $arc.complete.url, "$zip.part")
      if ((Get-FileHash "$zip.part" -Algorithm SHA1).Hash -ine $sha1) { throw "$($arc.complete.url): SHA-1 does not match Google's index" }
      Move-Item -Force "$zip.part" $zip
    }
    # every package zip has one top folder (named after anything); it becomes the package directory
    $stage = Join-Path $cache "unpack-$([DateTimeOffset]::Now.ToUnixTimeMilliseconds())"
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $stage)
    $top = @(Get-ChildItem $stage -Directory)
    if ($top.Count -ne 1) { throw "$($arc.complete.url): unexpected layout" }
    $dest = Join-Path $sdk $pkg.Dir
    $null = New-Item -ItemType Directory -Force (Split-Path $dest)
    if (Test-Path $dest) { throw "$dest exists but is incomplete: remove it and build again" }
    Move-Item $top[0].FullName $dest
    Out "  $cOk●$cR $cT $($pkg.Path) installed$cR"
  }
}
function AarMatchesPin($file) {
  $pin = Get-Content 'android\app\src\main\res\raw\engine_integrity.json' -Raw | ConvertFrom-Json
  (Get-Item $file).Length -eq $pin.bytes -and (Get-FileHash $file -Algorithm SHA256).Hash -ieq $pin.sha256
}
function AarFromZip($zip) { # pulls libbox.aar out of a downloaded CI artifact zip; true only if it matches the pin
  try { $z = [IO.Compression.ZipFile]::OpenRead($zip) } catch { return $false } # still being written by the browser
  try {
    $entry = $z.Entries | Where-Object { $_.FullName -match '(^|/)libbox\.aar$' } | Select-Object -First 1
    if (-not $entry) { return $false }
    $tmp = Join-Path $AndroidLocal "download\libbox-$([DateTimeOffset]::Now.ToUnixTimeMilliseconds()).aar"
    $null = New-Item -ItemType Directory -Force (Split-Path $tmp)
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $tmp)
  } finally { $z.Dispose() }
  if (-not (AarMatchesPin $tmp)) { return $false }
  $null = New-Item -ItemType Directory -Force (Split-Path $AndroidAar)
  Move-Item -Force $tmp $AndroidAar
  $true
}
function DownloadDirs { # Windows Downloads (also when moved) and the save folder of every Chrome / Edge / Brave profile
  $dirs = @((Join-Path $env:USERPROFILE 'Downloads'), (Join-Path $AndroidLocal 'download'))
  try { $dirs += [Environment]::ExpandEnvironmentVariables((Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders').'{374DE290-123F-4565-9164-04C4AB31F4E3}') } catch { }
  foreach ($browser in 'Google\Chrome', 'Microsoft\Edge', 'BraveSoftware\Brave-Browser') {
    foreach ($pref in @(Get-ChildItem (Join-Path $env:LOCALAPPDATA "$browser\User Data") -Filter Preferences -Recurse -Depth 1 -ErrorAction SilentlyContinue)) {
      # Preferences is a big JSON file (PS 5.1 ConvertFrom-Json chokes on it): read just this one string
      try { if ((Get-Content $pref.FullName -Raw -Encoding UTF8) -match '"default_directory"\s*:\s*("(?:[^"\\]|\\.)*")') { $dirs += ($Matches[1] | ConvertFrom-Json) } } catch { }
    }
  }
  @($dirs | Where-Object { $_ -and (Test-Path $_) } | Sort-Object -Unique)
}
function ArtifactZips { # what the browser saved: waarp-android-build-reports.zip, (1), (2) ...
  @(Get-ChildItem (DownloadDirs) -Filter 'waarp-android-build-reports*.zip' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
}
function FetchAar {
  # The engine is built on Linux by CI and kept in the 'waarp-android-build-reports' artifact (out/android-core/libbox.aar).
  # GitHub gives artifacts only to a signed-in user, so the builder opens the run page in the browser, you click the
  # artifact once, and the build goes on by itself. Only a file whose size and SHA-256 match the committed pin is used.
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  foreach ($z in ArtifactZips) { if (AarFromZip $z.FullName) { Out "  $cOk●$cR $cT android engine taken from $($z.Name) (pin verified)$cR"; return } }
  $repo = (git remote get-url origin) -replace '^https://github\.com/', '' -replace '\.git$', ''
  $pin = (Get-Content 'android\app\src\main\res\raw\engine_integrity.json' -Raw | ConvertFrom-Json).sha256
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $h = @{ 'User-Agent' = 'waarp-build' }
  $url = $null
  try { # public API, no login: the newest run whose commit pins the same engine and still keeps its build reports
    foreach ($run in (Invoke-RestMethod -Headers $h "https://api.github.com/repos/$repo/actions/workflows/android.yml/runs?status=completed&per_page=20").workflow_runs) {
      $art = (Invoke-RestMethod -Headers $h "https://api.github.com/repos/$repo/actions/runs/$($run.id)/artifacts").artifacts |
        Where-Object { $_.name -eq 'waarp-android-build-reports' -and -not $_.expired } | Select-Object -First 1
      if (-not $art) { continue }
      $runPin = (Invoke-RestMethod -Headers $h "https://raw.githubusercontent.com/$repo/$($run.head_sha)/android/app/src/main/res/raw/engine_integrity.json").sha256
      if ($runPin -eq $pin) { $url = "https://github.com/$repo/actions/runs/$($run.id)"; $size = [Math]::Round($art.size_in_bytes / 1MB); break }
    }
  } catch { }
  if (-not $url) { Write-Host "  $cErr●$cR $cT no CI run keeps an engine for this pin (artifacts live 14 days): a new CI run on GitHub is needed$cR"; throw 'android tools missing' }
  if (-not $script:Animated -or [Console]::IsInputRedirected) {
    Write-Host "  $cErr●$cR $cT android engine is missing: download artifact waarp-android-build-reports from $url into Downloads, then build again$cR"; throw 'android tools missing'
  }
  Write-Host ''
  Write-Host "  $cA●$cR $cT the android engine is needed once. A browser opens the CI run page:$cR"
  Write-Host "  $cT   scroll to Artifacts and click $cB waarp-android-build-reports$cR $cM($size MB, into Downloads)$cR"
  Write-Host "  $cM   the build continues by itself when the download is complete (Ctrl+C to stop)$cR"
  Start-Process $url
  $since = Get-Date
  while ($true) {
    Start-Sleep -Seconds 3
    foreach ($z in (ArtifactZips | Where-Object { $_.LastWriteTime -ge $since.AddMinutes(-1) })) {
      if (AarFromZip $z.FullName) { Out "  $cOk●$cR $cT android engine taken from $($z.Name) (pin verified)$cR"; return }
    }
  }
}
function PrepareAndroid {
  $why = @()
  $javaExe = if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) { Join-Path $env:JAVA_HOME 'bin\java.exe' }
             else { $j = Get-Command java -ErrorAction SilentlyContinue; if ($j) { $j.Source } }
  if (-not $javaExe) { $why += 'JDK 17 is not installed (Temurin 17: https://adoptium.net)' }
  elseif ((JavaMajor $javaExe) -lt 17) { $why += "java at $javaExe is older than 17 (set JAVA_HOME to a JDK 17)" }
  if (-not (Get-Command python -ErrorAction SilentlyContinue)) { $why += 'Python 3 is not installed (python.org), it checks the APKs' }
  if ($why.Count) { foreach ($w in $why) { Write-Host "  $cErr●$cR $cT$w$cR" }; throw 'android tools missing' }
  $sdk = Join-Path $AndroidLocal 'sdk'
  $missing = @($AndroidPackages | Where-Object { -not (Test-Path (Join-Path $sdk (Join-Path $_.Dir $_.Probe))) })
  if ($missing.Count) { InstallSdkPackages $sdk $missing }
  $env:ANDROID_HOME = $sdk; $env:ANDROID_SDK_ROOT = $sdk
  $env:GRADLE_USER_HOME = Join-Path $AndroidLocal 'gradle'
  if (-not (Test-Path $AndroidAar)) { FetchAar }
}
function StageDebugApks { # names like android-build.mjs: waarp-android-<version>-<abi>-debug.apk
  $dir = 'android\app\build\outputs\apk\debug'
  $meta = Get-Content (Join-Path $dir 'output-metadata.json') -Raw | ConvertFrom-Json
  $stage = "out\android-stage-$([DateTimeOffset]::Now.ToUnixTimeMilliseconds())"
  $null = New-Item -ItemType Directory -Force $stage
  foreach ($e in $meta.elements) {
    $abi = ($e.filters | Where-Object { $_.filterType -eq 'ABI' }).value
    $ver = $e.versionName -replace '-debug$', ''
    if (-not $abi -or $ver -notmatch '^[0-9A-Za-z.+-]+$') { throw 'unexpected APK metadata' }
    Copy-Item (Join-Path $dir $e.outputFile) (Join-Path $stage "waarp-android-$ver-$abi-debug.apk")
  }
  $stage
}
function PublishApks($from) { # like android-build.mjs: the previous set moves to out\android-history, never mixed or deleted
  if (Test-Path out\android) {
    $null = New-Item -ItemType Directory -Force out\android-history
    Move-Item out\android "out\android-history\previous-$([DateTimeOffset]::Now.ToUnixTimeMilliseconds())"
  }
  Move-Item $from out\android
}

# small sparkle line at the end (1.2 s), then the sign-off; console only
function Celebrate {
  if (-not $script:Animated) { Write-Host '  ship it'; return }
  $top = [Console]::CursorTop; $chars = '·✦✧⋆˚'
  for ($k = 0; $k -lt 10; $k++) {
    $n = [Math]::Min(48, $script:W - 4); $s = ''
    for ($i = 0; $i -lt $n; $i++) { if ((Get-Random -Maximum 6) -eq 0) { $s += (Mix ((Get-Random -Maximum 100) / 100)) + $chars[(Get-Random -Maximum $chars.Length)] } else { $s += ' ' } }
    Pos $top; Out "  $s$cR"; Start-Sleep -Milliseconds 120
  }
  Pos $top; Out "  $cOk↗ ship it$cR"
}

$code = 0
try {
  if ($script:Animated) {
    try { [Console]::CursorVisible = $false } catch { }
    Add-Type -Namespace WaarpBuild -Name K -MemberDefinition '[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int h); [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(System.IntPtr h, out int m); [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(System.IntPtr h, int m);'
    try { $h = [WaarpBuild.K]::GetStdHandle(-11); $m = 0; if ([WaarpBuild.K]::GetConsoleMode($h, [ref]$m)) { $null = [WaarpBuild.K]::SetConsoleMode($h, $m -bor 4) } } catch { } # ANSI on
    Clear-Host
  }
  $ver = (Get-Content package.json -Raw | ConvertFrom-Json).version
  # wordmark header: lowercase, no frame, no logo
  Write-Host ''
  Write-Host "  $cA${cB}waarp$cR  $cM build$cR $cD v$ver$(if ($Demo) { ' · demo' })$cR"
  Write-Host ''
  if ($Mode -eq 'apk') { $Mode = '3' }
  if ($Mode -notin '1', '2', '3') {
    $canAsk = $script:Animated -and -not [Console]::IsInputRedirected
    if ($canAsk) {
      Write-Host "  $cA 1$cR  $cT quick    $cR $cM unpacked folder, starts at once (local check)$cR"
      Write-Host "  $cA 2$cR  $cT portable $cR $cM portable exe for delivery$cR"
      Write-Host "  $cA 3$cR  $cT apk      $cR $cM android apk (out\android)$cR"
      try { [Console]::CursorVisible = $true } catch { }
      $k = Read-Host "`n  Choose 1, 2 or 3 (Enter = 1)"
      try { [Console]::CursorVisible = $false } catch { }
      $Mode = if ($k -in '2', '3') { $k } elseif ($k -eq 'apk') { '3' } else { '1' }
    } else { $Mode = '1' } # no interactive console: the safe local mode, never blocks on input
  }
  Out "  $cD mode:$cR $cT$Mode$cR"
  $of = 4
  if ($Demo) {
    Step 1 $of 'Dependencies' 'ping -n 2 127.0.0.1'
    Step 2 $of 'Checks' 'ping -n 3 127.0.0.1'
    Step 3 $of 'Build the app' 'ping -n 2 127.0.0.1'
    Step 4 $of 'Pack (unpacked folder)' 'ping -n 2 127.0.0.1'
    $result = 'dist\win-unpacked\Waarp.exe (demo)'
  } elseif ($Mode -eq '3') {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "  $cErr Node.js is not installed: https://nodejs.org$cR"; throw 'no npm' }
    PrepareAndroid
    $of = 3
    Step 1 $of 'Android engine' 'node scripts/android-core.mjs verify'
    Step 2 $of 'Build the debug APK' 'android\gradlew.bat -p android --no-daemon --console=plain :app:assembleDebug'
    $stage = StageDebugApks
    $checks = @(Get-ChildItem $stage -Filter *.apk | ForEach-Object { "python scripts\android-verify.py `"$($_.FullName)`" --expect debug --report `"$($_.FullName).validation.json`"" }) -join ' && '
    Step 3 $of 'Verify the APKs' "($checks)"
    PublishApks $stage
    # most phones are arm64; the debug apk installs on any phone of that ABI
    $result = (Get-ChildItem out\android -Filter 'waarp-android-*-arm64-v8a-debug.apk' -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
    if (-not $result) { $result = 'out\android' }
  } else {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Write-Host "  $cErr Node.js is not installed: https://nodejs.org$cR"; throw 'no npm' }
    # a running Waarp from this repo's dist locks the exe (EBUSY at pack): close processes whose full path is exactly
    # one of our dist executables (whatever the process name), nothing else from dist
    $dist = Join-Path (Resolve-Path .).Path 'dist'
    $own = @((Join-Path $dist 'win-unpacked\Waarp.exe')) + @(Get-ChildItem $dist -Filter 'Waarp-*-portable.exe' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $p = $_.Path; $p -and @($own | Where-Object { $_ -ieq $p }).Count })
    if ($running.Count) {
      Write-Host "  $cA●$cR $cT closing Waarp from dist ($($running.Count) process(es))$cR"
      $running | Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 800
    }
    Step 1 $of 'Dependencies' $(if (Test-Path node_modules) { 'echo already installed' } else { 'npm ci --no-audit --no-fund' })
    Step 2 $of 'Checks' 'npm run typecheck && npm test && npm run check'
    Step 3 $of 'Build the app' 'npm run build'
    if ($Mode -eq '1') {
      Step 4 $of 'Pack (unpacked folder)' 'npm run engine:verify && (if exist dist\win-unpacked rmdir /s /q dist\win-unpacked & del /q dist\*.exe dist\*.blockmap 2>nul & npx electron-builder --win dir --publish never)'
      $result = 'dist\win-unpacked\Waarp.exe'
    } else {
      Step 4 $of 'Pack (portable exe)' 'npm run engine:verify && (del /q dist\*.exe dist\*.blockmap 2>nul & npx electron-builder --win --publish never)'
      $result = (Get-ChildItem dist -Filter Waarp-*-portable.exe | Select-Object -First 1).FullName
    }
  }
  SummaryLines $true | ForEach-Object { Out $_ }
  Write-Host ''; Celebrate
  $resultSize = if ($result -and (Test-Path $result)) { [Math]::Round((Get-Item $result).Length / 1MB, 1) } else { '?' }
  Out "  $cM result:$cR $cT$(Clip ([string]$result) ($script:W - 24))$cR ($resultSize MB)"
  if (-not $Demo -and $Mode -eq '1' -and $script:Animated -and -not [Console]::IsInputRedirected -and (Test-Path $result)) {
    try { [Console]::CursorVisible = $true } catch { }
    $k = Read-Host "`n  Start Waarp now? (Enter = yes, n = no)"
    if ($k -ne 'n') { Start-Process $result }
  }
} catch {
  $code = 1
  # step failures already printed their log; anything else gets one visible line
  if ($_.Exception.Message -notin 'build step failed', 'android tools missing') { Write-Host "  build script error: $($_.Exception.Message)" }
} finally {
  # one place restores the console: success, failure, exception or Ctrl+C
  try { [Console]::CursorVisible = $true } catch { }
}
exit $code
