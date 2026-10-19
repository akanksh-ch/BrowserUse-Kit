#!/bin/sh
# Syntax/module validation only: does not prove DNS, certificates, or runtime isolation.
set -eu
cd "$(dirname "$0")/.."
"${CADDY:-caddy}" validate --config deploy/Caddyfile --adapter caddyfile
