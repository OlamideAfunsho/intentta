#!/bin/sh
# Four-participant Canton network for the DecMan run, in Docker.
#   scripts/decman/network.sh up | down
#
# Uses the Canton build that DecMan is tested against (Splice 0.6.12), which
# speaks the protocol version DecMan v1.13 requires. The JSON Ledger API of
# each participant is published on localhost:5003, 5013, 5023 and 5033.
set -eu
cd "$(dirname "$0")/../.."
export MSYS_NO_PATHCONV=1
IMG=ghcr.io/digital-asset/decentralized-canton-sync/docker/canton:0.6.12
docker rm -f canton > /dev/null 2>&1 || true
case "${1:-up}" in
  down) echo "network stopped"; exit 0 ;;
esac
mkdir -p .local/decman
rm -f .local/decman/state.json
docker network create decman-net > /dev/null 2>&1 || true
CONF="$(pwd -W 2>/dev/null || pwd)/scripts/decman"
docker run -d --name canton --network decman-net \
  -p 5003:5003 -p 5013:5013 -p 5023:5023 -p 5033:5033 \
  -e JAVA_TOOL_OPTIONS="${CANTON_JAVA_OPTS:--Xmx3g}" \
  -v "$CONF:/conf:ro" --entrypoint /app/bin/canton "$IMG" \
  daemon --no-tty -c /conf/canton.conf --bootstrap /conf/bootstrap.canton \
  --log-level-stdout=INFO --log-file-appender=off > /dev/null
i=0
until docker logs canton 2>&1 | grep -q "DECMAN-LOCALNET-READY"; do
  i=$((i + 1))
  if [ $i -gt 150 ] || [ -z "$(docker ps -q -f name=^canton$)" ]; then
    echo "network did not come up; see: docker logs canton" >&2; exit 1
  fi
  sleep 3
done
node scripts/decman/ledger-users.mjs
echo "4-participant network up"
