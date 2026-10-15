#!/usr/bin/env bash
# Removes everything deploy.sh created. Only touches resources named skudesk*.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
P="$GCP_PROJECT"; REGION="${REGION:-asia-southeast1}"; DB="${FIRESTORE_DATABASE:-skudesk}"
SA="skudesk-run@${P}.iam.gserviceaccount.com"
gcloud scheduler jobs delete skudesk-daily-scan --location "$REGION" --project "$P" --quiet || true
gcloud run services delete skudesk --region "$REGION" --project "$P" --quiet || true
for s in skudesk-gemini-key skudesk-serpapi-key skudesk-scan-secret skudesk-ebay-id skudesk-ebay-secret; do gcloud secrets delete "$s" --project "$P" --quiet 2>/dev/null || true; done
gcloud artifacts repositories delete skudesk --location "$REGION" --project "$P" --quiet 2>/dev/null || true
gcloud artifacts docker images delete "${REGION}-docker.pkg.dev/${P}/cloud-run-source-deploy/skudesk" --delete-tags --project "$P" --quiet 2>/dev/null || true
gcloud firestore databases delete --database="$DB" --project "$P" --quiet || true
gcloud projects remove-iam-policy-binding "$P" --member "serviceAccount:$SA" --role roles/datastore.user \
  --condition="expression=resource.name == 'projects/${P}/databases/${DB}',title=skudesk-db-only" >/dev/null || true
gcloud iam service-accounts delete "$SA" --project "$P" --quiet || true
echo "SKUdesk resources removed."
