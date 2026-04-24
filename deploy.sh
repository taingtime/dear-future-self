#!/usr/bin/env bash
# Dear Future Self — one-command deploy to Netlify.
#
# First run: opens a browser once to authenticate netlify-cli. Subsequent
# runs deploy silently.
#
# Usage:  ./deploy.sh          (production deploy)
#         ./deploy.sh preview  (draft URL, doesn't overwrite prod)

set -euo pipefail
SITE_ID="8ba6c915-0055-4e7c-88fd-84c67ef62ffc"

if [[ "${1:-}" == "preview" ]]; then
  npx --yes netlify-cli deploy --dir=public --site="$SITE_ID"
else
  npx --yes netlify-cli deploy --prod --dir=public --site="$SITE_ID"
fi
