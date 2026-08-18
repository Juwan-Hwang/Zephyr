$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName   = 'zephyr'
  fileType      = 'exe'
  url           = 'https://github.com/Juwan-Hwang/Zephyr/releases/download/v2.4.3/Zephyr_2.4.3_x64-setup-full.exe'
  checksum      = '4dd63c922c4adba81736dd065d23dff391a8b58a74e4c3df99ad6a8c475dfb1d'
  checksumType  = 'sha256'
  url64bit      = 'https://github.com/Juwan-Hwang/Zephyr/releases/download/v2.4.3/Zephyr_2.4.3_x64-setup-full.exe'
  checksum64    = '4dd63c922c4adba81736dd065d23dff391a8b58a74e4c3df99ad6a8c475dfb1d'
  checksumType64= 'sha256'
  silentArgs    = '/S'
  validExitCodes= @(0)
}

Install-ChocolateyPackage @packageArgs
