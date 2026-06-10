#!/bin/bash
set -e

sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf \
  build-essential \
  pkg-config \
  libssl-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev
sudo rm -rf /var/lib/apt/lists/*

sudo corepack enable

pnpm install
