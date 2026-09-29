# 로컬 테스트용 서버 (Node 없이 실행). Vercel의 /api/chart 와 같은 동작을 흉내 낸다.
# 실행: powershell -ExecutionPolicy Bypass -File dev-server.ps1  →  http://localhost:8787
$port = 8787
$root = $PSScriptRoot
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Dev server: http://localhost:$port"

$types = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css'; '.json' = 'application/json'; '.svg' = 'image/svg+xml' }

function Send($res, $status, $type, [string]$text) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($text)
  $res.StatusCode = $status
  $res.ContentType = $type
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request; $res = $ctx.Response
  try {
    $path = $req.Url.AbsolutePath
    if ($path -eq '/api/chart') {
      $sym = ([string]$req.QueryString['symbol']).Trim().ToUpper()
      if ($sym -notmatch '^[A-Z0-9.\-^=]{1,15}$') {
        Send $res 400 'application/json' '{"error":"종목 코드 형식이 올바르지 않습니다."}'
      } else {
        $u = "https://query1.finance.yahoo.com/v8/finance/chart/$([uri]::EscapeDataString($sym))?range=2y&interval=1d&includePrePost=false"
        try {
          $r = Invoke-WebRequest -UseBasicParsing -Uri $u -UserAgent 'Mozilla/5.0'
          Send $res 200 'application/json; charset=utf-8' $r.Content
        } catch {
          $code = 0
          if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
          if ($code -eq 404) { Send $res 404 'application/json' "{`"error`":`"'$sym' 종목을 찾을 수 없습니다.`"}" }
          else { Send $res 502 'application/json' "{`"error`":`"시세 서버 오류 ($code)`"}" }
        }
      }
    } else {
      if ($path -eq '/') { $path = '/index.html' }
      $file = [IO.Path]::GetFullPath((Join-Path $root $path.TrimStart('/')))
      if ($file.StartsWith($root) -and (Test-Path $file -PathType Leaf)) {
        $ext = [IO.Path]::GetExtension($file)
        $type = if ($types[$ext]) { $types[$ext] } else { 'application/octet-stream' }
        Send $res 200 $type ([IO.File]::ReadAllText($file, [Text.Encoding]::UTF8))
      } else {
        Send $res 404 'text/plain' 'Not found'
      }
    }
  } catch {
    Write-Host $_
  } finally {
    $res.Close()
  }
}
