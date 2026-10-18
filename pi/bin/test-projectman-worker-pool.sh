#!/usr/bin/env bash
set -euo pipefail
s8_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
phcms_root="${1:-$s8_root/../ph-cms}"
cd -- "$phcms_root/packages/server"
run_id="$(date -u +%y%m%d%H%M%S)_${RANDOM}_$$"
test_role="s8_pool_${run_id}"
test_database="phcms_service_keys_test_${run_id}"
test_password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
role_created=false
database_created=false
cleanup() {
  if "$database_created"; then docker exec -i postgres psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE $test_database WITH (FORCE)" >/dev/null; fi
  if "$role_created"; then docker exec -i postgres psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 -c "DROP ROLE $test_role" >/dev/null; fi
}
trap cleanup EXIT
docker exec -i postgres psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 >/dev/null <<SQL
CREATE ROLE $test_role LOGIN PASSWORD '$test_password';
SQL
role_created=true
docker exec -i postgres psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $test_database OWNER $test_role" >/dev/null
database_created=true
env -i PATH="$PATH" HOME="$HOME" NODE_ENV=test DB_PORT=5432 SERVICE_KEY_TEST_DB="$test_database" SERVICE_KEY_TEST_USER="$test_role" SERVICE_KEY_TEST_PASSWORD="$test_password" ./node_modules/.bin/vitest run --config "$s8_root/pi/test/integration/worker-pool/vitest.config.mjs"
