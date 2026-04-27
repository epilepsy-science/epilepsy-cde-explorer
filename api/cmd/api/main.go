// cmd/api: single-Lambda entrypoint for the dashboard's review API.
//
// Why one Lambda instead of one per route:
//   - Cold starts amortize across endpoints — once a container's warm, every
//     route is fast.
//   - Shared in-memory clients (DynamoDB, SES, SSM-cached JWT key) pay init
//     once per container instead of once per function.
//   - Less Terraform: one Lambda, one IAM role, one log group, one alias.
//
// Routing:
//   API Gateway HTTP API delivers `RouteKey` like "POST /v1/auth/request-code".
//   We dispatch off that into `internal/handlers/*`. Public routes skip the
//   JWT check; protected routes parse the bearer token here and pass the
//   verified AuthContext to the handler.
package main

import (
	"context"
	"log/slog"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"

	"github.com/epilepsy-science/epilepsy-cde-explorer/api/internal/apihttp"
	"github.com/epilepsy-science/epilepsy-cde-explorer/api/internal/handlers"
)

// publicHandler runs without a JWT check.
type publicHandler func(context.Context, events.APIGatewayV2HTTPRequest, *handlers.Services) (any, error)

// authedHandler receives a verified AuthContext.
type authedHandler func(context.Context, events.APIGatewayV2HTTPRequest, *handlers.Services, apihttp.AuthContext) (any, error)

// route is one entry in the dispatch table. Exactly one of `pub`/`auth` is
// non-nil. `requireAdmin` further constrains authed routes.
type route struct {
	pub          publicHandler
	auth         authedHandler
	requireAdmin bool
}

// Routes are keyed by the API Gateway HTTP API RouteKey ("METHOD /path").
// Adding a new endpoint = one line here + the handler function.
var routes = map[string]route{
	"POST /v1/auth/request-code": {pub: handlers.RequestCode},
	"POST /v1/auth/verify-code":  {pub: handlers.VerifyCode},

	"GET /v1/dashboard-config": {pub: handlers.DashboardConfig},

	"GET /v1/me":    {auth: handlers.GetMe},
	"PUT /v1/me":    {auth: handlers.PutMe},
	"DELETE /v1/me": {auth: handlers.DeleteMe},

	"POST /v1/reviews":    {auth: handlers.PostReview},
	"GET /v1/reviews/me":  {auth: handlers.ListMyReviews},

	"GET /v1/admin/export": {auth: handlers.AdminExport, requireAdmin: true},
}

var services *handlers.Services

func init() {
	s, err := handlers.New(context.Background())
	if err != nil {
		// Lambda shows init failures in CloudWatch as `Init Error`. Crashing
		// here is correct — a misconfigured container shouldn't serve
		// requests.
		panic(err)
	}
	services = s
}

func dispatch(ctx context.Context, req events.APIGatewayV2HTTPRequest) (apihttp.Response, error) {
	r, ok := routes[req.RouteKey]
	if !ok {
		// Misconfigured route on the API Gateway side, or a path that should
		// 404 because the dashboard hit something stale.
		return apihttp.RenderError(apihttp.NotFound("No such route: " + req.RouteKey)), nil
	}

	if r.pub != nil {
		body, err := r.pub(ctx, req, services)
		if err != nil {
			return apihttp.RenderError(err), nil
		}
		return apihttp.Render(body), nil
	}

	// Authed route — verify JWT + extract claims, then dispatch.
	auth, err := authenticate(ctx, req)
	if err != nil {
		return apihttp.RenderError(err), nil
	}
	if r.requireAdmin {
		if err := apihttp.RequireAdmin(auth); err != nil {
			return apihttp.RenderError(err), nil
		}
	}
	body, err := r.auth(ctx, req, services, auth)
	if err != nil {
		return apihttp.RenderError(err), nil
	}
	return apihttp.Render(body), nil
}

// authenticate parses the Authorization: Bearer <token> header and verifies
// it. Returns a 401 HTTPError on any failure — token contents never leak.
func authenticate(ctx context.Context, req events.APIGatewayV2HTTPRequest) (apihttp.AuthContext, error) {
	raw := pickHeader(req.Headers, "authorization")
	if raw == "" {
		return apihttp.AuthContext{}, apihttp.Unauthorized("Missing Authorization header")
	}
	const prefix = "Bearer "
	low := strings.ToLower(raw)
	if !strings.HasPrefix(low, strings.ToLower(prefix)) {
		return apihttp.AuthContext{}, apihttp.Unauthorized("Authorization header must use Bearer scheme")
	}
	tokenStr := strings.TrimSpace(raw[len(prefix):])
	claims, err := services.Tokens.Verify(ctx, tokenStr)
	if err != nil {
		slog.Info("token rejected", "reason", err.Error())
		return apihttp.AuthContext{}, apihttp.Unauthorized("Invalid or expired token")
	}
	role := claims.Role
	if role == "" {
		role = "rev"
	}
	return apihttp.AuthContext{Email: claims.Subject, Role: role}, nil
}

// HTTP API delivers headers lower-cased today, but be defensive — case-insensitive lookup.
func pickHeader(h map[string]string, name string) string {
	for k, v := range h {
		if strings.EqualFold(k, name) {
			return v
		}
	}
	return ""
}

func main() {
	lambda.Start(dispatch)
}
