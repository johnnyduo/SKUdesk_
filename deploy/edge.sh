#!/usr/bin/env bash
# Deploys the Cloudflare Worker that fronts skudesk.lol and gives it the shared edge secret. Needs `wrangler login`.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
: "${EDGE_SECRET:?}"
cd edge
printf %s "$EDGE_SECRET" | wrangler secret put EDGE_SECRET >/dev/null
wrangler deploy
