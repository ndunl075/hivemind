# Hivemind setup window for Windows. hivemind-setup.exe opens this instead of a terminal.
# It copies the bundled Node to a permanent place, then runs `hivemind join` (invite code passed on standard input,
# never on the command line) and `hivemind doctor`, and shows the self-test prompt with a Copy button.
# Headless use, for tests: -Project <folder> -Server <url> -TokenFile <file> -NoGui
param(
  [string]$Project,
  [string]$Server,
  [string]$TokenFile,
  [switch]$NoGui
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$bundledNode = Join-Path $here 'node\node.exe'
$cli = Join-Path $here 'app\cli\hivemind.mjs'
$gui = -not $NoGui

# Hooks are registered with the path of the Node that runs setup, so it must live outside this folder.
function Copy-Runtime {
  $home_ = if ($env:HIVEMIND_HOME) { $env:HIVEMIND_HOME } else { Join-Path $env:USERPROFILE '.hivemind' }
  $rt = Join-Path $home_ 'runtime'
  $dest = Join-Path $rt 'node.exe'
  New-Item -ItemType Directory -Force -Path $rt | Out-Null
  $same = (Test-Path -LiteralPath $dest) -and
    ((Get-FileHash -LiteralPath $dest).Hash -eq (Get-FileHash -LiteralPath $bundledNode).Hash)
  if (-not $same) {
    $tmp = "$dest.new"
    Copy-Item -LiteralPath $bundledNode -Destination $tmp -Force
    try { Move-Item -LiteralPath $tmp -Destination $dest -Force }
    catch {
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      throw "Could not replace $dest because it is in use. Close Claude Code and Codex, then try again."
    }
  }
  # The 8.3 short path has only plain characters; hook wrappers are read by cmd.exe in the OEM code page.
  try { return (New-Object -ComObject Scripting.FileSystemObject).GetFile($dest).ShortPath } catch { return $dest }
}

# Windows command-line quoting: double the backslashes that end up before a quote, then escape the quote.
function Format-Arg([string]$a) {
  $q = [regex]::Replace($a, '(\\*)"', { param($m) $m.Groups[1].Value * 2 + '\"' })
  $q = [regex]::Replace($q, '(\\+)$', { param($m) $m.Groups[1].Value * 2 })
  return '"' + $q + '"'
}

# Runs the CLI in the project folder. Keeps the window responsive while it waits, and gives up after 3 minutes.
function Invoke-Cli([string]$node, [string[]]$cliArgs, [string]$folder, [string]$stdinText) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $psi.Arguments = (@($cli) + $cliArgs | ForEach-Object { Format-Arg $_ }) -join ' '
  $psi.WorkingDirectory = $folder
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEndAsync()
  $err = $p.StandardError.ReadToEndAsync()
  if ($stdinText) { $p.StandardInput.WriteLine($stdinText) }
  $p.StandardInput.Close()
  $deadline = (Get-Date).AddMinutes(3)
  while (-not $p.WaitForExit(100)) {
    if ($gui) { [System.Windows.Forms.Application]::DoEvents() }
    if ((Get-Date) -gt $deadline) {
      try { $p.Kill() } catch { }
      throw 'Setup is taking too long. Check your internet connection and try again.'
    }
  }
  $p.WaitForExit()
  # Node's own deprecation notices are noise for the person reading this.
  $errText = ($err.Result -split "`r?`n" | Where-Object { $_ -notmatch 'DeprecationWarning|--trace-deprecation' }) -join "`n"
  return @{ Code = $p.ExitCode; Out = $out.Result.Trim(); Err = $errText.Trim() }
}

# The whole setup. $report is called with short progress lines. Returns the self-test prompt and any problems.
function Invoke-Setup([string]$folder, [string]$url, [string]$token, [scriptblock]$report) {
  if (-not $folder -or -not (Test-Path -LiteralPath $folder -PathType Container)) { throw 'Choose your project folder.' }
  if (-not $url) { throw 'Enter the server address you were given.' }
  if (-not $token) { throw 'Paste the invite code you were given.' }
  & $report 'Installing Hivemind...'
  $node = Copy-Runtime
  & $report 'Joining your team...'
  $join = Invoke-Cli $node @('join', '--server', $url, '--token-stdin', '--yes') $folder $token
  if ($join.Code -ne 0) { throw ((@($join.Err, $join.Out) -join "`n").Trim() -replace '(?m)^hivemind: ', '') }
  & $report 'Checking the setup...'
  $doctor = Invoke-Cli $node @('doctor') $folder $null
  $m = [regex]::Match($doctor.Out, '(?s)Hivemind self-test\..*?HIVEMIND-OK\.')
  if (-not $m.Success) { throw "Setup finished, but the check did not print a self-test:`n$($doctor.Out)" }
  $problems = @()
  $problems += $join.Err -split "`n" | Where-Object { $_ -match '^warning:' } | ForEach-Object { $_ -replace '^warning:\s*', '' }
  # Only real failures: doctor's "warn" lines include notes that are expected right after setup.
  $problems += $doctor.Out -split "`r?`n" | Where-Object { $_ -match '^FAIL\s' } | ForEach-Object { ($_ -replace '^FAIL\s+', '').Trim() }
  return @{ Prompt = $m.Value; Problems = @($problems | Where-Object { $_ }) }
}

