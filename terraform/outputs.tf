output "amplify_app_id" {
  description = "Amplify App ID — useful for CLI / SDK calls and the AWS console URL."
  value       = aws_amplify_app.this.id
}

output "amplify_default_domain" {
  description = "Amplify-issued domain (always available, no DNS needed). Form: <app_id>.amplifyapp.com."
  value       = aws_amplify_app.this.default_domain
}

output "amplify_console_url" {
  description = "Direct link to the Amplify app in the AWS console."
  value       = "https://${var.region}.console.aws.amazon.com/amplify/apps/${aws_amplify_app.this.id}"
}

output "production_branch_url" {
  description = "Live URL of the production branch on the Amplify default domain."
  value       = "https://${var.production_branch}.${aws_amplify_app.this.default_domain}"
}

output "custom_domain_url" {
  description = "Public URL on the custom domain. May take 5–15 minutes after first apply for cert + DNS to converge."
  value       = "https://${var.subdomain_prefix}.${var.root_domain}"
}
