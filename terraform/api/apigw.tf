locals {
  fqdn = "${var.subdomain_prefix}.${var.root_domain}"

  # Route table — keeps the Terraform list in sync with cmd/api/main.go.
  routes = [
    "POST /v1/auth/request-code",
    "POST /v1/auth/verify-code",
    "GET /v1/me",
    "PUT /v1/me",
    "DELETE /v1/me",
    "POST /v1/reviews",
    "GET /v1/reviews/me",
    "GET /v1/admin/export",
  ]
}

# ─── HTTP API ───────────────────────────────────────────────────────────────

resource "aws_apigatewayv2_api" "this" {
  name          = local.function_name
  protocol_type = "HTTP"
  description   = "Epilepsy CDE Explorer review API."

  # CORS lets the dashboard at https://cde.epilepsy.science talk to the API
  # without its own CORS handler in Lambda. Browser preflight is handled
  # entirely at the gateway.
  cors_configuration {
    allow_origins  = [var.app_origin]
    allow_methods  = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers  = ["content-type", "authorization"]
    expose_headers = []
    max_age        = 600
  }
}

# Single AWS_PROXY integration — every route forwards to the same Lambda,
# which dispatches off `event.routeKey` itself.
resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.this.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 10000
}

resource "aws_apigatewayv2_route" "routes" {
  for_each  = toset(local.routes)
  api_id    = aws_apigatewayv2_api.this.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

# Auto-deployed default stage — we don't need explicit deployments.
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
