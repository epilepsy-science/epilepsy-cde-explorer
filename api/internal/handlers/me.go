package handlers

import (
	"context"
	"errors"
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

// profileFields is the public view of a profile — drops DynamoDB key fields.
type profileFields struct {
	Email            string   `json:"email"`
	Name             string   `json:"name"`
	LinkedinURL      string   `json:"linkedin_url,omitempty"`
	PrimaryDiseases  []string `json:"primary_diseases"`
	PrimaryStudyType string   `json:"primary_study_type,omitempty"`
	CreatedAt        string   `json:"created_at,omitempty"`
	UpdatedAt        string   `json:"updated_at,omitempty"`
}

// ── GET /v1/me ──────────────────────────────────────────────────────────────

type meGetResp struct {
	profileFields
	Role string `json:"role"`
}

func GetMe(ctx context.Context, _ events.APIGatewayV2HTTPRequest, s *Services, caller apihttp.AuthContext) (any, error) {
	p, err := readProfileFields(ctx, s, caller.Email)
	if err != nil {
		return nil, apihttp.ServerError("Could not load profile")
	}
	if p == nil {
		return nil, apihttp.NotFound("Profile not set yet")
	}
	return meGetResp{profileFields: *p, Role: caller.Role}, nil
}

// ── PUT /v1/me ──────────────────────────────────────────────────────────────

// Constraints kept in sync with the dashboard's useDiseaseLens.ts.
var allowedDiseases = []string{"pte", "tbi", "sci", "neurotrauma", "epilepsy", "agnostic"}
var allowedStudyTypes = []string{"", "Clinical", "Preclinical"}

type mePutBody struct {
	Name             string   `json:"name"`
	LinkedinURL      string   `json:"linkedin_url"`
	PrimaryDiseases  []string `json:"primary_diseases"`
	PrimaryStudyType string   `json:"primary_study_type"`
}

func PutMe(ctx context.Context, req events.APIGatewayV2HTTPRequest, s *Services, caller apihttp.AuthContext) (any, error) {
	var body mePutBody
	if err := apihttp.ParseJSON(req, &body); err != nil {
		return nil, err
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		return nil, apihttp.BadRequest("name is required")
	}
	if len(name) > 200 {
		return nil, apihttp.BadRequest("name is too long (max 200 chars)")
	}
	if len(body.PrimaryDiseases) == 0 {
		return nil, apihttp.BadRequest("primary_diseases must contain at least one entry")
	}
	for _, d := range body.PrimaryDiseases {
		if !slices.Contains(allowedDiseases, d) {
			return nil, apihttp.BadRequest("primary_diseases contains an unknown value: " + d)
		}
	}
	if !slices.Contains(allowedStudyTypes, body.PrimaryStudyType) {
		return nil, apihttp.BadRequest("primary_study_type must be empty, Clinical, or Preclinical")
	}
	linkedin := strings.TrimSpace(body.LinkedinURL)
	if len(linkedin) > 500 {
		return nil, apihttp.BadRequest("linkedin_url is too long (max 500 chars)")
	}
	if linkedin != "" && !strings.HasPrefix(linkedin, "http://") && !strings.HasPrefix(linkedin, "https://") {
		return nil, apihttp.BadRequest("linkedin_url must start with http:// or https://")
	}

	now := time.Now().UTC().Format(time.RFC3339)
	createdAt, err := lookupCreatedAt(ctx, s, caller.Email)
	if err != nil {
		return nil, apihttp.ServerError("Could not check existing profile")
	}
	if createdAt == "" {
		createdAt = now
	}

	profile := ddb.Profile{
		PK:               ddb.ReviewerPK(caller.Email),
		SK:               ddb.SKProfile,
		Email:            caller.Email,
		Name:             name,
		LinkedinURL:      linkedin,
		PrimaryDiseases:  body.PrimaryDiseases,
		PrimaryStudyType: body.PrimaryStudyType,
		CreatedAt:        createdAt,
		UpdatedAt:        now,
	}
	item, err := attributevalue.MarshalMap(profile)
	if err != nil {
		return nil, apihttp.ServerError("Could not encode profile")
	}
	if _, err := s.DDB.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Cfg.Table),
		Item:      item,
	}); err != nil {
		return nil, apihttp.ServerError("Could not save profile")
	}
	return profileFields{
		Email:            profile.Email,
		Name:             profile.Name,
		LinkedinURL:      profile.LinkedinURL,
		PrimaryDiseases:  profile.PrimaryDiseases,
		PrimaryStudyType: profile.PrimaryStudyType,
		CreatedAt:        profile.CreatedAt,
		UpdatedAt:        profile.UpdatedAt,
	}, nil
}

