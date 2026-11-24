# Genera los íconos PNG de la PWA con System.Drawing (sin dependencias externas)
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot '..\public\icons'
New-Item -ItemType Directory -Force $out | Out-Null

function New-Icon([int]$size, [string]$name, [double]$pad, [bool]$round, [bool]$mono) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::Transparent)
  if ($mono) {
    $bg = [System.Drawing.Color]::Transparent
    $fg = [System.Drawing.Color]::White
  } else {
    $bg = [System.Drawing.Color]::FromArgb(255, 79, 70, 229)
    $fg = [System.Drawing.Color]::White
    $brush = New-Object System.Drawing.SolidBrush $bg
    if ($round) {
      $r = [int]($size * 0.22)
      $path = New-Object System.Drawing.Drawing2D.GraphicsPath
      $path.AddArc(0, 0, $r*2, $r*2, 180, 90)
      $path.AddArc($size-$r*2-1, 0, $r*2, $r*2, 270, 90)
      $path.AddArc($size-$r*2-1, $size-$r*2-1, $r*2, $r*2, 0, 90)
      $path.AddArc(0, $size-$r*2-1, $r*2, $r*2, 90, 90)
      $path.CloseFigure()
      $g.FillPath($brush, $path)
    } else {
      $g.FillRectangle($brush, 0, 0, $size, $size)
    }
  }
  # Calendario estilizado con palomita
  $inner = $size * (1 - 2*$pad)
  $x = $size * $pad; $y = $size * $pad
  $penW = [single]([Math]::Max(2, $inner * 0.07))
  $pen = New-Object System.Drawing.Pen $fg, $penW
  $pen.LineJoin = 'Round'; $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  $top = $y + $inner*0.12
  $g.DrawRectangle($pen, [single]$x, [single]$top, [single]$inner, [single]($inner*0.88))
  $fill = New-Object System.Drawing.SolidBrush $fg
  $g.FillRectangle($fill, [single]$x, [single]$top, [single]$inner, [single]($inner*0.2))
  $g.DrawLine($pen, [single]($x+$inner*0.28), [single]$y, [single]($x+$inner*0.28), [single]($top+$inner*0.1))
  $g.DrawLine($pen, [single]($x+$inner*0.72), [single]$y, [single]($x+$inner*0.72), [single]($top+$inner*0.1))
  $pts = @(
    (New-Object System.Drawing.PointF ([single]($x+$inner*0.27)), ([single]($top+$inner*0.55))),
    (New-Object System.Drawing.PointF ([single]($x+$inner*0.44)), ([single]($top+$inner*0.70))),
    (New-Object System.Drawing.PointF ([single]($x+$inner*0.74)), ([single]($top+$inner*0.38)))
  )
  $g.DrawLines($pen, $pts)
  $bmp.Save((Join-Path $out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

New-Icon 192 'icon-192.png' 0.2 $true $false
New-Icon 512 'icon-512.png' 0.2 $true $false
New-Icon 512 'maskable-512.png' 0.28 $false $false
New-Icon 180 'apple-touch-icon.png' 0.2 $false $false
New-Icon 72 'badge-72.png' 0.1 $false $true
Get-ChildItem $out | Select-Object Name, Length
