#!/usr/bin/env bash
# Safety net for disposable lab resources.
#
# The lab backend removes its mission network, target container and scanner
# container in a `finally` block for every scan. This script removes anything left
# behind (for example after a hard worker kill) from the DEDICATED lab daemon.
#
# Usage: LAB_DOCKER_HOST=tcp://lab-dind:2375 bash scripts/reap-lab-resources.sh
set -euo pipefail

DOCKER=(docker)
if [ -n "${LAB_DOCKER_HOST:-}" ]; then
  DOCKER=(docker -H "${LAB_DOCKER_HOST}")
fi

echo "[RootWars Lab] Reaping labelled disposable lab containers..."
mapfile -t CONTAINERS < <("${DOCKER[@]}" ps -aq --filter 'label=rootwars.disposable=true' || true)
if [ "${#CONTAINERS[@]}" -gt 0 ]; then
  "${DOCKER[@]}" rm -f -v "${CONTAINERS[@]}"
else
  echo "[RootWars Lab] No leftover lab containers."
fi

echo "[RootWars Lab] Reaping leftover lab networks..."
mapfile -t NETWORKS < <("${DOCKER[@]}" network ls -q --filter 'name=rwlab-net-' || true)
if [ "${#NETWORKS[@]}" -gt 0 ]; then
  for net in "${NETWORKS[@]}"; do
    "${DOCKER[@]}" network rm "$net" 2>/dev/null || true
  done
else
  echo "[RootWars Lab] No leftover lab networks."
fi

echo "[RootWars Lab] Done."
