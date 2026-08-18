# Zephyr Multi-Platform Packaging Matrix

This directory contains production-ready manifests, build recipes, and automated CI workflows for distributing **Zephyr** across platforms and package managers.

---

## 1. AUR (Arch User Repository) — Active ✅
* **Package**: `zephyr-clash-bin`
* **Install Command**: `yay -S zephyr-clash-bin` or `paru -S zephyr-clash-bin`
* **Automation Workflow**: [`.github/workflows/update-aur.yml`](file:///c:/Users/Juwan/Desktop/Zephyr/.github/workflows/update-aur.yml)

---

## 2. Homebrew Tap (macOS & Linux)
* **Target Audience**: macOS & Linux developers using Homebrew.
* **Install Command**: `brew install juwan-hwang/tap/zephyr`
* **Artifacts**:
  - Formula: [`packaging/homebrew/Formula/zephyr.rb`](file:///c:/Users/Juwan/Desktop/Zephyr/packaging/homebrew/Formula/zephyr.rb)
  - Automation Workflow: [`.github/workflows/update-homebrew.yml`](file:///c:/Users/Juwan/Desktop/Zephyr/.github/workflows/update-homebrew.yml)
* **Setup**:
  1. Create a public repository named `homebrew-tap` under your GitHub account (`https://github.com/Juwan-Hwang/homebrew-tap`).
  2. Push the `Formula/zephyr.rb` file to it.
  3. `.github/workflows/update-homebrew.yml` will automatically update the formula with new SHA256 hashes on every release.

---

## 3. Scoop (Windows)
* **Target Audience**: Windows developers using Scoop.
* **Install Command**:
  ```powershell
  scoop bucket add zephyr https://github.com/Juwan-Hwang/scoop-bucket
  scoop install zephyr
  ```
* **Artifacts**:
  - Manifest: [`packaging/scoop/zephyr.json`](file:///c:/Users/Juwan/Desktop/Zephyr/packaging/scoop/zephyr.json)
  - Automation Workflow: [`.github/workflows/update-scoop.yml`](file:///c:/Users/Juwan/Desktop/Zephyr/.github/workflows/update-scoop.yml)

---

## 4. Microsoft Winget (Windows)
* **Target Audience**: Windows 10/11 users using `winget`.
* **Install Command**: `winget install Juwan.Zephyr`
* **Artifacts**:
  - Manifests: `packaging/winget/manifests/j/Juwan/Zephyr/2.4.3/`
  - Automation Workflow: [`.github/workflows/update-winget.yml`](file:///c:/Users/Juwan/Desktop/Zephyr/.github/workflows/update-winget.yml)

---

## 5. Snapcraft (Ubuntu Snap Store)
* **Target Audience**: Ubuntu and Snap-enabled Linux desktops.
* **Install Command**: `sudo snap install zephyr`
* **Artifacts**:
  - Manifest: [`packaging/snap/snapcraft.yaml`](file:///c:/Users/Juwan/Desktop/Zephyr/packaging/snap/snapcraft.yaml)

---

## 6. Fedora COPR & openSUSE (RPM)
* **Target Audience**: Fedora, RHEL, CentOS Stream, openSUSE.
* **Install Command**:
  ```bash
  sudo dnf copr enable juwan/zephyr
  sudo dnf install zephyr
  ```
* **Artifacts**:
  - RPM Spec: [`packaging/copr/zephyr.spec`](file:///c:/Users/Juwan/Desktop/Zephyr/packaging/copr/zephyr.spec)
