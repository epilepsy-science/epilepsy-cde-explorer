# Operator-flippable runtime config — these are SSM Parameter Store entries
# the Lambda reads with a 60s TTL cache (see api/internal/runtimecfg). Flip
# any of them with `aws ssm put-parameter --overwrite ...`; warm Lambda
# containers pick up the new value within ~1 minute, no redeploy needed.

# ── Allowlist toggle ────────────────────────────────────────────────────────
# When "true": only addresses in INVITE# get a code. When "false": anyone
# can request a code (subject to reCAPTCHA + rate limits).
resource "aws_ssm_parameter" "allowlist_enabled" {
  name  = "/${var.environment}/${var.service_name}/allowlist-enabled"
  type  = "String"
  value = "true" # safe default; flip to "false" via CLI when going wider

  description = "Whether request-code requires the email to be on the INVITE# allowlist."

  # Operators flip this via CLI; don't have Terraform fight them.
  lifecycle {
    ignore_changes = [value]
  }
}

# ── reCAPTCHA toggle ────────────────────────────────────────────────────────
resource "aws_ssm_parameter" "recaptcha_enabled" {
  name  = "/${var.environment}/${var.service_name}/recaptcha-enabled"
  type  = "String"
  value = "false" # off until you've registered the domain + populated the secret

  description = "Whether request-code requires a Google reCAPTCHA v3 token. Flip on once the secret is populated."

  lifecycle {
    ignore_changes = [value]
  }
}

# ── reCAPTCHA secret ────────────────────────────────────────────────────────
# Created empty by Terraform; you populate it via:
#   aws --profile pennsieve-dev-admin --region us-east-1 ssm put-parameter \
#     --name /dev/epilepsy-cde-explorer-api/recaptcha-secret \
#     --value '<google-secret-key>' --type SecureString --overwrite
#
# Get the secret from https://www.google.com/recaptcha/admin after
# registering cde.epilepsy.science as a v3 site. Site key (public) goes
# into VITE_RECAPTCHA_SITE_KEY for the dashboard build.
resource "aws_ssm_parameter" "recaptcha_secret" {
  name        = "/${var.environment}/${var.service_name}/recaptcha-secret"
  type        = "SecureString"
  value       = "PLACEHOLDER_REPLACE_VIA_AWS_CLI"
  description = "Google reCAPTCHA v3 secret key. Populate via aws ssm put-parameter once registered."

  lifecycle {
    ignore_changes = [value]
  }
}
