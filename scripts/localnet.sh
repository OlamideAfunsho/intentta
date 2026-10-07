#!/bin/sh
# Local Canton ledger for the demo and the end-to-end evidence run.
#
#   scripts/localnet.sh start      start a Canton sandbox (Ledger API 6865, JSON API 7575)
#   scripts/localnet.sh bootstrap  upload the DARs and create Registry, instruments,
#                                  DecMan rules, policy and balances -> .local/localnet.json
#   scripts/localnet.sh stop       stop the sandbox
#
# The sandbox keeps its state in memory: stop + start gives a clean ledger.
set -eu
cd "$(dirname "$0")/.."
. scripts/env.sh
mkdir -p .local

TEST_DAR=daml/intentta-redemption-test/.daml/dist/intentta-redemption-test-0.1.0.dar
KIT_DAR=daml/intentta-redemption/.daml/dist/intentta-redemption-v1-0.1.0.dar

wait_for_json_api() {
  i=0
  # Ready means: JSON API answering and the participant connected to its
  # synchronizer (party allocation fails before that).
  until curl -sf http://localhost:7575/v2/state/connected-synchronizers 2>/dev/null | grep -q synchronizerId; do
    i=$((i + 1)); [ $i -gt 180 ] && { echo "sandbox did not come up; see .local/sandbox.log" >&2; exit 1; }
    sleep 2
  done
}

case "${1:-}" in
  start)
    if curl -sf http://localhost:7575/v2/state/ledger-end > /dev/null 2>&1; then
      echo "a ledger is already running on port 7575; run: scripts/localnet.sh stop" >&2
      exit 1
    fi
    [ -f "$TEST_DAR" ] || sh scripts/build.sh
    # A small heap is enough for the demo and keeps laptops usable.
    JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:--Xmx1536m}" daml_sandbox \
      --port 6865 --json-api-port 7575 --wall-clock-time \
      --dar "$KIT_DAR" --dar "$TEST_DAR" > .local/sandbox.log 2>&1 &
    echo $! > .local/sandbox.pid
    wait_for_json_api
    echo "Canton sandbox up: Ledger API localhost:6865, JSON API http://localhost:7575"
    ;;
  bootstrap)
    wait_for_json_api
    daml_script --dar "$TEST_DAR" \
      --script-name IntentTA.Redemption.Test.LocalNet:bootstrap \
      --ledger-host localhost --ledger-port 6865 \
      --output-file .local/localnet.json
    echo "Bootstrapped. Parties and contract ids in .local/localnet.json"
    ;;
  stop)
    # The launcher starts Canton as a separate JVM, so stop whatever is
    # listening on the Ledger API port rather than the launcher's pid.
    if command -v taskkill > /dev/null 2>&1; then
      for pid in $(netstat -ano | grep -E "127\.0\.0\.1:6865 .*LISTENING" | awk '{print $NF}' | sort -u); do
        taskkill //F //PID "$pid" > /dev/null 2>&1 || true
      done
    elif command -v lsof > /dev/null 2>&1; then
      for pid in $(lsof -ti tcp:6865 -s tcp:LISTEN 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
    else
      pkill -f canton.jar 2>/dev/null || true
    fi
    rm -f .local/sandbox.pid .local/localnet.json
    echo "stopped"
    ;;
  *)
    echo "usage: scripts/localnet.sh start|bootstrap|stop" >&2
    exit 2
    ;;
esac