func lookupCreatedAt(ctx context.Context, s *Services, email string) (string, error) {
	keyAV, err := attributevalue.MarshalMap(map[string]string{
		"PK": ddb.ReviewerPK(email),
		"SK": ddb.SKProfile,
	})
	if err != nil {
		return "", err
	}
	out, err := s.DDB.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:            aws.String(s.Cfg.Table),
		Key:                  keyAV,
		ProjectionExpression: aws.String("created_at"),
	})
	if err != nil {
		var rnf *dynamodbtypes.ResourceNotFoundException
		if errors.As(err, &rnf) {
			return "", nil
		}
		return "", err
	}
	if out.Item == nil {
		return "", nil
	}
	if v, ok := out.Item["created_at"].(*dynamodbtypes.AttributeValueMemberS); ok {
		return v.Value, nil
	}
	return "", nil
}

func readProfileFields(ctx context.Context, s *Services, email string) (*profileFields, error) {
	keyAV, err := attributevalue.MarshalMap(map[string]string{
		"PK": ddb.ReviewerPK(email),
		"SK": ddb.SKProfile,
	})
	if err != nil {
		return nil, err
	}
	out, err := s.DDB.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Cfg.Table),
		Key:       keyAV,
	})
	if err != nil || out.Item == nil {
		return nil, err
	}
	var p ddb.Profile
	if err := attributevalue.UnmarshalMap(out.Item, &p); err != nil {
		return nil, err
	}
	return &profileFields{
		Email:            p.Email,
		Name:             p.Name,
		LinkedinURL:      p.LinkedinURL,
		PrimaryDiseases:  p.PrimaryDiseases,
		PrimaryStudyType: p.PrimaryStudyType,
		CreatedAt:        p.CreatedAt,
		UpdatedAt:        p.UpdatedAt,
	}, nil
}

// ── DELETE /v1/me ───────────────────────────────────────────────────────────
//
// GDPR right-to-erasure. Deletes ALL items under PK=REVIEWER#<email>
// (profile, current reviews, review history, any pending AUTH row). Leaves
// the INVITE# row alone — that's the allowlist gate, separately managed.

type meDeleteResp struct {
	DeletedItems int `json:"deleted_items"`
}

func DeleteMe(ctx context.Context, _ events.APIGatewayV2HTTPRequest, s *Services, caller apihttp.AuthContext) (any, error) {
	pk := ddb.ReviewerPK(caller.Email)
	deleted := 0
	for {
		batch, err := queryReviewerKeys(ctx, s, pk)
		if err != nil {
			return nil, apihttp.ServerError("Could not list reviewer items")
		}
		if len(batch) == 0 {
			break
		}
		for _, chunk := range chunkOf(batch, 25) {
			if err := batchDelete(ctx, s, chunk); err != nil {
				return nil, apihttp.ServerError("Could not delete reviewer items")
			}
			deleted += len(chunk)
		}
	}
	return meDeleteResp{DeletedItems: deleted}, nil
}

func queryReviewerKeys(ctx context.Context, s *Services, pk string) ([]map[string]dynamodbtypes.AttributeValue, error) {
	out, err := s.DDB.Query(ctx, &dynamodb.QueryInput{
		TableName:              aws.String(s.Cfg.Table),
		KeyConditionExpression: aws.String("PK = :pk"),
		ExpressionAttributeValues: map[string]dynamodbtypes.AttributeValue{
			":pk": &dynamodbtypes.AttributeValueMemberS{Value: pk},
		},
		ProjectionExpression: aws.String("PK, SK"),
		Limit:                aws.Int32(100),
	})
	if err != nil {
		return nil, err
	}
	return out.Items, nil
}

func batchDelete(ctx context.Context, s *Services, keys []map[string]dynamodbtypes.AttributeValue) error {
	writes := make([]dynamodbtypes.WriteRequest, 0, len(keys))
	for _, k := range keys {
		writes = append(writes, dynamodbtypes.WriteRequest{DeleteRequest: &dynamodbtypes.DeleteRequest{Key: k}})
	}
	for {
		out, err := s.DDB.BatchWriteItem(ctx, &dynamodb.BatchWriteItemInput{
			RequestItems: map[string][]dynamodbtypes.WriteRequest{s.Cfg.Table: writes},
		})
		if err != nil {
			return err
		}
		next, ok := out.UnprocessedItems[s.Cfg.Table]
		if !ok || len(next) == 0 {
			return nil
		}
		writes = next
	}
}

func chunkOf[T any](xs []T, size int) [][]T {
	var out [][]T
	for i := 0; i < len(xs); i += size {
		end := i + size
		if end > len(xs) {
			end = len(xs)
		}
		out = append(out, xs[i:end])
	}
	return out
}
