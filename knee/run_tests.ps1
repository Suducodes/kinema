# Run every knee test with the OpenSim JAM forsim tool, 4 at a time.
#   powershell -File knee\run_tests.ps1
$K = 'C:\Users\Sudarshan\claude_code\kinema\knee'
$J = "$K\vendor\opensim-jam\opensim-jam-release"
$env:PATH = "$J\bin\win;$J\opensim\win;$env:PATH"
$runs = Get-ChildItem "$K\runs" -Directory | Where-Object { Test-Path "$($_.FullName)\inputs\forsim_settings.xml" } |
    Where-Object { $_.Name -ne 'anterior_laxity' -and -not (Get-ChildItem "$($_.FullName)\results" -Filter '*_states.sto' -ErrorAction SilentlyContinue) }
$jobs = @()
foreach ($r in $runs) {
    while (($jobs | Where-Object { -not $_.HasExited }).Count -ge 4) { Start-Sleep -Seconds 5 }
    "start $($r.Name) $(Get-Date -f HH:mm:ss)"
    $jobs += Start-Process -FilePath "$J\bin\win\forsim.exe" -ArgumentList "`"$J\bin\win\jam_plugin.dll`" .\forsim_settings.xml" `
        -WorkingDirectory "$($r.FullName)\inputs" -RedirectStandardOutput "$($r.FullName)\results\forsim.log" `
        -RedirectStandardError "$($r.FullName)\results\forsim.err" -NoNewWindow -PassThru
}
$jobs | ForEach-Object { $_.WaitForExit() }
foreach ($r in $runs) { "done $($r.Name): " + ((Get-ChildItem "$($r.FullName)\results" -Filter '*_states.sto').Count -gt 0) }
"ALL TESTS DONE $(Get-Date -f HH:mm:ss)"
