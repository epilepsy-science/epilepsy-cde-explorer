package handlers

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/aws/aws-lambda-go/events"
)

// ── GET /v1/dashboard-config ────────────────────────────────────────────────
//
// Public endpoint the dashboard fetches once at boot. Returns runtime config
// the operator can flip via SSM without a redeploy:
//
//   - review_scope: which targets are open for review
//   - enabled_sources: which data sources contribute to what's visible
//
// When the SSM parameter is empty or unparseable, we fall back to the
// permissive defaults (all open / all sources). The Lambda doesn't refuse
// to serve in that case — silent permissive behavior matches today's
// "everything is reviewable".

type ReviewScope struct {
	AllOpen bool     `json:"all_open"`
	CDEs    []string `json:"cdes"`
	Bundles []string `json:"bundles"`
}

type DashboardConfigResponse struct {
	ReviewScope     ReviewScope `json:"review_scope"`
	EnabledSources  []string    `json:"enabled_sources"`
}

func DashboardConfig(ctx context.Context, _ events.APIGatewayV2HTTPRequest, s *Services) (any, error) {
	resp := DashboardConfigResponse{
		ReviewScope:    ReviewScope{AllOpen: true, CDEs: []string{}, Bundles: []string{}},
		EnabledSources: []string{},
	}

	raw, err := s.Runtime.Get(ctx, s.Cfg.DashboardConfigSSM, false)
	if err != nil {
		slog.Error("dashboard-config SSM read failed; serving permissive defaults", "err", err)
		return resp, nil
	}
	if raw == "" {
		return resp, nil
	}

	var parsed DashboardConfigResponse
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		slog.Warn("dashboard-config JSON unparseable; serving permissive defaults", "err", err)
		return resp, nil
	}

	// Normalize nil slices to empty so the JSON response is always
	// shape-stable for the dashboard's TS client.
	if parsed.ReviewScope.CDEs == nil {
		parsed.ReviewScope.CDEs = []string{}
	}
	if parsed.ReviewScope.Bundles == nil {
		parsed.ReviewScope.Bundles = []string{}
	}
	if parsed.EnabledSources == nil {
		parsed.EnabledSources = []string{}
	}
	return parsed, nil
}
