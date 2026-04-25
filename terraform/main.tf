locals {
  app_name = "${var.environment}-${var.service_name}"
  fqdn     = "${var.subdomain_prefix}.${var.root_domain}"
}

# ─── Amplify app ────────────────────────────────────────────────────────────
# Build spec lives in repo at amplify.yml; Amplify reads it on each build.
# The GitHub→Amplify auth uses the Amplify GitHub App (installed once on the
# epilepsy-science org via the AWS console). Terraform manages everything
# *except* that one-time install — see terraform/README.md.
resource "aws_amplify_app" "this" {
  name        = local.app_name
  description = "CDE review dashboard for the epilepsy.science platform."
  repository  = var.github_repository
  platform    = "WEB"

  enable_branch_auto_build    = true
  enable_branch_auto_deletion = false
  enable_auto_branch_creation = false
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
data "aws_route53_zone" "this" {
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
locals {
  cert_record_parts = split(" ", aws_amplify_domain_association.this.certificate_verification_dns_record)
  cert_record_name  = local.cert_record_parts[0]
  cert_record_value = local.cert_record_parts[2]

  sub_record_parts = split(" ", tolist(aws_amplify_domain_association.this.sub_domain)[0].dns_record)
  sub_record_name  = local.sub_record_parts[0]
  sub_record_value = local.sub_record_parts[2]
}

# ACM cert verification CNAME — short-lived (only needed during issuance) but
# Amplify keeps it around for renewals.
resource "aws_route53_record" "cert_verification" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = local.cert_record_name
  type    = "CNAME"
  ttl     = 300
  records = [local.cert_record_value]

  # Tolerate the minor ordering glitch where Amplify takes a moment to
  # publish the verification record string.
  allow_overwrite = true
}

# Public-facing CNAME — points cde.epilepsy.science at the Amplify
# CloudFront distribution.
resource "aws_route53_record" "subdomain" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = local.sub_record_name
  type    = "CNAME"
  ttl     = 300
  records = [local.sub_record_value]

  allow_overwrite = true
}
