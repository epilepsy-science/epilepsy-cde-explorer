variable "region" {
  type        = string
  default     = "us-east-1"
  description = "AWS region for the Amplify app and ACM cert."
}

variable "aws_profile" {
  type        = string
  default     = "pennsieve-dev-admin"
  description = "AWS profile that owns the Amplify app + ACM cert (pennsieve-dev account)."
}

variable "dns_aws_profile" {
  type        = string
  default     = "pennsieve-cc-admin"
  description = "AWS profile that owns the Route 53 zone for the root domain (pennsieve-cc account, where epilepsy.science lives)."
}

variable "environment" {
  type        = string
  default     = "dev"
  description = "Pennsieve environment marker (dev/prod). Threaded into resource names so each env stands alone."
}

variable "service_name" {
  type        = string
  default     = "epilepsy-cde-explorer"
  description = "Logical service name. Used in Amplify app name and Route 53 record names."
}

variable "github_repository" {
  type        = string
  default     = "https://github.com/epilepsy-science/epilepsy-cde-explorer"
  description = "Full HTTPS URL of the source repo Amplify will build from."
}

variable "production_branch" {
  type        = string
  default     = "main"
  description = "Branch Amplify treats as production (auto-build, public-facing)."
}

variable "root_domain" {
  type        = string
  default     = "epilepsy.science"
  description = "Apex domain managed in Route 53. The custom subdomain attaches under this."
}

variable "subdomain_prefix" {
  type        = string
  default     = "cde"
  description = "Subdomain prefix attached under root_domain — e.g. 'cde' → cde.epilepsy.science."
}

# Public reCAPTCHA v3 site key, baked into the dashboard bundle by Vite at
# build time. Tied to the cde.epilepsy.science domain registered in the
# Google reCAPTCHA admin console. Safe to commit (it's the public half;
# the secret half lives in SSM as recaptcha-secret).
variable "recaptcha_site_key" {
  type        = string
  default     = "6LeIAMwsAAAAAHC43_KP8uXnyLg8RU9cbt_9YoH7"
  description = "Google reCAPTCHA v3 site key for cde.epilepsy.science. Public; baked into the JS bundle."
}
