$chrome = "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe"
if (!(Test-Path -LiteralPath $chrome)) {
  $chrome = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
}
if (!(Test-Path -LiteralPath $chrome)) {
  throw "Chrome executable not found."
}

$extensionPath = (Resolve-Path -LiteralPath "$PSScriptRoot\..").Path
$userDataDir = "C:\Users\yang0\AppData\Local\Google\Chrome\User Data"
$debugUrl = "http://127.0.0.1:9222/json/version"
$debugPortOpen = $false

try {
  Invoke-RestMethod -Uri $debugUrl -TimeoutSec 2 | Out-Null
  $debugPortOpen = $true
} catch {
  $debugPortOpen = $false
}

$arguments = @(
  "--remote-debugging-port=9222",
  "--user-data-dir=`"$userDataDir`"",
  "--profile-directory=`"Profile 3`"",
  "--load-extension=`"$extensionPath`"",
  "https://flow.google/"
) -join " "

Start-Process -FilePath $chrome -ArgumentList $arguments
