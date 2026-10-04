#!/usr/bin/env bash
# Build and load the two RootWars lab images:
#
#   rootwars/lab-scanner  - Alpine + nmap, entrypoint is /usr/bin/nmap (fixed path)
#   rootwars/lab-target   - disposable mission target service emulator
#
# Usage (local development):
#   bash scripts/build-lab-images.sh
#
#   LAB_DOCKER_HOST=tcp://localhost:2375 bash scripts/build-lab-images.sh
#
# When LAB_DOCKER_HOST is set, the images are built with the default local Docker
# context and then loaded into the dedicated lab daemon, because the lab daemon is
# intentionally attached to an internal-only network and cannot pull base images.
set -euo pipefail

SCANNER_TAG="${LAB_SCANNER_IMAGE:-rootwars/lab-scanner:1.0.0}"
TARGET_TAG="${LAB_TARGET_IMAGE:-rootwars/lab-target:1.0.0}"
LAB_DOCKER_HOST="${LAB_DOCKER_HOST:-}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[RootWars Lab] Building ${SCANNER_TAG} and ${TARGET_TAG}..."
docker build -t "$SCANNER_TAG" -f Dockerfile.lab-scanner .
docker build -t "$TARGET_TAG" -f Dockerfile.lab-target .

if [ -n "$LAB_DOCKER_HOST" ]; then
  echo "[RootWars Lab] Loading images into lab daemon ${LAB_DOCKER_HOST}..."
  docker save "$SCANNER_TAG" "$TARGET_TAG" | docker -H "$LAB_DOCKER_HOST" load
fi

echo "[RootWars Lab] Verifying the fixed nmap binary path inside ${SCANNER_TAG}..."
docker run --rm --entrypoint /usr/bin/nmap "$SCANNER_TAG" --version | head -n 1

echo "[RootWars Lab] Done. The lab worker verifies these images at startup and fails closed if they are missing."
