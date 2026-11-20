$demoSession = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../.local-data/demo-session.json') -Raw | ConvertFrom-Json
$demoHeaders = @{ Authorization = "Bearer $($demoSession.token)"; 'X-Organisation-ID' = $demoSession.organisationId }
Write-Output 'Current user and organisation:'
Invoke-RestMethod "$($demoSession.baseUrl)/api/v1/me" -Headers $demoHeaders | ConvertTo-Json -Depth 12
Write-Output 'Tickets:'
Invoke-RestMethod "$($demoSession.baseUrl)/api/v1/tickets" -Headers $demoHeaders | ConvertTo-Json -Depth 12
Write-Output 'Saved AI classification and summary:'
Invoke-RestMethod "$($demoSession.baseUrl)/api/v1/tickets/$($demoSession.ticketId)/analyses" -Headers $demoHeaders | ConvertTo-Json -Depth 12
Write-Output 'SLA evaluations:'
Invoke-RestMethod "$($demoSession.baseUrl)/api/v1/sla/evaluations" -Headers $demoHeaders | ConvertTo-Json -Depth 12
Write-Output 'Draft priority preview (demo returns missing information, not an invented priority):'
Invoke-RestMethod "$($demoSession.baseUrl)/api/v1/tickets/$($demoSession.ticketId)/recommend-priority" -Method Post -ContentType 'application/json' -Body '{}' -Headers $demoHeaders | ConvertTo-Json -Depth 12
