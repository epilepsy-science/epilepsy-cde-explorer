# `terraform/` — Amplify deploy for the CDE review dashboard

Manages the AWS Amplify Hosting app, its production branch, custom domain
attachment, and Route 53 records that point `cde.epilepsy.science` at the
deployed app.

## State backend

State lives in the existing Pennsieve non-prod state bucket:

```
s3://pennsieve-non-prod-terraform-state/aws/us-east-1/dev-epilepsy-cde-explorer-use1/dev/terraform.tfstate
```

Locking uses Terraform 1.10's S3-native `use_lockfile` (no DynamoDB table
needed). Required Terraform version is `>= 1.10.0`.

## One-time bootstrap (before first apply)

The Amplify ↔ GitHub auth uses the **AWS Amplify GitHub App**, which has to be
installed on the `epilepsy-science` GitHub org by an org admin. This is a
30-second click-through and only needs to happen once per org:

1. Go to <https://us-east-1.console.aws.amazon.com/amplify/create/repo-branch>.
2. Click **GitHub** as the source.
3. Click **Authorize AWS Amplify** → install the Amplify GitHub App on the
   `epilepsy-science` organization. Give it access to the
   `epilepsy-cde-explorer` repository.
4. You'll be redirected back to a "Pick a repo and branch" screen — close
   this tab. The install is what we needed; we don't want to create the app
   via the console.

After that, any Terraform-managed Amplify app under this AWS account that
references a repo in the `epilepsy-science` org will auth automatically.

## Apply

```bash
cd terraform/
terraform init
terraform plan
terraform apply
```

Expected first-apply duration is **5–15 minutes** — most of that is ACM
certificate issuance + DNS propagation for the custom domain. Terraform waits
for verification (`wait_for_verification = true` on the domain association),
so the apply blocks until `cde.epilepsy.science` is actually serving HTTPS.

## After apply

- **Default Amplify URL** is available immediately:
  `https://main.<app_id>.amplifyapp.com` (see `terraform output production_branch_url`).
- **Custom domain** comes live once the cert validates: `https://cde.epilepsy.science`.
- **Auto-deploy** is on: pushing to `main` triggers a new build + deploy.

## Modifying

- Update `variables.tf` defaults or pass `-var` flags for one-off tweaks.
- Build commands live in repo-root `amplify.yml`; Amplify reads it on each
  build, so changes to that file ship via a normal git push (no TF apply
  needed).
- Custom HTTP headers (cache-control etc.) also live in `amplify.yml`.

## Adding a Lambda API later

When the review-capture API gets added, create a sibling component for it
(e.g. `terraform/lambda/`) with its own state key:
```
aws/us-east-1/dev-epilepsy-cde-explorer-api-use1/dev/terraform.tfstate
```
Keep the Amplify and Lambda states separate so deploy cycles don't block each
other. Cross-component lookups go via `data "terraform_remote_state"` if you
need outputs from this module.
