# Zephyr Multi-Platform Linux Distribution Matrix

This directory contains production-ready manifests, build recipes, and automated CI workflows for distributing **Zephyr** across the entire Linux ecosystem.

---

## 1. Flathub (Flatpak) — Universal Linux App Store
* **Target Audience**: All Linux distributions (Ubuntu, Fedora, Arch Linux, SteamOS, Debian, Linux Mint, openSUSE, Pop!_OS).
* **Install Command**: `flatpak install flathub io.github.juwan_hwang.Zephyr`
* **Artifacts**:
  - Manifest: [`packaging/flathub/io.github.juwan_hwang.Zephyr.yml`](file:///c:/Users/Juwan/Desktop/Zephyr/packaging/flathub/io.github.juwan_hwang.Zephyr.yml)
  - AppStream Metadata: [`packaging/flathub/io.github.juwan_hwang.Zephyr.metainfo.xml`](file:///c:/Users/Juwan/Desktop/Zephyr/packaging/flathub/io.github.juwan_hwang.Zephyr.metainfo.xml)
* **Submission Workflow**:
  1. Fork [https://github.com/flathub/flathub](https://github.com/flathub/flathub).
  2. Create branch `add-io.github.juwan_hwang.Zephyr` and copy both files from `packaging/flathub/`.
  3. Open a Pull Request to Flathub.
  4. Flathub bot will run automatic build verification and publish to Flathub.

---

## 2. Homebrew Tap (Linuxbrew & macOS)
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

## 3. Snapcraft (Ubuntu Snap Store)
* **Target Audience**: Ubuntu and Snap-enabled Linux desktops.
* **Install Command**: `sudo snap install zephyr`
* **Artifacts**:
  - Manifest: [`packaging/snap/snapcraft.yaml`](file:///c:/Users/Juwan/Desktop/Zephyr/packaging/snap/snapcraft.yaml)
* **Setup**:
  1. Register `zephyr` package on [snapcraft.io](https://snapcraft.io).
  2. Export login credentials via `snapcraft export-login --snaps=zephyr snapcraft.login`.
  3. Add `SNAPCRAFT_STORE_CREDENTIALS` to GitHub Repository Secrets.

---

## 4. Fedora COPR & openSUSE (RPM)
* **Target Audience**: Fedora, RHEL, CentOS Stream, openSUSE.
* **Install Command**:
  ```bash
  sudo dnf copr enable juwan/zephyr
  sudo dnf install zephyr
  ```
* **Artifacts**:
  - RPM Spec: [`packaging/copr/zephyr.spec`](file:///c:/Users/Juwan/Desktop/Zephyr/packaging/copr/zephyr.spec)

---

## 5. AUR (Arch User Repository) — Already Active ✅
* **Package**: `zephyr-clash-bin`
* **Install Command**: `yay -S zephyr-clash-bin` or `paru -S zephyr-clash-bin`
* **Automation Workflow**: [`.github/workflows/update-aur.yml`](file:///c:/Users/Juwan/Desktop/Zephyr/.github/workflows/update-aur.yml)
