#!/usr/bin/env bash
# Run the tests against a real Postgres, on a cluster created and thrown away
# for the run. Nothing has to be installed or running beforehand beyond the
# Postgres binaries themselves.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
WORK="${TEST_DIR:-$(mktemp -d)}"
PGPORT="${TEST_DB_PORT:-54410}"
export PGUSER=postgres
export TEST_DATABASE_URL="postgresql://postgres@localhost:$PGPORT/msbeauave_test?host=$WORK"
export SESSION_SECRET="tests-only"

AS_PG=""
if [ "$(id -u)" = "0" ] && id postgres >/dev/null 2>&1; then
  AS_PG="runuser -u postgres --"
  chmod 777 "$WORK"
fi

cleanup() {
  $AS_PG "$PGBIN/pg_ctl" -D "$WORK/pgdata" -m immediate stop >/dev/null 2>&1 || true
  [ -z "${TEST_DIR:-}" ] && rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> preparing a database"
$AS_PG "$PGBIN/initdb" -D "$WORK/pgdata" -U postgres --auth=trust --no-sync >/dev/null
$AS_PG "$PGBIN/pg_ctl" -D "$WORK/pgdata" -w \
  -o "-k $WORK -p $PGPORT -c listen_addresses='' -c fsync=off -c synchronous_commit=off" \
  -l "$WORK/pg.log" start >/dev/null
# Two databases. The going-live tests replace the whole catalogue and erase
# every sale, which is not something that can share a database with tests that
# are counting sales.
for name in msbeauave_test msbeauave_golive; do
  "$PGBIN/psql" -q -h "$WORK" -p "$PGPORT" -d postgres -c "CREATE DATABASE $name" >/dev/null
  for f in "$ROOT"/db/0*.sql; do
    "$PGBIN/psql" -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PGPORT" -d "$name" -f "$f" >/dev/null
  done
done

cd "$ROOT"

# The tests that need nothing but the code go first: they are instant, and a
# failure there is worth seeing before waiting on a database.
echo "==> matching photographs to names"
node --test tests/photo-names.test.js

echo "==> the order faces appear on the door"
node --test tests/clock-order.test.js

echo "==> every clock shows Manila"
node --test tests/manila.test.js

echo "==> pages that are their own"
node --test tests/public-pages.test.js

echo "==> an eye on every password box"
node --test tests/reveal.test.js

echo "==> running the tests"
node --test tests/acceptance.test.js

echo "==> one person's record and everybody else's"
node --test tests/hr.test.js

echo "==> a shop signing itself up"
node --test tests/reseller-signup.test.js

echo "==> somebody who may look and not touch"
node --test tests/observer.test.js

echo "==> everybody's own password, and nobody else's"
node --test tests/my-password.test.js

echo "==> every definer function keeps its search_path"
node --test tests/search-path.test.js

echo "==> which way somebody clocked"
node --test tests/how-they-clocked.test.js

echo "==> a finger, then a PIN"
node --test tests/finger-then-pin.test.js

echo "==> one person, opened"
node --test tests/person-profile.test.js

echo "==> going live"
TEST_DATABASE_URL="postgresql://postgres@localhost:$PGPORT/msbeauave_golive?host=$WORK" \
  node --test tests/golive.test.js
