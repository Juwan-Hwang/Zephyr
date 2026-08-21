Name:           zephyr
Version:        2.4.3
Release:        1%{?dist}
Summary:        A modern, lightweight Mihomo GUI client
License:        MIT
URL:            https://github.com/Juwan-Hwang/Zephyr
Source0:        https://github.com/Juwan-Hwang/Zephyr/releases/download/v%{version}/Zephyr-%{version}-1.x86_64-full.rpm

BuildArch:      x86_64
Requires:       gtk3
Requires:       webkit2gtk4.1
Requires:       libayatana-appindicator-gtk3

%description
Zephyr is a state-of-the-art cross-platform GUI client for Mihomo, combining modern desktop aesthetics, high performance with Rust and Tauri v2, and a 13-layer security defense architecture.

%prep

%build

%install
mkdir -p %{buildroot}
rpm2cpio %{SOURCE0} | cpio -idmv -D %{buildroot}

%files
/usr/bin/zephyr
/usr/share/applications/zephyr.desktop
/usr/share/icons/hicolor/*/apps/zephyr.png

%changelog
* Sat Aug 08 2026 Juwan <juwan.hwang@proton.me> - 2.4.3-1
- Release Zephyr v2.4.3
