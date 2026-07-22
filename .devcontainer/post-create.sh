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
  libayatana-appindicator3-dev \
  file \
  libxdo-dev

sudo corepack enable

pnpm install --ignore-scripts
pnpm rebuild esbuild @parcel/watcher
