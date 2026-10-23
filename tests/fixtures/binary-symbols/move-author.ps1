param([string]$Root, [string]$Source, [string]$Destination)
$ErrorActionPreference = 'Stop'
$fixtureRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
$sourcePath = [System.IO.Path]::GetFullPath($Source)
$destinationPath = [System.IO.Path]::GetFullPath($Destination)
if (!$sourcePath.StartsWith($fixtureRoot, [System.StringComparison]::OrdinalIgnoreCase) -or !$destinationPath.StartsWith($fixtureRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw '作者目录和目标目录必须位于测试目录内。'
}
Move-Item -LiteralPath $sourcePath -Destination $destinationPath
