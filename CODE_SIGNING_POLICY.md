# Code Signing Policy

## Signing provider

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

## Roles

Zephyr is maintained by [Juwan Hwang](https://github.com/Juwan-Hwang), who acts as author, reviewer, and approver. Every release signing request is approved manually before the certificate is applied. Contributions arrive as pull requests and are reviewed before merge.

## What gets signed

Only the official Windows release artifacts are signed:

- NSIS installer (`Zephyr_*_x64-setup-full.exe`, `Zephyr_*_arm64-setup-full.exe`, `Zephyr_*_x64-setup-lite.exe`, `Zephyr_*_arm64-setup-lite.exe`)
- MSI package (`Zephyr_*_x64-full.msi`, `Zephyr_*_arm64-full.msi`, `Zephyr_*_x64-lite.msi`, `Zephyr_*_arm64-lite.msi`)

Artifacts are built by GitHub Actions directly from the source in this repository and submitted to SignPath from that workflow only.

## Privacy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

## Verifying a download

On Windows, check the signature with PowerShell:

```powershell
Get-AuthenticodeSignature .\Zephyr_*_setup-*.exe
```

The status must be **Valid** and the signer **SignPath Foundation**. You can also right-click the file → Properties → Digital Signatures.

## Source

Zephyr is open source under the MIT license. The build and signing workflow lives in `.github/workflows/release.yml`.