if ($NoGui) {
  try {
    $token = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
    $r = Invoke-Setup $Project $Server $token { param($s) Write-Host $s }
    Write-Output 'DONE'
    foreach ($p in $r.Problems) { Write-Output "PROBLEM: $p" }
    Write-Output $r.Prompt
    exit 0
  } catch {
    Write-Output "FAILED: $($_.Exception.Message)"
    exit 1
  }
}

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
try {
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $font = New-Object System.Drawing.Font('Segoe UI', 10)
  $bold = New-Object System.Drawing.Font('Segoe UI Semibold', 15)

  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'Hivemind Setup'
  $form.ClientSize = New-Object System.Drawing.Size(520, 520)
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.StartPosition = 'CenterScreen'
  $form.Font = $font
  $form.BackColor = [System.Drawing.Color]::FromArgb(20, 23, 47)
  $form.ForeColor = [System.Drawing.Color]::White

  function Add-Label([string]$text, [int]$y, $f = $font) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $text; $l.Font = $f; $l.AutoSize = $true
    $l.Location = New-Object System.Drawing.Point(28, $y)
    $form.Controls.Add($l); return $l
  }
  function Add-Box([int]$y, [int]$width = 464) {
    $b = New-Object System.Windows.Forms.TextBox
    $b.Location = New-Object System.Drawing.Point(28, $y)
    $b.Size = New-Object System.Drawing.Size($width, 28)
    $form.Controls.Add($b); return $b
  }
  function New-Button([string]$text, [int]$x, [int]$y, [int]$w) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text; $b.Location = New-Object System.Drawing.Point($x, $y); $b.Size = New-Object System.Drawing.Size($w, 34)
    $b.FlatStyle = 'Flat'; $b.FlatAppearance.BorderSize = 0
    $b.BackColor = [System.Drawing.Color]::FromArgb(112, 94, 236); $b.ForeColor = [System.Drawing.Color]::White
    $form.Controls.Add($b); return $b
  }

  Add-Label 'Set up Hivemind' 22 $bold | Out-Null
  Add-Label 'Your agents will check in with your team as they work.' 60 | Out-Null

  Add-Label 'Project folder' 100 | Out-Null
  $folderBox = Add-Box 124 360
  $browse = New-Button 'Browse...' 398 122 94
  $browse.Add_Click({
    $d = New-Object System.Windows.Forms.FolderBrowserDialog
    $d.Description = 'Choose the project folder your agents work in'
    if ($d.ShowDialog() -eq 'OK') { $folderBox.Text = $d.SelectedPath }
  })

  Add-Label 'Server address' 166 | Out-Null
  $serverBox = Add-Box 190

  Add-Label 'Invite code' 232 | Out-Null
  $tokenBox = Add-Box 256
  $tokenBox.UseSystemPasswordChar = $true

  $go = New-Button 'Set up' 28 302 120

  $status = New-Object System.Windows.Forms.Label
  $status.AutoSize = $false
  $status.Location = New-Object System.Drawing.Point(28, 346)
  $status.Size = New-Object System.Drawing.Size(464, 40)
  $form.Controls.Add($status)

  $result = New-Object System.Windows.Forms.TextBox
  $result.Multiline = $true; $result.ReadOnly = $true; $result.ScrollBars = 'Vertical'
  $result.Location = New-Object System.Drawing.Point(28, 390); $result.Size = New-Object System.Drawing.Size(464, 80)
  $result.Visible = $false
  $form.Controls.Add($result)
  $copy = New-Button 'Copy self-test' 28 478 140
  $copy.Visible = $false
  $script:prompt = ''
  $copy.Add_Click({
    try { [System.Windows.Forms.Clipboard]::SetText($script:prompt); $status.Text = 'Copied. Paste it into a new Claude Code or Codex session in your project.' }
    catch { $status.Text = 'Could not copy. Select the text above and press Ctrl+C.' }
  })

  if ($Project) { $folderBox.Text = $Project }
  if ($Server) { $serverBox.Text = $Server }

  $go.Add_Click({
    foreach ($c in @($go, $browse, $folderBox, $serverBox, $tokenBox)) { $c.Enabled = $false }
    $result.Visible = $false; $copy.Visible = $false
    $report = { param($s) $status.Text = $s; $form.Refresh() }
    try {
      $r = Invoke-Setup $folderBox.Text.Trim() $serverBox.Text.Trim() $tokenBox.Text.Trim() $report
      $script:prompt = $r.Prompt -replace "`r?`n", "`r`n"
      if ($r.Problems.Count) {
        $status.Text = "You're mostly set up, but some things need attention. Fix them, then paste the self-test into a new session:"
        $result.Text = (($r.Problems -join "`r`n") + "`r`n`r`n" + $script:prompt)
      } else {
        $status.Text = "You're set up. Paste this into a new Claude Code or Codex session in your project to check:"
        $result.Text = $script:prompt
      }
      $result.Visible = $true; $copy.Visible = $true
      $tokenBox.Text = ''
      $go.Enabled = $true; $go.Text = 'Run again'
    } catch {
      $status.Text = 'Setup did not finish:'
      $result.Text = $_.Exception.Message -replace "`r?`n", "`r`n"
      $result.Visible = $true
      foreach ($c in @($go, $browse, $folderBox, $serverBox, $tokenBox)) { $c.Enabled = $true }
    }
  })

  [void]$form.ShowDialog()
} catch {
  [void][System.Windows.Forms.MessageBox]::Show("Hivemind Setup could not open: $($_.Exception.Message)", 'Hivemind Setup')
  exit 1
}
