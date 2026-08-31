#!/bin/sh
# Build sim pour le VPS — contourne le script officiel qui force 8GB de heap.
# Le package.json de sim fait: NODE_OPTIONS='--max-old-space-size=8192' next build
# ce qui OOM sur un VPS 8GB. On lance next build directement avec une heap maîtrisée.
set -e

cd /opt/sim/apps/sim

export DOCKER_BUILD=1
export NEXT_TELEMETRY_DISABLED=1
export CPU_COUNT=1

echo "=== $(date) — build sim (heap 4096MB, direct next build) ==="
echo "RAM libre avant : $(free -h | grep Mem | awk '{print $7}')"
echo "Swap libre      : $(free -h | grep Swap | awk '{print $4}')"

# 1. Compiler les bundles sandbox (rapide, fait à chaque fois)
bun run build:sandbox-bundles

# 2. Lancer next build DIRECTEMENT avec heap maîtrisée (pas 8192!)
NODE_OPTIONS='--max-old-space-size=4096' bunx next build
