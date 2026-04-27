package handlers

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamodbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/epilepsy-science/epilepsy-cde-explorer/api/internal/apihttp"
	"github.com/epilepsy-science/epilepsy-cde-explorer/api/internal/ddb"
)

// ── POST /v1/reviews ────────────────────────────────────────────────────────
//
// Upserts a review for (current_reviewer, target_type, target_ref, disease).
// Each successful write also appends a REVIEW_HISTORY row in the same
// TransactWrite, so a reviewer's tier changes over time can be reconstructed
// for the panel report. Version increments per (reviewer, target).

var (
	allowedTargetTypes     = []string{"cde", "bundle"}
	allowedClassifications = []string{"Core", "Recommended", "Supplemental", "Not Applicable"}
)

const maxCommentLen = 2000

type postReviewBody struct {
	TargetType     string   `json:"target_type"`
	TargetRef      string   `json:"target_ref"`
	Disease        string   `json:"disease"`
	Classification string   `json:"classification"`
	Comment        string   `json:"comment,omitempty"`
	Flags          []string `json:"flags,omitempty"`
}

type reviewView struct {
	TargetType     string   `json:"target_type"`
	TargetRef      string   `json:"target_ref"`
	Disease        string   `json:"disease"`
	Classification string   `json:"classification"`
	Comment        string   `json:"comment,omitempty"`
	Flags          []string `json:"flags,omitempty"`
	Version        int      `json:"version"`
	CreatedAt      string   `json:"created_at,omitempty"`
	UpdatedAt      string   `json:"updated_at"`
}

func PostReview(ctx context.Context, req events.APIGatewayV2HTTPRequest, s *Services, caller apihttp.AuthContext) (any, error) {
	var body postReviewBody
	if err := apihttp.ParseJSON(req, &body); err != nil {
		return nil, err
	}
	if err := validateReview(&body); err != nil {
		return nil, err
	}

	now := time.Now().UTC().Format(time.RFC3339)
	existing, err := readReview(ctx, s, caller.Email, body.TargetType, body.TargetRef, body.Disease)
	if err != nil {
		return nil, apihttp.ServerError("Could not read existing review")
	}
	version := 1
	createdAt := now
	if existing != nil {
		version = existing.Version + 1
		createdAt = existing.CreatedAt
	}

	current := ddb.Review{
		PK:             ddb.ReviewerPK(caller.Email),
		SK:             ddb.ReviewSK(body.TargetType, body.TargetRef, body.Disease),
		PK1:            body.TargetType + "#" + body.TargetRef + "#" + body.Disease,
		SK1:            caller.Email,
		TargetType:     body.TargetType,
		TargetRef:      body.TargetRef,
		Disease:        body.Disease,
		Classification: body.Classification,
		Comment:        strings.TrimSpace(body.Comment),
		Flags:          dedupNonEmpty(body.Flags),
		Version:        version,
		CreatedAt:      createdAt,
		UpdatedAt:      now,
	}

	history := current
	history.SK = ddb.ReviewHistorySK(body.TargetType, body.TargetRef, body.Disease, version)
	history.PK1 = "" // history rows don't appear in the GSI
	history.SK1 = ""

	currentItem, err := attributevalue.MarshalMap(current)
	if err != nil {
		return nil, apihttp.ServerError("Could not encode review")
	}
	historyItem, err := attributevalue.MarshalMap(history)
	if err != nil {
		return nil, apihttp.ServerError("Could not encode history row")
	}
	if _, err := s.DDB.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []dynamodbtypes.TransactWriteItem{
			{Put: &dynamodbtypes.Put{TableName: aws.String(s.Cfg.Table), Item: currentItem}},
			{Put: &dynamodbtypes.Put{TableName: aws.String(s.Cfg.Table), Item: historyItem}},
		},
	}); err != nil {
		slog.Error("review TransactWrite failed", "email", caller.Email, "target_type", body.TargetType, "target_ref", body.TargetRef, "disease", body.Disease, "err", err)
		return nil, apihttp.ServerError("Could not write review")
	}

	return reviewView{
		TargetType:     current.TargetType,
		TargetRef:      current.TargetRef,
		Disease:        current.Disease,
		Classification: current.Classification,
		Comment:        current.Comment,
		Flags:          current.Flags,
		Version:        current.Version,
		CreatedAt:      current.CreatedAt,
		UpdatedAt:      current.UpdatedAt,
	}, nil
}

