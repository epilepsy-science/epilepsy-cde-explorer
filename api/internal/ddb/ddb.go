// Package ddb wraps the DynamoDB doc client and the project's single-table
// schema.
//
// Schema:
//
//	PK = REVIEWER#<email>     SK = PROFILE
//	                              AUTH                       (latest pending verification code, single-use)
//	                              REVIEW#<type>#<ref>#<dis>  (current review)
//	                              REVIEW_HISTORY#<type>#<ref>#<dis>#<v>  (append-only audit)
//	PK = INVITE#<email>       SK = META                      (allowlist gate)
//
//	GSI1: PK1 = `<type>#<ref>#<dis>`, SK1 = email             (all reviews of a target)
package ddb

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

// New returns a configured DynamoDB client. AWS_REGION is honored automatically.
func New(ctx context.Context) (*dynamodb.Client, error) {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("aws config: %w", err)
	}
	return dynamodb.NewFromConfig(cfg), nil
}

// ── Key builders ────────────────────────────────────────────────────────────

func ReviewerPK(email string) string { return "REVIEWER#" + email }
func InvitePK(email string) string   { return "INVITE#" + email }

const (
	SKProfile = "PROFILE"
	SKAuth    = "AUTH"
	SKMeta    = "META"
)

func ReviewSK(targetType, targetRef, disease string) string {
	return fmt.Sprintf("REVIEW#%s#%s#%s", targetType, targetRef, disease)
}

func ReviewHistorySK(targetType, targetRef, disease string, version int) string {
	return fmt.Sprintf("REVIEW_HISTORY#%s#%s#%s#%06d", targetType, targetRef, disease, version)
}

// ── Item shapes ─────────────────────────────────────────────────────────────

type Profile struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`

	Email            string   `dynamodbav:"email"`
	Name             string   `dynamodbav:"name"`
	PrimaryDiseases  []string `dynamodbav:"primary_diseases"`
	PrimaryStudyType string   `dynamodbav:"primary_study_type,omitempty"`
	CreatedAt        string   `dynamodbav:"created_at"`
	UpdatedAt        string   `dynamodbav:"updated_at"`
}

type Auth struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`

	CodeHash  string `dynamodbav:"code_hash"`
	ExpiresAt int64  `dynamodbav:"expires_at"` // epoch seconds; DynamoDB TTL field
	Attempts  int    `dynamodbav:"attempts"`
	IssuedAt  int64  `dynamodbav:"issued_at"` // epoch ms
}

// Invite is the allowlist row. Role gates admin endpoints.
type Invite struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`

	Email     string  `dynamodbav:"email"`
	Role      string  `dynamodbav:"role"` // "rev" | "admin"
	InvitedBy *string `dynamodbav:"invited_by,omitempty"`
	InvitedAt string  `dynamodbav:"invited_at"`
}

// Review is the current classification for a (reviewer, target, disease).
type Review struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`

	// GSI1 keys for the target_idx index. Empty on history rows so they
	// don't appear in the index — `omitempty` is load-bearing: DynamoDB
	// rejects empty strings on indexed attributes with a ValidationException
	// that aborts the whole TransactWrite.
	PK1 string `dynamodbav:"PK1,omitempty"` // `<type>#<ref>#<disease>`
	SK1 string `dynamodbav:"SK1,omitempty"` // email

	TargetType     string   `dynamodbav:"target_type"` // "cde" | "bundle"
	TargetRef      string   `dynamodbav:"target_ref"`
	Disease        string   `dynamodbav:"disease"`
	Classification string   `dynamodbav:"classification"`
	Comment        string   `dynamodbav:"comment,omitempty"`
	Flags          []string `dynamodbav:"flags,omitempty"`
	Version        int      `dynamodbav:"version"`
	CreatedAt      string   `dynamodbav:"created_at"`
	UpdatedAt      string   `dynamodbav:"updated_at"`
}

// Convenience for callers building items:
func StringPtr(s string) *string { return aws.String(s) }
