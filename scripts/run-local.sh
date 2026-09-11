#!/usr/bin/env bash
# Everything, locally, in one command: a throwaway Postgres, the schema, the
# demo data, and the app. Nothing is installed and nothing survives Ctrl-C.
#
# To keep the data, point DATABASE_URL at a real Postgres (or Supabase) and
# run `npm run serve` instead.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
WORK="$(mktemp -d)"
PGPORT="${LOCAL_DB_PORT:-54400}"
export PGUSER=postgres            # psql defaults to $USER, which this cluster has no role for
export PORT="${PORT:-4000}"
export DATABASE_URL="postgresql://postgres@localhost:$PGPORT/msbeauave?host=$WORK"
export SESSION_SECRET="${SESSION_SECRET:-local-development-only}"

AS_PG=""
if [ "$(id -u)" = "0" ] && id postgres >/dev/null 2>&1; then
  AS_PG="runuser -u postgres --"
  chmod 777 "$WORK"
fi

cleanup() {
  $AS_PG "$PGBIN/pg_ctl" -D "$WORK/pgdata" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> starting a throwaway Postgres"
$AS_PG "$PGBIN/initdb" -D "$WORK/pgdata" -U postgres --auth=trust --no-sync >/dev/null
$AS_PG "$PGBIN/pg_ctl" -D "$WORK/pgdata" -w \
  -o "-k $WORK -p $PGPORT -c listen_addresses='' -c fsync=off -c synchronous_commit=off" \
  -l "$WORK/pg.log" start >/dev/null
"$PGBIN/psql" -q -h "$WORK" -p "$PGPORT" -d postgres -c "CREATE DATABASE msbeauave" >/dev/null

echo "==> building the schema"
for f in "$ROOT"/db/[0-8]*.sql; do
  echo "    $(basename "$f")"
  "$PGBIN/psql" -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PGPORT" -d msbeauave -f "$f" >/dev/null
done

echo "==> demo data"
"$PGBIN/psql" -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PGPORT" -d msbeauave \
  -f "$ROOT/db/900_demo_data.sql"
cat <<'SIGNINS'

  Sign in with any of these — the password is "msbeauave":

    admin      the owner: everything
    warehouse  receiving, picking, moving stock
    cashier    the till and the close of day
    reseller   Cebu Glow Distributors, in good standing
    blocked    Davao Beauty Hub, past due, so it cannot order
SIGNINS

echo "==> starting the app"
node "$ROOT/scripts/dev.js"
