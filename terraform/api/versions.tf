terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.6"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State follows the existing Pennsieve convention. Distinct key from the
  # dashboard module so the two components apply independently — Lambda
  # changes don't block frontend changes and vice versa.
  backend "s3" {
    bucket       = "pennsieve-non-prod-terraform-state"
    key          = "aws/us-east-1/dev-epilepsy-cde-explorer-api-use1/dev/terraform.tfstate"
    region       = "us-east-1"
    profile      = "pennsieve-dev-admin"
    encrypt      = true
    use_lockfile = true
  }
}

# Default provider — owns DynamoDB, Lambda, API Gateway, ACM cert, SSM param.
provider "aws" {
  region  = var.region
  profile = var.aws_profile

  default_tags {
    tags = {
      Project     = "epilepsy-cde-explorer"
      Component   = "api"
      Environment = var.environment
      ManagedBy   = "terraform"
      Repo        = "github.com/epilepsy-science/epilepsy-cde-explorer"
    }
  }
}

# DNS lives in pennsieve-cc; the alias scopes Route 53 + ACM validation
# records to that account. Same pattern as the dashboard module.
provider "aws" {
  alias   = "dns"
  region  = var.region
  profile = var.dns_aws_profile
}
