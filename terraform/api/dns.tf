# Custom domain + ACM cert + Route 53 records.
#
# Cross-account: the ACM cert lives in pennsieve-dev (with the API), but the
# Route 53 zone for epilepsy.science lives in pennsieve-cc. ACM validates
# via DNS records in the zone — we create those via the `aws.dns` aliased
# provider.

# ─── ACM cert ───────────────────────────────────────────────────────────────

resource "aws_acm_certificate" "this" {
  domain_name       = local.fqdn
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# DNS validation records — one per validation option. Created in the cc
# account where the zone lives.
data "aws_route53_zone" "this" {
  provider     = aws.dns
  name         = "${var.root_domain}."
  private_zone = false
}

resource "aws_route53_record" "cert_validation" {
  provider = aws.dns
  for_each = {
    for opt in aws_acm_certificate.this.domain_validation_options :
    opt.domain_name => {
      name   = opt.resource_record_name
      record = opt.resource_record_value
      type   = opt.resource_record_type
    }
  }

  zone_id         = data.aws_route53_zone.this.zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 300
  records         = [each.value.record]
  allow_overwrite = true
}

# Block until the cert is fully validated. Saves a partial-failure surprise
# on first apply where the API domain mapping would otherwise fail.
resource "aws_acm_certificate_validation" "this" {
  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# ─── API Gateway custom domain ──────────────────────────────────────────────

resource "aws_apigatewayv2_domain_name" "this" {
  domain_name = local.fqdn

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.this.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "this" {
  api_id      = aws_apigatewayv2_api.this.id
  domain_name = aws_apigatewayv2_domain_name.this.id
  stage       = aws_apigatewayv2_stage.default.id
}

# ─── Public-facing alias record ─────────────────────────────────────────────
# `api.cde.epilepsy.science` → API Gateway custom-domain-target. ALIAS
# (zero TTL latency on flips), in the cc account where the zone lives.

resource "aws_route53_record" "api" {
  provider = aws.dns
  zone_id  = data.aws_route53_zone.this.zone_id
  name     = local.fqdn
  type     = "A"

  alias {
    name                   = aws_apigatewayv2_domain_name.this.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.this.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}
