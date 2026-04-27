locals {
  function_name = "${var.environment}-${var.service_name}"
}

# ─── Build artifact ─────────────────────────────────────────────────────────
# The Go binary is built outside Terraform (`make -C api build`) and placed
# at api/dist/api/bootstrap. We zip it here so each `terraform apply` picks
# up code changes via source_code_hash.
data "archive_file" "lambda_zip" {
  type        = "zip"
  source_file = var.lambda_binary_path
  output_path = "${path.module}/.terraform-tmp/api.zip"
}

# ─── IAM ────────────────────────────────────────────────────────────────────

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.function_name}-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

# Basic CloudWatch Logs writer + the service-specific permissions below.
resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "lambda_inline" {
  # DynamoDB R/W on our single table + its GSIs.
  statement {
    sid = "DynamoDBReadWrite"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:BatchWriteItem",
      "dynamodb:TransactWriteItems",
    ]
    resources = [
      aws_dynamodb_table.this.arn,
      "${aws_dynamodb_table.this.arn}/index/*",
    ]
  }

  # SES SendEmail from our verified domain only. Scoping by source identity
  # ARN prevents this Lambda from spamming via any other verified domain in
  # the account (e.g. pennsieve-prod-admin domains).
  statement {
    sid       = "SESSend"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = ["*"] # SES doesn't support resource-level perms on send
    condition {
      test     = "StringLike"
      variable = "ses:FromAddress"
      values   = [var.email_from]
    }
  }

  # Read JWT signing secret + runtime-config toggles + reCAPTCHA secret.
  statement {
    sid     = "SSMReadConfig"
    actions = ["ssm:GetParameter"]
    resources = [
      aws_ssm_parameter.jwt_secret.arn,
      aws_ssm_parameter.allowlist_enabled.arn,
      aws_ssm_parameter.recaptcha_enabled.arn,
      aws_ssm_parameter.recaptcha_secret.arn,
      aws_ssm_parameter.dashboard_config.arn,
    ]
  }
}

resource "aws_iam_role_policy" "lambda_inline" {
  name   = "${local.function_name}-inline"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda_inline.json
}

# ─── Lambda function ────────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = 30
}

resource "aws_lambda_function" "this" {
  function_name = local.function_name
  description   = "Epilepsy CDE Explorer review API (single-Lambda router)."
  role          = aws_iam_role.lambda.arn

  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256

  # provided.al2023 expects a binary literally named `bootstrap` in the zip.
  runtime       = "provided.al2023"
  architectures = ["arm64"]
  handler       = "bootstrap"

  memory_size = 256
  timeout     = 10 # seconds; comfortable headroom over expected p99 ~500ms

  environment {
    variables = {
      TABLE_NAME          = aws_dynamodb_table.this.name
      JWT_SECRET_SSM_NAME = aws_ssm_parameter.jwt_secret.name
      EMAIL_FROM          = var.email_from
      EMAIL_FROM_NAME     = var.email_from_name
      APP_ORIGIN          = var.app_origin
      CODE_TTL_SECONDS    = tostring(var.code_ttl_seconds)
      TOKEN_TTL_SECONDS   = tostring(var.token_ttl_seconds)
      MAX_CODE_ATTEMPTS   = tostring(var.max_code_attempts)

      # Runtime-flippable toggles (Lambda reads via 60s-cached SSM).
      ALLOWLIST_TOGGLE_SSM_NAME = aws_ssm_parameter.allowlist_enabled.name
      RECAPTCHA_TOGGLE_SSM_NAME = aws_ssm_parameter.recaptcha_enabled.name
      RECAPTCHA_SECRET_SSM_NAME = aws_ssm_parameter.recaptcha_secret.name
      DASHBOARD_CONFIG_SSM_NAME = aws_ssm_parameter.dashboard_config.name

      RECAPTCHA_ACTION    = var.recaptcha_action
      RECAPTCHA_MIN_SCORE = tostring(var.recaptcha_min_score)

      REQUEST_CODE_MIN_INTERVAL_SECONDS = tostring(var.request_code_min_interval_seconds)
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.lambda, # ensure the LG exists before Lambda starts writing
    aws_iam_role_policy.lambda_inline,
    aws_iam_role_policy_attachment.lambda_logs,
  ]
}
