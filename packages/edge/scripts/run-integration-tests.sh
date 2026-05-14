#!/usr/bin/env bash
#
# Roda integration tests SEQUENCIALMENTE (1 arquivo por vez).
#
# Por que serial: Bun test paraleliza arquivos por default. Os integration
# tests usam truncateAll() em beforeEach pra isolar dados. Quando dois
# arquivos rodam em paralelo, um trunca enquanto o outro está inserindo
# → 38 fails sistêmicos sem motivo aparente.
#
# Workaround: for-loop por arquivo. Custo: ~1s/arquivo (12 arquivos = ~12s
# vs ~0.5s paralelo). Aceitável dado o tradeoff.
#
# Pré-requisito: DATABASE_URL apontando pra um DB de teste (nome contém
# 'test'). assertSafeTestDb() em _helpers.ts protege contra prod.
#
# Uso:
#   DATABASE_URL=postgres://vipcam:senha@127.0.0.1:5432/vipcam_test \
#     bash packages/edge/scripts/run-integration-tests.sh

set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL not set — refusing to run integration tests" >&2
  exit 1
fi

failed=0
total_files=0

for f in $(find tests/integration -name '*.test.ts' | sort); do
  total_files=$((total_files + 1))
  echo ""
  echo "=== $f ==="
  if ! bun test "$f"; then
    failed=$((failed + 1))
  fi
done

echo ""
if [[ $failed -gt 0 ]]; then
  echo "FAILED: $failed of $total_files test files had failures" >&2
  exit 1
fi
echo "OK: all $total_files integration test files passed"
