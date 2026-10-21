#!/usr/bin/env bash
# C2-B, крок 4: Workload Identity Federation для GitHub Actions → service account mm-sheets-reader.
# Виконувати в Google Cloud Shell під акаунтом власника проєкту. Нічого не змінює в таблиці/Apps Script/Prom.
# Створює: пул «github», OIDC-провайдер «maisternia-prom-infra» з умовою доступу, роль workloadIdentityUser на SA
# лише для репозиторію TSOstap/maisternia-prom-infra (числовий ID 1428429135). Ключів не створює, білінг не потрібен.
set -euo pipefail

PROJECT_ID="maisternia-prom-infra"
PROJECT_NUMBER="679502453033"
SA="mm-sheets-reader@maisternia-prom-infra.iam.gserviceaccount.com"
POOL="github"
PROVIDER="maisternia-prom-infra"
REPO_ID="1428429135"      # gh api repos/TSOstap/maisternia-prom-infra → .id
OWNER_ID="223876873"      # → .owner.id
WORKFLOW_REF="TSOstap/maisternia-prom-infra/.github/workflows/sheets-verify.yml@refs/heads/main"

gcloud config set project "$PROJECT_ID"

echo "== 1/3 Пул Workload Identity"
gcloud iam workload-identity-pools create "$POOL" \
  --project="$PROJECT_ID" --location="global" \
  --display-name="GitHub Actions" \
  --description="OIDC з GitHub Actions; лише репозиторій maisternia-prom-infra"

echo "== 2/3 OIDC-провайдер GitHub з умовою доступу"
gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
  --project="$PROJECT_ID" --location="global" --workload-identity-pool="$POOL" \
  --display-name="maisternia-prom-infra" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref" \
  --attribute-condition="assertion.repository_id=='${REPO_ID}' && assertion.repository_owner_id=='${OWNER_ID}' && assertion.ref=='refs/heads/main' && assertion.workflow_ref=='${WORKFLOW_REF}'"

echo "== 3/3 Дозвіл репозиторію (і лише йому) діяти від імені service account"
gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository_id/${REPO_ID}"

echo "== ПЕРЕВІРКА"
gcloud iam workload-identity-pools providers describe "$PROVIDER" \
  --project="$PROJECT_ID" --location="global" --workload-identity-pool="$POOL" \
  --format="yaml(name,state,attributeCondition,oidc.issuerUri)"
gcloud iam service-accounts get-iam-policy "$SA" --project="$PROJECT_ID" --format="yaml(bindings)"
gcloud iam service-accounts keys list --iam-account="$SA" --managed-by=user --project="$PROJECT_ID"
echo "ГОТОВО"
