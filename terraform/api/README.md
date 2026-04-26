# `terraform/api/` — Review API deploy

Provisions the Lambda backend at `api.cde.epilepsy.science`. Component is
independent from the dashboard module (sibling state key) so deploys don't
block each other.

## State backend

```
s3://pennsieve-non-prod-terraform-state/aws/us-east-1/dev-epilepsy-cde-explorer-api-use1/dev/terraform.tfstate
```

S3-native locking (`use_lockfile`); no DynamoDB lock table needed.

## What this manages

| File | Resources |
|---|---|
| `versions.tf` | Terraform/AWS pin, S3 backend, default + `aws.dns` provider (cross-account to cc) |
| `dynamodb.tf` | Single-table store with GSI + TTL + PITR |
| `secrets.tf` | JWT signing secret (random_password → SSM SecureString) |
| `lambda.tf` | IAM role + scoped policy, log group, Lambda function (zips the Go binary) |
| `apigw.tf` | HTTP API + 8 routes + AWS_PROXY integration + access-log group |
| `dns.tf` | ACM cert, DNS validation records (cc account), API Gateway custom domain, public ALIAS record (cc account) |

## Apply order

The Terraform module assumes the Go binary already exists at
`api/dist/api/bootstrap`. Build it first:

```bash
make -C api build
```

Then:

```bash
cd terraform/api
terraform init
terraform plan
terraform apply
```

First apply takes ~5–10 min (ACM cert validation + custom-domain attach).
After that, `make -C api build && terraform apply` is the iteration loop —
TF detects binary changes via `source_code_hash` and pushes the new zip.

## Allowlist

The auth flow only sends codes to addresses in the `INVITE#<email>` table.
For now, seed manually after first apply:

```bash
aws --profile pennsieve-dev-admin --region us-east-1 dynamodb put-item \
  --table-name dev-epilepsy-cde-explorer-api \
  --item '{
    "PK":         {"S": "INVITE#joost.wagenaar2@pennmedicine.upenn.edu"},
    "SK":         {"S": "META"},
    "email":      {"S": "joost.wagenaar2@pennmedicine.upenn.edu"},
    "role":       {"S": "admin"},
    "invited_by": {"S": "bootstrap"},
    "invited_at": {"S": "2026-04-25T00:00:00Z"}
  }'
```

When the reviewer roster stabilizes, swap to a TF-managed `aws_dynamodb_table_item`
list driven by a tfvars allowlist.

## CORS

The dashboard at `https://cde.epilepsy.science` is the only origin allowed.
If the dashboard moves (preview deploys, staging, etc.) extend `app_origin`
or split into `app_origins` (list).

## Logs

```bash
aws --profile pennsieve-dev-admin --region us-east-1 \
  logs tail /aws/lambda/dev-epilepsy-cde-explorer-api --follow
```

Both Lambda logs and HTTP API access logs land in CloudWatch under
`/aws/lambda/<fn>` and `/aws/apigateway/<fn>`.

## JWT secret rotation

```bash
terraform taint random_password.jwt_secret
terraform apply
```

All in-flight tokens become invalid; reviewers see a 401 and re-verify by
email. Acceptable at our scale.

## Adding a route

1. Add the handler in `api/internal/handlers/<file>.go`
2. Wire it in the route table in `api/cmd/api/main.go`
3. Add the same `RouteKey` to `local.routes` in `apigw.tf`
4. `make -C api build && terraform apply`
