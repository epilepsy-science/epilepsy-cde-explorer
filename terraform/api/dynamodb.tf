# Single-table store. Schema is documented in api/internal/ddb/ddb.go and the
# api/README.md — keys are not enforced at the table level (NoSQL), just by
# the application layer.
#
# `expires_at` is the TTL field, set on AUTH rows (verification codes) so
# DynamoDB autopurges them ~10 minutes after issuance. Other rows omit this
# attribute and live forever.
#
# GSI `target_idx` makes "all reviews of <type>#<ref>#<disease>" + the admin
# export Scan efficient. Only current REVIEW rows project into the index
# (history rows leave PK1/SK1 empty by design).

resource "aws_dynamodb_table" "this" {
  name         = "${var.environment}-${var.service_name}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }
  attribute {
    name = "SK"
    type = "S"
  }
  attribute {
    name = "PK1"
    type = "S"
  }
  attribute {
    name = "SK1"
    type = "S"
  }

  global_secondary_index {
    name            = "target_idx"
    hash_key        = "PK1"
    range_key       = "SK1"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }
}
