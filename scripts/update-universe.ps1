# 위키백과 S&P 500 구성 종목 표를 읽어 lib/universe.js 를 다시 만든다.
# 실행: powershell -ExecutionPolicy Bypass -File scripts\update-universe.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web
$root = Split-Path $PSScriptRoot -Parent
$html = (Invoke-WebRequest -UseBasicParsing 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies' -UserAgent 'Mozilla/5.0').Content

$start = $html.IndexOf('id="constituents"')
if ($start -lt 0) { throw '구성 종목 표(#constituents)를 찾지 못했습니다.' }
$table = $html.Substring($start, $html.IndexOf('</table>', $start) - $start)

$clean = { param($s) [System.Web.HttpUtility]::HtmlDecode(($s -replace '<[^>]+>', '')).Trim() }
$rows = @()
foreach ($tr in [regex]::Matches($table, '<tr[\s\S]*?</tr>')) {
  $cells = [regex]::Matches($tr.Value, '<td[^>]*>([\s\S]*?)</td>') | ForEach-Object { & $clean $_.Groups[1].Value }
  if ($cells.Count -lt 3) { continue }
  $sym = $cells[0] -replace '\.', '-'          # Yahoo 표기: BRK.B → BRK-B
  $rows += ,@($sym, $cells[1], $cells[2])
}
if ($rows.Count -lt 480) { throw "종목 수가 너무 적습니다 ($($rows.Count)). 표 구조가 바뀌었을 수 있습니다." }

$lines = $rows | ForEach-Object { '    ' + (ConvertTo-Json -Compress -InputObject @($_[0], $_[1], $_[2])) + ',' }
$today = Get-Date -Format 'yyyy-MM-dd'
$js = @"
// S&P 500 구성 종목 [티커, 회사명, GICS 섹터] — scripts/update-universe.ps1 로 생성 ($today, 위키백과 기준)
(function (root) {
  const UNIVERSE = [
$($lines -join "`n")
  ];
  if (typeof module !== 'undefined' && module.exports) module.exports = UNIVERSE;
  else root.UNIVERSE = UNIVERSE;
})(this);
"@
[IO.File]::WriteAllText((Join-Path $root 'lib\universe.js'), $js, (New-Object Text.UTF8Encoding $false))
Write-Host "lib/universe.js: $($rows.Count) 종목"
