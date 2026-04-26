# `api/` — Go Lambda backend

Single Lambda behind API Gateway HTTP API v2. Routes are dispatched by
`RouteKey` ("METHOD /path") in `cmd/api/main.go`; each handler is a plain
function in `internal/handlers/*.go`.

## Why one Lambda instead of one per route

For our scale (sporadic traffic, ~10–50 reviewers), the "Lambdalith" wins:

- **Cold starts amortize.** First request warms one container that serves
  every subsequent route — instead of nine cold pools, one each.
- **Shared init.** One DynamoDB client, one SES client, one cached JWT
  signing key fetched from SSM. Cold-start init cost paid once per container.
- **Fewer moving parts in Terraform.** One Lambda, one IAM role, one log
  group, one alias.

Trade-off: coarser IAM scoping (the role grants DynamoDB R/W + SES Send +
SSM Read all together — same as the bounded service needs anyway), and one
shared concurrency limit across routes.

## Layout

```
api/
├── cmd/api/main.go                 single Lambda entrypoint, route table, JWT middleware
├── internal/
│   ├── apihttp/                    request/response plumbing, error helpers, AuthContext
│   ├── codes/                      6-digit code gen + sha256 hash + constant-time compare
│   ├── ddb/                        DynamoDB client + single-table key builders + item types
│   ├── env/                        env var validation (panics fast on misconfig)
│   ├── mailer/                     SES SendEmail wrapper
│   ├── tokens/                     JWT sign/verify, signing key cached from SSM
│   └── handlers/
│       ├── services.go             constructs DDB / Mailer / Tokens once at init
│       ├── auth.go                 RequestCode, VerifyCode
│       ├── me.go                   GetMe, PutMe, DeleteMe
│       ├── reviews.go              PostReview, ListMyReviews
│       └── admin.go                AdminExport
├── go.mod / go.sum
└── Makefile                        builds dist/api/bootstrap
```

`internal/` is intentionally not `pkg/` — these helpers aren't for external
consumers and the Go compiler enforces that.

## Routes

| Route | Auth | Handler |
|---|---|---|
| `POST /v1/auth/request-code` | public | `handlers.RequestCode` |
| `POST /v1/auth/verify-code`  | public | `handlers.VerifyCode` |
| `GET /v1/me`                 | reviewer | `handlers.GetMe` |
| `PUT /v1/me`                 | reviewer | `handlers.PutMe` |
| `DELETE /v1/me`              | reviewer | `handlers.DeleteMe` |
| `POST /v1/reviews`           | reviewer | `handlers.PostReview` |
| `GET /v1/reviews/me`         | reviewer | `handlers.ListMyReviews` |
| `GET /v1/admin/export`       | admin    | `handlers.AdminExport` |

Adding a new endpoint = one line in `routes` map + the handler function.

## Single-table DynamoDB schema

```
PK = REVIEWER#<email>     SK = PROFILE
                              AUTH                       (latest pending verification code, single-use)
                              REVIEW#<type>#<ref>#<dis>  (current review)
                              REVIEW_HISTORY#<type>#<ref>#<dis>#<v>  (append-only audit)
PK = INVITE#<email>       SK = META                      (allowlist gate)

GSI1 `target_idx`: PK1 = `<type>#<ref>#<dis>`, SK1 = email   (all reviews of a target)
```

History rows leave PK1/SK1 empty so they don't appear in the GSI — admin
export can scan the GSI and see only current rows.

## Auth flow

1. `POST /v1/auth/request-code` `{email}` — checks the allowlist (`INVITE#`),
   generates a fresh 6-digit code, stores `sha256("<email>:<code>")` with a
   10-min TTL, sends via SES. Always returns 200 (no email enumeration).
2. `POST /v1/auth/verify-code` `{email, code}` — looks up the AUTH row,
   constant-time compares the hash, increments `attempts` on failure
   (lockout at 5), deletes on success, returns a 30-day JWT + the existing
   profile (if any).
3. Every other route reads `Authorization: Bearer <token>`, the dispatcher
   verifies it (HS256 signing key cached from SSM), and passes a verified
   `AuthContext{Email, Role}` to the handler.

## Build

```bash
make build          # → dist/api/bootstrap (single binary)
make tidy           # go mod tidy
make clean          # rm -rf dist
```

Requires Go ≥ 1.24 (the AWS SDK v2 dependency drops older versions). If your
default `go` is older, override per invocation:

```bash
make build GO=/path/to/go1.24/bin/go
```

Lambda runtime is `provided.al2023`; the binary must be named `bootstrap`.
GOARCH is `arm64` because Graviton Lambda is faster + cheaper.

## Required env vars (set on the Lambda in Terraform)

| Var | Purpose |
|---|---|
| `TABLE_NAME` | DynamoDB single-table name |
| `JWT_SECRET_SSM_NAME` | SSM Parameter (SecureString) holding the HS256 signing key |
| `EMAIL_FROM` | SES verified sender, e.g. `noreply@pennsieve.net` |
| `EMAIL_FROM_NAME` | Display name (default `Epilepsy CDE Explorer`) |
| `APP_ORIGIN` | URL where the frontend is served — used in email body |
| `CODE_TTL_SECONDS` | Default `600` |
| `TOKEN_TTL_SECONDS` | Default `2592000` (30 days) |
| `MAX_CODE_ATTEMPTS` | Default `5` |
| `AWS_REGION` | Set automatically by Lambda |
