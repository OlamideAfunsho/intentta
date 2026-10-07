#!/bin/sh
# Run the investor page against the DecMan network: the investor's own
# participant (4) for commands, the registrars' participants for reference data.
set -eu
cd "$(dirname "$0")/../.."
node -e "import('./scripts/decman/lib.mjs').then((m) => m.writeNetFile(m.loadState()))"
export LEDGER_URL=http://localhost:5033 LEDGER_USER=ledger-api-user LOCALNET_FILE=.local/decman/net.json
LEDGER_TOKEN="$(node scripts/decman/token.mjs)"
export LEDGER_TOKEN
exec node demo/server.mjs
