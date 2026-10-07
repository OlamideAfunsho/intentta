#!/bin/sh
# Start (or stop) three DecMan nodes, one per local participant.
#   scripts/decman/nodes.sh up | down
IMG=public.ecr.aws/dlc-link/decentralization-manager:v1.13.0
case "${1:-up}" in
  down) for i in 1 2 3; do docker rm -f decman$i > /dev/null 2>&1; done; echo "DecMan nodes removed"; exit 0 ;;
esac
docker network create decman-net > /dev/null 2>&1 || true
for i in 1 2 3; do
  docker rm -f decman$i > /dev/null 2>&1 || true
  docker run -d --name decman$i --network decman-net -p 808$i:808$i \
    --add-host host.docker.internal:host-gateway \
    -e DECPM_INSECURE=true -e DECPM_LOG_FORMAT=text \
    -e DECPM_HOST=0.0.0.0 -e DECPM_PORT=808$i \
    -e DECPM_NOISE_PORT=900$i -e DECPM_PUBLIC_ADDRESS=decman$i \
    -e DECPM_CANTON_ADMIN_HOST=canton -e DECPM_CANTON_ADMIN_PORT=$((5002 + (i - 1) * 10)) \
    -e DECPM_CANTON_LEDGER_HOST=canton -e DECPM_CANTON_LEDGER_PORT=$((5001 + (i - 1) * 10)) \
    -e DECPM_CANTON_SYNCHRONIZER=global -e DECPM_CANTON_NETWORK=devnet \
    -e DECPM_METRICS_PORT=0 -e DECPM_TOPOLOGY_PROPAGATION_DELAY_SECS=3 -e DECPM_PEER_WAIT_POLL_DELAY_MS=500 \
    "$IMG" > /dev/null
done
echo "DecMan nodes: http://localhost:8081  http://localhost:8082  http://localhost:8083"
