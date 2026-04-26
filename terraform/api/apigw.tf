locals {
  fqdn = "${var.subdomain_prefix}.${var.root_domain}"

  # The OpenAPI spec at api/openapi.yaml is rendered with Lambda invoke ARN
  # substituted in. API Gateway HTTP API imports OpenAPI 3 directly via
  # `body` — every operation's `x-amazon-apigateway-integration` extension
  # points at this Lambda. Adding/removing routes is a spec-only edit.
  openapi_body = templatefile(
    "${path.module}/../../api/openapi.yaml",
    { lambda_invoke_arn = aws_lambda_function.this.invoke_arn },
  )
}

# ─── HTTP API ───────────────────────────────────────────────────────────────

resource "aws_apigatewayv2_api" "this" {
  name          = local.function_name
  protocol_type = "HTTP"
  description   = "Epilepsy CDE Explorer review API."

  body = local.openapi_body

  # CORS lives in TF (not the spec) so it's easy to extend with extra
  # origins (preview deploys, staging) without editing the spec.
  cors_configuration {
    allow_origins  = [var.app_origin]
    allow_methods  = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers  = ["content-type", "authorization"]
    expose_headers = []
    max_age        = 600
  }

  # When the spec changes, force a redeploy so new routes attach.
  lifecycle {
    create_before_destroy = false
  }
}

# Auto-deployed default stage — we don't need explicit deployments. Triggers
# a redeploy whenever the OpenAPI body or the integration target changes.
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.apigw.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      protocol       = "$context.protocol"
      responseLength = "$context.responseLength"
      integrationErr = "$context.integrationErrorMessage"
    })
  }
}

resource "aws_cloudwatch_log_group" "apigw" {
  name              = "/aws/apigateway/${local.function_name}"
  retention_in_days = 30
}

# Permission for API Gateway to invoke the Lambda. Source ARN scoped to this
# API so other APIs in the account can't accidentally invoke us.
resource "aws_lambda_permission" "apigw_invoke" {
  statement_id  = "AllowExecutionFromHTTPAPI"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}
