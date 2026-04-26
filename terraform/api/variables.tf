variable "region" {
  type        = string
  default     = "us-east-1"
  description = "AWS region for the API Lambda + DynamoDB + ACM cert."
}

variable "aws_profile" {
  type        = string
  default     = "pennsieve-dev-admin"
  description = "Profile that owns Lambda, DynamoDB, API Gateway, ACM cert, SSM (pennsieve-dev account)."
}

variable "dns_aws_profile" {
  type        = string
  default     = "pennsieve-cc-admin"
  description = "Profile that owns the Route 53 zone for the root domain (pennsieve-cc account)."
}

variable "environment" {
  type        = string
  default     = "dev"
  description = "Pennsieve env marker. Threaded into resource names."
}

variable "service_name" {
  type        = string
  default     = "epilepsy-cde-explorer-api"
  description = "Logical service name. Used in resource names + the Lambda function name."
}

variable "root_domain" {
  type        = string
  default     = "epilepsy.science"
  description = "Apex domain in Route 53 (lives in pennsieve-cc account)."
}

variable "subdomain_prefix" {
  type        = string
  default     = "api.cde"
  description = "Subdomain under root_domain — e.g. 'api.cde' → api.cde.epilepsy.science."
}

variable "app_origin" {
  type        = string
  default     = "https://cde.epilepsy.science"
  description = "Frontend origin. Used both for CORS allow_origins on the HTTP API and for the link in verification emails."
}

variable "lambda_binary_path" {
  type        = string
  default     = "../../api/dist/api/bootstrap"
  description = "Path (relative to this terraform module) of the compiled Lambda binary. Run `make -C api build` before `terraform apply`."
}

variable "email_from" {
  type        = string
  default     = "noreply@pennsieve.net"
  description = "SES verified sender. The pennsieve.net domain is verified in pennsieve-dev with production access."
}

variable "email_from_name" {
  type        = string
  default     = "Epilepsy CDE Explorer"
  description = "Display name on verification emails."
}

variable "code_ttl_seconds" {
  type        = number
  default     = 600 # 10 minutes
  description = "How long a verification code stays valid."
}

variable "token_ttl_seconds" {
  type        = number
  default     = 2592000 # 30 days
  description = "JWT lifetime."
}

variable "max_code_attempts" {
  type        = number
  default     = 5
  description = "Failed verify attempts before lockout — reviewer must request a new code."
}
