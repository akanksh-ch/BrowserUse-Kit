#!/usr/bin/env bash
# Lifecycle adapter. Full readiness requires a trusted deployment-specific probe.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ${1:-} == health ]]; then
  id=${2:?workspace ID}
  [[ "$id" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || exit 1
  OCI=${OCI_RUNTIME:-${OCI:-docker}}
  [[ $("$OCI" inspect -f '{{.State.Health.Status}}' "buk-$id-browser") == healthy ]]
  [[ $("$OCI" inspect -f '{{.State.Running}}' "buk-$id-utility") == true ]]
  [[ $("$OCI" inspect -f '{{.State.Running}}' "buk-$id-egress") == true ]]
  # This executable is administrator configuration, never workspace input.
  : "${BROWSERUSE_CONTROL_HEALTHCHECK:?Set trusted MCP/gate/storage/policy health probe executable}"
  exec "$BROWSERUSE_CONTROL_HEALTHCHECK" "$id"
fi
exec bash scripts/runtime.sh "$@"
