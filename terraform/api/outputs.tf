output "api_url" {
  description = "Public URL of the API. Use this as the API base URL in the dashboard."
  value       = "https://${local.fqdn}"
}

output "lambda_function_name" {
  description = "Lambda function name. Useful for `aws logs tail` during debugging."
  value       = aws_lambda_function.this.function_name
}

output "lambda_log_group" {
  description = "CloudWatch log group for the Lambda."
  value       = aws_cloudwatch_log_group.lambda.name
}

output "apigw_log_group" {
  description = "CloudWatch log group for the HTTP API access logs."
  value       = aws_cloudwatch_log_group.apigw.name
}

output "dynamodb_table" {
  description = "DynamoDB single-table name."
  value       = aws_dynamodb_table.this.name
}

output "jwt_secret_ssm_name" {
  description = "SSM parameter holding the JWT signing secret."
  value       = aws_ssm_parameter.jwt_secret.name
}
