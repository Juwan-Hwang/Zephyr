$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName = 'zephyr'
  fileType    = 'exe'
  silentArgs  = '/S'
  validExitCodes = @(0)
}

Uninstall-ChocolateyPackage @packageArgs
