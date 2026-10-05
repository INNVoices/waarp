# waarp build: a compact build UI with a talking robot, a live progress bar and a summary card.
# Animated only in a real console with cursor control; redirected / captured output gets plain lines (no redraw spam).
#   build.bat 1      app + unpacked folder (dist\win-unpacked\Waarp.exe): fast, local checks
#   build.bat 2      app + portable exe (dist\Waarp-<version>-portable.exe): ready for delivery
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
  if ($Mode -notin '1', '2') {
    $canAsk = $script:Animated -and -not [Console]::IsInputRedirected
    if ($canAsk) {
      Write-Host "  $cA 1$cR  $cT quick    $cR $cM unpacked folder, starts at once (local check)$cR"
      Write-Host "  $cA 2$cR  $cT portable $cR $cM portable exe for delivery$cR"
      try { [Console]::CursorVisible = $true } catch { }
      $k = Read-Host "`n  Choose 1 or 2 (Enter = 1)"
      try { [Console]::CursorVisible = $false } catch { }
      $Mode = if ($k -eq '2') { '2' } else { '1' }
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
  if ($_.Exception.Message -ne 'build step failed') { Write-Host "  build script error: $($_.Exception.Message)" }
} finally {
  # one place restores the console: success, failure, exception or Ctrl+C
  try { [Console]::CursorVisible = $true } catch { }
}
exit $code
