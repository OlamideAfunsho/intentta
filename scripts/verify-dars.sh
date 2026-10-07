#!/bin/sh
# Verify the vendored dependency DARs against their recorded checksums.
set -eu
cd "$(dirname "$0")/../daml/dars"
sha256sum -c SHA256SUMS
