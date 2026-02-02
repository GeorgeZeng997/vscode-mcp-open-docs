$body = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
$header = "Content-Length: " + ([Text.Encoding]::UTF8.GetByteCount($body)) + "`r`n`r`n"
$bytes = [Text.Encoding]::UTF8.GetBytes($header + $body)
[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
