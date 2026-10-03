#!/usr/bin/env bash
set -euo pipefail

if command -v nmap >/dev/null 2>&1; then
  echo "[RootWars] nmap is already installed at $(command -v nmap)"
  exit 0
fi

echo "[RootWars] Installing static nmap binary and service probes..."
TMP_SB=$(mktemp -d)
git clone --depth 1 --filter=blob:none --sparse https://github.com/andrew-d/static-binaries.git "$TMP_SB"
cd "$TMP_SB"
git sparse-checkout set binaries/linux/x86_64
sudo cp "$TMP_SB/binaries/linux/x86_64/nmap" /usr/local/bin/nmap
sudo chmod +x /usr/local/bin/nmap
rm -rf "$TMP_SB"

TMP_NMAP=$(mktemp -d)
git clone --depth 1 --filter=blob:none --no-checkout https://github.com/nmap/nmap.git "$TMP_NMAP"
cd "$TMP_NMAP"
git checkout HEAD -- nmap-services nmap-service-probes nmap-protocols nmap-rpc nmap-os-db nmap-mac-prefixes
sudo mkdir -p /usr/share/nmap /usr/local/share/nmap
sudo cp nmap-services nmap-service-probes nmap-protocols nmap-rpc nmap-os-db nmap-mac-prefixes /usr/share/nmap/
sudo sed -i '/^fallback /d; /^fallbacks /d' /usr/share/nmap/nmap-service-probes
sudo touch /usr/share/nmap/nmap-payloads
echo "return function() end" | sudo tee /usr/share/nmap/nse_main.lua >/dev/null
sudo cp -r /usr/share/nmap/* /usr/local/share/nmap/
rm -rf "$TMP_NMAP"

echo "[RootWars] Installed $(/usr/local/bin/nmap --version | head -n 1)"
