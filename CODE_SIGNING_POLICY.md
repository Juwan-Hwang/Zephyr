# Code Signing Policy

## Signing provider

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

## Roles

Zephyr is maintained by [Juwan Hwang](https://github.com/Juwan-Hwang), who acts as author, reviewer, and approver. Every release signing request is approved manually before the certificate is applied. Contributions arrive as pull requests and are reviewed before merge.

## What gets signed

Only the official Windows release artifacts are signed:

- NSIS installer (`Zephyr_*_windows-x86_64-setup-full.exe`, `Zephyr_*_windows-aarch64-setup-full.exe`, `Zephyr_*_windows-x86_64-setup-lite.exe`, `Zephyr_*_windows-aarch64-setup-lite.exe`)
- MSI package (`Zephyr_*_windows-x86_64*-full.msi`, `Zephyr_*_windows-aarch64*-full.msi`, `Zephyr_*_windows-x86_64*-lite.msi`, `Zephyr_*_windows-aarch64*-lite.msi`)

Artifacts are built by GitHub Actions directly from the source in this repository and submitted to SignPath from that workflow only.

## Privacy

This program connects only to the services listed in the [privacy policy](PRIVACY.md), for the purposes described there. It has no accounts, collects no usage statistics, and has no server of its own.

## Verifying a download

On Windows, check the signature with PowerShell:

```powershell
Get-ChildItem .\Zephyr_*.exe, .\Zephyr_*.msi -File -ErrorAction SilentlyContinue | Get-AuthenticodeSignature
```

The status must be **Valid** and the signer **SignPath Foundation**. You can also right-click the file → Properties → Digital Signatures.

## Source

Zephyr is open source under the MIT license. The build and signing workflow lives in `.github/workflows/release.yml`.
