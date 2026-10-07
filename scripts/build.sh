#!/bin/sh
# Build every Daml package, in dependency order.
set -eu
cd "$(dirname "$0")/.."
. scripts/env.sh
sh scripts/verify-dars.sh > /dev/null
for pkg in daml/intentta-redemption daml/intentta-issuer-setup daml/intentta-redemption-test \
           examples/consumer-fund/acme-fund examples/consumer-fund/acme-fund-test; do
  echo "== build $pkg"
  (cd "$pkg" && damlc build --enable-multi-package=no)
done
