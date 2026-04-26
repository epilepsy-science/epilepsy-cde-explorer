terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }

  # S3 remote state — uses the shared Pennsieve non-prod state bucket.
  # State key follows the existing convention:
  #   aws/<region>/<env>-<service>-<region-suffix>/<env>/terraform.tfstate
  # S3-native locking (use_lockfile) replaces the DynamoDB lock table on
  # Terraform >= 1.10 — no extra table needed.
  backend "s3" {
    bucket       = "pennsieve-non-prod-terraform-state"
    key          = "aws/us-east-1/dev-epilepsy-cde-explorer-use1/dev/terraform.tfstate"
    region       = "us-east-1"
    profile      = "pennsieve-dev-admin"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile

  default_tags {
    tags = {
      Project     = "epilepsy-cde-explorer"
      Environment = var.environment
      ManagedBy   = "terraform"
      Repo        = "github.com/epilepsy-science/epilepsy-cde-explorer"
    }
  }
}

# DNS lives in a different AWS account (pennsieve-cc) than the Amplify app
# (pennsieve-dev). The aliased provider scopes Route 53 calls to the cc
# account, while everything else uses the default provider above.
provider "aws" {
  alias   = "dns"
  region  = var.region
  profile = var.dns_aws_profile
}
