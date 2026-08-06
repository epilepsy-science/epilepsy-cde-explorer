locals {
  # The Amplify app name is user-facing (shown in console + tied to the auto-
  # generated *.amplifyapp.com URL); we keep it free of env prefixes since the
  # GitHub repo + custom domain don't need them. The Pennsieve env-service-
  # region convention still applies to the state key (see versions.tf).
  app_name = var.service_name
  fqdn     = "${var.subdomain_prefix}.${var.root_domain}"
}

# ─── Amplify app ────────────────────────────────────────────────────────────
# Build spec lives in repo at amplify.yml; Amplify reads it on each build.
#
# Auth note: this app was originally created via the AWS Amplify console
# using the Amplify GitHub App (org-level install) — no PAT required. The
# resulting token lives inside Amplify itself and isn't surfaced via the API,
# so TF doesn't manage it. Re-creating from scratch *would* need a token; if
# we ever delete + recreate, store a PAT in SSM and reintroduce
# `access_token = data.aws_ssm_parameter.github_token.value`.
resource "aws_amplify_app" "this" {
  name        = local.app_name
  description = "CDE review dashboard for the epilepsy.science platform."
  repository  = var.github_repository
  platform    = "WEB"

  enable_branch_auto_build    = true
  enable_branch_auto_deletion = false
  enable_auto_branch_creation = false

  # Build-time env vars Vite reads into import.meta.env. Anything secret
  # belongs in SSM + Lambda env (see terraform/api/), not here.
  environment_variables = {
    VITE_RECAPTCHA_SITE_KEY = var.recaptcha_site_key
    VITE_GA_MEASUREMENT_ID  = var.ga_measurement_id
    # Published CDE catalog (cde-service) the dashboard reads via DuckDB-WASM.
    # Points at the neuro/epilepsy scoped collection (a drop-in catalog root: the
    # load path is <base>/cde/latest.json + <base>/cde/versions/…). Requires the
    # prod catalog to be v2 with the collection published; local dev overrides
    # this in .env.local (the dev collection) meanwhile.
    VITE_CDE_CATALOG_URL = "https://cde-catalog.pennsieve.io/collections/neuro-epilepsy"
  }
}

resource "aws_amplify_branch" "main" {
  app_id            = aws_amplify_app.this.id
  branch_name       = var.production_branch
  framework         = "Vue"
  stage             = "PRODUCTION"
  enable_auto_build = true
  description       = "Production branch — deploys to ${local.fqdn}."
}

# ─── Custom domain + Route 53 wiring ────────────────────────────────────────
# The Route 53 zone for epilepsy.science is in the pennsieve-cc account, not
# the pennsieve-dev account that owns the Amplify app. The `aws.dns` alias
# (defined in versions.tf) scopes the zone lookup + record writes to the cc
# account; the Amplify resources continue to use the default provider.
data "aws_route53_zone" "this" {
  provider     = aws.dns
  name         = "${var.root_domain}."
  private_zone = false
}

resource "aws_amplify_domain_association" "this" {
  app_id      = aws_amplify_app.this.id
  domain_name = var.root_domain

  sub_domain {
    branch_name = aws_amplify_branch.main.branch_name
    prefix      = var.subdomain_prefix
  }

  # Wait for ACM cert + DNS verification to converge before completing apply.
  wait_for_verification = true
}

# Amplify exports the cert verification + sub-domain DNS records as space-
# delimited strings ("name CNAME value"). Split them for Route 53.
# `try()` guards against empty strings during `terraform import` (the
# domain association's records aren't populated until refresh), so the
# import flow doesn't blow up evaluating these locals.
locals {
  cert_record_parts = try(split(" ", aws_amplify_domain_association.this.certificate_verification_dns_record), [])
  cert_record_name  = try(local.cert_record_parts[0], "")
  cert_record_value = try(local.cert_record_parts[2], "")

  sub_record_parts = try(split(" ", tolist(aws_amplify_domain_association.this.sub_domain)[0].dns_record), [])
  sub_record_value = try(local.sub_record_parts[2], "")
}

# ACM cert verification CNAME — short-lived (only needed during issuance) but
# Amplify keeps it around for renewals. Lives in the cc account's Route 53.
resource "aws_route53_record" "cert_verification" {
  provider = aws.dns
  zone_id  = data.aws_route53_zone.this.zone_id
  name     = local.cert_record_name
  type     = "CNAME"
  ttl      = 300
  records  = [local.cert_record_value]

  # Tolerate the minor ordering glitch where Amplify takes a moment to
  # publish the verification record string.
  allow_overwrite = true
}

# Public-facing CNAME — points cde.epilepsy.science at the Amplify
# CloudFront distribution. Construct the FQDN from variables (rather than
# parsing the prefix-only `cde` token out of the dns_record string) so the
# imported record's name matches without forcing replacement.
resource "aws_route53_record" "subdomain" {
  provider = aws.dns
  zone_id  = data.aws_route53_zone.this.zone_id
  name     = "${var.subdomain_prefix}.${var.root_domain}"
  type     = "CNAME"
  ttl      = 300
  records  = [local.sub_record_value]

  allow_overwrite = true
}
