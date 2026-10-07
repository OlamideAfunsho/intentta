#!/bin/sh
# Locate the Daml SDK 3.4.11 and a JDK 17.
#
# If `daml` is on PATH (installed with the official installer), it is used as
# is. Otherwise point DAML_SDK_DIR at an unpacked daml-sdk-3.4.11 tarball and
# JAVA_HOME at a JDK 17. Sourced by the other scripts.

if [ -n "${JAVA_HOME:-}" ]; then PATH="$JAVA_HOME/bin:$PATH"; export PATH; fi

if [ -n "${DAML_SDK_DIR:-}" ]; then
  export DAML_SDK="$DAML_SDK_DIR" DAML_SDK_VERSION=3.4.11
  export DAML_HOME="${DAML_HOME:-$DAML_SDK_DIR/../damlhome}" DAML_ASSISTANT="$DAML_SDK_DIR/daml/daml"
  DAMLC="$DAML_SDK_DIR/damlc/damlc"
  CANTON_JAR="$DAML_SDK_DIR/canton/canton.jar"
  SDK_JAR="$DAML_SDK_DIR/daml-sdk/daml-sdk.jar"
  damlc() { "$DAMLC" "$@"; }
  daml_script() { java -jar "$SDK_JAR" script "$@"; }
  daml_sandbox() { "$DAML_SDK_DIR/daml-helper/daml-helper" sandbox "$@"; }
elif command -v daml >/dev/null 2>&1; then
  damlc() { daml damlc "$@"; }
  daml_script() { daml script "$@"; }
  daml_sandbox() { daml sandbox "$@"; }
  CANTON_JAR="$(dirname "$(daml path sdk 2>/dev/null || echo .)")/canton/canton.jar"
else
  echo "Daml SDK 3.4.11 not found: install it, or set DAML_SDK_DIR." >&2
  exit 1
fi
