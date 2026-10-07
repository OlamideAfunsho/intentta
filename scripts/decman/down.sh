#!/bin/sh
# Remove the DecMan nodes and the Canton network.
cd "$(dirname "$0")/../.."
export MSYS_NO_PATHCONV=1
sh scripts/decman/nodes.sh down
sh scripts/decman/network.sh down