func validateReview(b *postReviewBody) error {
	if !slices.Contains(allowedTargetTypes, b.TargetType) {
		return apihttp.BadRequest("target_type must be 'cde' or 'bundle'")
	}
	if strings.TrimSpace(b.TargetRef) == "" {
		return apihttp.BadRequest("target_ref is required")
	}
	if !slices.Contains(allowedDiseases, b.Disease) {
		return apihttp.BadRequest("disease is not a known value")
	}
	if !slices.Contains(allowedClassifications, b.Classification) {
		return apihttp.BadRequest("classification must be Core, Recommended, Supplemental, or Not Applicable")
	}
	if len(b.Comment) > maxCommentLen {
		return apihttp.BadRequest("comment is too long (max 2000 chars)")
	}
	return nil
}

func readReview(ctx context.Context, s *Services, email, targetType, targetRef, disease string) (*ddb.Review, error) {
	keyAV, err := attributevalue.MarshalMap(map[string]string{
		"PK": ddb.ReviewerPK(email),
		"SK": ddb.ReviewSK(targetType, targetRef, disease),
	})
	if err != nil {
		return nil, err
	}
	out, err := s.DDB.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Cfg.Table),
		Key:       keyAV,
	})
	if err != nil {
		var rnf *dynamodbtypes.ResourceNotFoundException
		if errors.As(err, &rnf) {
			return nil, nil
		}
		return nil, err
	}
	if out.Item == nil {
		return nil, nil
	}
	var r ddb.Review
	if err := attributevalue.UnmarshalMap(out.Item, &r); err != nil {
		return nil, err
	}
	return &r, nil
}

func dedupNonEmpty(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		t := strings.TrimSpace(s)
		if t == "" {
			continue
		}
		if _, exists := seen[t]; exists {
			continue
		}
		seen[t] = struct{}{}
		out = append(out, t)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// ── GET /v1/reviews/me?disease=… ───────────────────────────────────────────

type listReviewsResp struct {
	Reviews []reviewView `json:"reviews"`
}

func ListMyReviews(ctx context.Context, req events.APIGatewayV2HTTPRequest, s *Services, caller apihttp.AuthContext) (any, error) {
	disease := strings.TrimSpace(req.QueryStringParameters["disease"])

	out, err := s.DDB.Query(ctx, &dynamodb.QueryInput{
		TableName:              aws.String(s.Cfg.Table),
		KeyConditionExpression: aws.String("PK = :pk AND begins_with(SK, :sk)"),
		ExpressionAttributeValues: map[string]dynamodbtypes.AttributeValue{
			":pk": &dynamodbtypes.AttributeValueMemberS{Value: ddb.ReviewerPK(caller.Email)},
			":sk": &dynamodbtypes.AttributeValueMemberS{Value: "REVIEW#"},
		},
	})
	if err != nil {
		return nil, apihttp.ServerError("Could not list reviews")
	}

	views := make([]reviewView, 0, len(out.Items))
	for _, raw := range out.Items {
		var r ddb.Review
		if err := attributevalue.UnmarshalMap(raw, &r); err != nil {
			continue
		}
		// begins_with(SK, "REVIEW#") matches "REVIEW#…" but NOT "REVIEW_HISTORY#…"
		// since the underscore comes after a different char. Defensive check anyway.
		if strings.HasPrefix(r.SK, "REVIEW_HISTORY#") {
			continue
		}
		if disease != "" && r.Disease != disease {
			continue
		}
		views = append(views, reviewView{
			TargetType:     r.TargetType,
			TargetRef:      r.TargetRef,
			Disease:        r.Disease,
			Classification: r.Classification,
			Comment:        r.Comment,
			Flags:          r.Flags,
			Version:        r.Version,
			UpdatedAt:      r.UpdatedAt,
		})
	}
	return listReviewsResp{Reviews: views}, nil
}
