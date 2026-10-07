#!/bin/sh
# Bring up the DecMan network from nothing and set up the fund on it:
# four-participant Canton, three DecMan nodes, the issuer as a decentralized
# party, its GovernanceRules contract, then the fund itself by vote.
#
# Needs Docker, Node.js and the built DARs (scripts/build.sh).
#   scripts/decman/up.sh        then: node scripts/decman/redeem.mjs
#   scripts/decman/down.sh      to remove everything again
set -eu
cd "$(dirname "$0")/../.."
export MSYS_NO_PATHCONV=1
sh scripts/decman/nodes.sh down
sh scripts/decman/network.sh up
sh scripts/decman/nodes.sh up
sleep 12
node scripts/decman/peers.mjs
sleep 12
node scripts/decman/onboard.mjs fund-issuer | grep -E "onboarding|accepted"
node scripts/decman/govern.mjs | grep -v '^{'
node scripts/decman/fund.mjs
