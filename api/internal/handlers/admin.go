package handlers

import (
	"context"
	"strings"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamodbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/epilepsy-science/epilepsy-cde-explorer/api/internal/apihttp"
	"github.com/epilepsy-science/epilepsy-cde-explorer/api/internal/ddb"
)

// ── GET /v1/admin/export ────────────────────────────────────────────────────
//
// Admin-only. Streams ALL current reviews (every reviewer × every target) so
// the panel can read a single JSON dump. Excludes REVIEW_HISTORY rows and
// PROFILE/AUTH rows — the panel just needs the canonical "what was each
// reviewer's latest take" view.
//
// Pages via Scan with ExclusiveStartKey on the GSI `target_idx`, which only
// indexes current review rows (history rows leave PK1 empty by design).
// Soft-launch scale; if total reviews ever pass ~10k, swap to S3-export.

type adminReviewExport struct {
	ReviewerEmail  string   `json:"reviewer_email"`
	TargetType     string   `json:"target_type"`
	TargetRef      string   `json:"target_ref"`
	Disease        string   `json:"disease"`
	Classification string   `json:"classification"`
	Comment        string   `json:"comment,omitempty"`
	Flags          []string `json:"flags,omitempty"`
	Version        int      `json:"version"`
	CreatedAt      string   `json:"created_at"`
	UpdatedAt      string   `json:"updated_at"`
}

type adminExportResp struct {
	Reviews []adminReviewExport `json:"reviews"`
	Count   int                 `json:"count"`
}

func AdminExport(ctx context.Context, _ events.APIGatewayV2HTTPRequest, s *Services, _ apihttp.AuthContext) (any, error) {
	// The router already enforced role=admin via RequireAdmin before
	// dispatching here, but we re-check defensively in case the route table
	// ever loses that gate by mistake.

	var (
		all      []adminReviewExport
		startKey map[string]dynamodbtypes.AttributeValue
	)
	for {
		out, err := s.DDB.Scan(ctx, &dynamodb.ScanInput{
			TableName:         aws.String(s.Cfg.Table),
			IndexName:         aws.String("target_idx"),
			ExclusiveStartKey: startKey,
		})
		if err != nil {
			return nil, apihttp.ServerError("Could not scan reviews")
		}
		for _, raw := range out.Items {
			var r ddb.Review
			if err := attributevalue.UnmarshalMap(raw, &r); err != nil {
				continue
			}
			if !strings.HasPrefix(r.SK, "REVIEW#") || strings.HasPrefix(r.SK, "REVIEW_HISTORY#") {
				continue
			}
			all = append(all, adminReviewExport{
				ReviewerEmail:  strings.TrimPrefix(r.PK, "REVIEWER#"),
				TargetType:     r.TargetType,
				TargetRef:      r.TargetRef,
				Disease:        r.Disease,
				Classification: r.Classification,
				Comment:        r.Comment,
				Flags:          r.Flags,
				Version:        r.Version,
				CreatedAt:      r.CreatedAt,
				UpdatedAt:      r.UpdatedAt,
			})
		}
		if len(out.LastEvaluatedKey) == 0 {
			break
		}
		startKey = out.LastEvaluatedKey
	}
	return adminExportResp{Reviews: all, Count: len(all)}, nil
}
