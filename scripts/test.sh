#!/bin/sh
# Run every Daml Script test of the kit and of the consuming example.
set -eu
cd "$(dirname "$0")/.."
. scripts/env.sh
for pkg in daml/intentta-redemption-test examples/consumer-fund/acme-fund-test; do
  echo "== test $pkg"
  # `pwd -W` gives a native path under Git Bash on Windows; elsewhere it is
  # not supported and plain `pwd` is used.
  (cd "$pkg" && damlc test --package-root "$(pwd -W 2>/dev/null || pwd)" "$@")
done
