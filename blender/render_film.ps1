# Full film rebuild from the final runs: export -> build scene -> GPU render -> encode.
#   powershell -File blender\render_film.ps1
$ErrorActionPreference = 'Stop'
$K = 'C:\Users\Sudarshan\claude_code\kinema'
$e = 'C:\Users\Sudarshan\miniconda3\envs\kinema'
$B = 'C:\Program Files\Blender Foundation\Blender 5.1\blender.exe'
$env:PATH = "$e;$e\Library\bin;$env:PATH"
$R = "$K\blender\renders\v3"
New-Item -ItemType Directory -Force $R | Out-Null

"[1/5] export anim $(Get-Date -f HH:mm)"
& "$e\python.exe" "$K\sim\export_anim.py" sb_h_fix sb_w_fix --fps 120 --seconds 8
if ($LASTEXITCODE) { throw 'export failed' }

"[2/5] build scene $(Get-Date -f HH:mm)"
$dump = "import bpy, json; bpy.ops.wm.save_mainfile(); json.dump({l: {'slowmo_frames': list(bpy.data.objects['Camera_Ankle_' + l]['slowmo_frames']), 'toe_off_frame': int(bpy.data.objects['Camera_Ankle_' + l]['toe_off_frame'])} for l in ('Healthy', 'WeakCalves')}, open(r'$R\shots.json', 'w'))"
& $B -b "$K\blender\twin_walkers.blend" --python "$K\blender\build_twins.py" --python-expr $dump
if ($LASTEXITCODE) { throw 'build failed' }
$shots = Get-Content "$R\shots.json" -Raw | ConvertFrom-Json
"shots: $($shots | ConvertTo-Json -Compress)"

"[3/5] wide shot $(Get-Date -f HH:mm)"
& $B -b "$K\blender\twin_walkers.blend" --python "$K\blender\render_anim.py" -- Camera_Main 1 960 4 1920 1080 "$R\wide" | Select-String 'Saved|Error'
foreach ($l in 'Healthy', 'WeakCalves') {
    $f = $shots.$l.slowmo_frames
    $dir = if ($l -eq 'Healthy') { 'ankle_healthy' } else { 'ankle_weak' }
    "[4/5] ankle $l frames $($f[0])-$($f[1]) $(Get-Date -f HH:mm)"
    & $B -b "$K\blender\twin_walkers.blend" --python "$K\blender\render_anim.py" -- "Camera_Ankle_$l" $f[0] $f[1] 1 960 1080 "$R\$dir" | Select-String 'Error'
}

"[5/5] encode $(Get-Date -f HH:mm)"
& $B -b --factory-startup --python "$K\blender\encode_v2.py" | Select-String 'encoded|Error'
"FILM DONE $(Get-Date -f HH:mm)"
