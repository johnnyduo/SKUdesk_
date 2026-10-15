#!/usr/bin/env bash
# Deploys SKUdesk to Cloud Run with Cloud Scheduler and a dedicated Firestore database.
# Every resource is named skudesk* so the whole deployment can be removed with deploy/teardown.sh.
# Secrets are read from .env and stored in Secret Manager; they are never printed or committed.
set -euo pipefail
cd "$(dirname "$0")/.."

set -a; source .env; set +a
: "${GCP_PROJECT:?}" "${GEMINI_API_KEY:?}" "${GEMINI_MODEL:?}" "${SERPAPI_KEY:?}"
P="$GCP_PROJECT"
REGION="${REGION:-asia-southeast1}"
DB="${FIRESTORE_DATABASE:-skudesk}"
SA="skudesk-run@${P}.iam.gserviceaccount.com"
WATCHLIST="${WATCHLIST:-LEGO 10294 Titanic|us;LEGO Star Wars Millennium Falcon 75192|us}"

echo "== service account"
gcloud iam service-accounts describe "$SA" --project "$P" >/dev/null 2>&1 || \
  gcloud iam service-accounts create skudesk-run --display-name "SKUdesk Cloud Run" --project "$P"
# Firestore access only on the skudesk database, not the whole project.
gcloud projects add-iam-policy-binding "$P" --member "serviceAccount:$SA" --role roles/datastore.user \
  --condition="expression=resource.name == 'projects/${P}/databases/${DB}',title=skudesk-db-only" >/dev/null

echo "== secrets"
put_secret() { # name value
  if gcloud secrets describe "$1" --project "$P" >/dev/null 2>&1; then
    printf %s "$2" | gcloud secrets versions add "$1" --data-file=- --project "$P" >/dev/null
  else
    printf %s "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic --project "$P" >/dev/null
  fi
  gcloud secrets add-iam-policy-binding "$1" --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor --project "$P" >/dev/null
}
SCAN_SECRET="${SCAN_SECRET:-$(openssl rand -hex 24)}"
put_secret skudesk-gemini-key "$GEMINI_API_KEY"
put_secret skudesk-serpapi-key "$SERPAPI_KEY"
put_secret skudesk-scan-secret "$SCAN_SECRET"
if [ -n "${EBAY_CLIENT_ID:-}" ] && [ -n "${EBAY_CLIENT_SECRET:-}" ]; then
  put_secret skudesk-ebay-id "$EBAY_CLIENT_ID"; put_secret skudesk-ebay-secret "$EBAY_CLIENT_SECRET"
  EBAY_SECRETS=",EBAY_CLIENT_ID=skudesk-ebay-id:latest,EBAY_CLIENT_SECRET=skudesk-ebay-secret:latest"
else EBAY_SECRETS=""; fi

echo "== cloud run (built from source, no Dockerfile)"
gcloud run deploy skudesk --source . --region "$REGION" --project "$P" \
  --service-account "$SA" --allow-unauthenticated \
  --min-instances 0 --max-instances 2 --cpu 1 --memory 512Mi --timeout 120 \
  --set-env-vars "GCP_PROJECT=${P},FIRESTORE_DATABASE=${DB},GEMINI_MODEL=${GEMINI_MODEL},MONTHLY_SEARCH_CAP=${MONTHLY_SEARCH_CAP:-100}" \
  --set-env-vars "^@^WATCHLIST=${WATCHLIST}" \
  --set-secrets "GEMINI_API_KEY=skudesk-gemini-key:latest,SERPAPI_KEY=skudesk-serpapi-key:latest,SCAN_SECRET=skudesk-scan-secret:latest${EBAY_SECRETS}"
URL="$(gcloud run services describe skudesk --region "$REGION" --project "$P" --format 'value(status.url)')"

echo "== scheduler"
JOB=skudesk-daily-scan
COMMON=(--location "$REGION" --project "$P" --schedule "0 2 * * *" --time-zone "UTC" --uri "${URL}/api/jobs/scan" --http-method POST --attempt-deadline 180s --max-retry-attempts 1)
if gcloud scheduler jobs describe "$JOB" --location "$REGION" --project "$P" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$JOB" "${COMMON[@]}" --update-headers "x-skudesk-secret=${SCAN_SECRET}" >/dev/null
else
  gcloud scheduler jobs create http "$JOB" "${COMMON[@]}" --headers "x-skudesk-secret=${SCAN_SECRET}" >/dev/null
fi
echo "deployed: $URL"
echo "$URL" > deploy/last-url.txt
