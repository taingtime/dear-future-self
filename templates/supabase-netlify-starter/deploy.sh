#!/usr/bin/env bash
# One-command deploy to Netlify. Cowork fills in SITE_ID during bootstrap.
set -euo pipefail
SITE_ID="__NETLIFY_SITE_ID__"

if [[ "${1:-}" == "preview" ]]; then
  npx --yes netlify-cli deploy --dir=public --site="$SITE_ID"
else
  npx --yes netlify-cli deploy --prod --dir=public --site="$SITE_ID"
fi
