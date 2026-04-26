package handlers

import (
	"context"
	"errors"
	"log/slog"
	"regexp"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	dynamodbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/epilepsy-science/epilepsy-cde-explorer/api/internal/apihttp"
	"github.com/epilepsy-science/epilepsy-cde-explorer/api/internal/codes"
	"github.com/epilepsy-science/epilepsy-cde-explorer/api/internal/ddb"
)

// ── POST /v1/auth/request-code ──────────────────────────────────────────────
//
// Always returns 200 regardless of allowlist membership — keeps this from
// being usable as an enumeration oracle. When the email IS allowlisted,
// generates a fresh 6-digit code, persists sha256("<email>:<code>") with a
// 10-min TTL, and sends the code via SES.

type requestCodeBody struct {
	Email string `json:"email"`
}
type requestCodeResp struct {
	Status string `json:"status"` // always "sent"
}

func RequestCode(ctx context.Context, req events.APIGatewayV2HTTPRequest, s *Services) (any, error) {
	var body requestCodeBody
	if err := apihttp.ParseJSON(req, &body); err != nil {
		return nil, err
	}
	email, err := apihttp.NormalizeEmail(body.Email)
	if err != nil {
		return nil, err
	}

	allowed, err := isAllowlisted(ctx, s, email)
	if err != nil {
		slog.Error("allowlist check failed", "email", email, "err", err)
		return nil, apihttp.ServerError("Could not process request")
	}
	if !allowed {
		slog.Info("request-code: email not allowlisted", "email", email)
		return requestCodeResp{Status: "sent"}, nil
	}

	code, err := codes.Generate()
	if err != nil {
		return nil, apihttp.ServerError("Could not generate code")
	}

	auth := ddb.Auth{
		PK:        ddb.ReviewerPK(email),
		SK:        ddb.SKAuth,
		CodeHash:  codes.Hash(email, code),
		ExpiresAt: time.Now().Add(s.Cfg.CodeTTL).Unix(),
		Attempts:  0,
		IssuedAt:  time.Now().UnixMilli(),
	}
	item, err := attributevalue.MarshalMap(auth)
	if err != nil {
		return nil, apihttp.ServerError("Could not encode auth row")
	}
	if _, err := s.DDB.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Cfg.Table),
		Item:      item,
	}); err != nil {
		slog.Error("PutItem AUTH failed", "email", email, "err", err)
		return nil, apihttp.ServerError("Could not store verification code")
	}

	if err := s.Mailer.SendVerificationCode(ctx, email, code); err != nil {
		slog.Error("SES send failed", "email", email, "err", err)
		return nil, apihttp.New(500, "send_failed", "Could not send verification email")
	}
	slog.Info("verification code sent", "email", email)
	return requestCodeResp{Status: "sent"}, nil
}

func isAllowlisted(ctx context.Context, s *Services, email string) (bool, error) {
	keyAV, err := attributevalue.MarshalMap(map[string]string{
		"PK": ddb.InvitePK(email),
		"SK": ddb.SKMeta,
	})
	if err != nil {
		return false, err
	}
	got, err := s.DDB.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:            aws.String(s.Cfg.Table),
		Key:                  keyAV,
		ProjectionExpression: aws.String("email"),
	})
	if err != nil {
		return false, err
	}
	return got.Item != nil, nil
}

// ── POST /v1/auth/verify-code ───────────────────────────────────────────────

type verifyCodeBody struct {
	Email string `json:"email"`
	Code  string `json:"code"`
}
type verifyCodeResp struct {
	Token     string         `json:"token"`
	ExpiresIn int            `json:"expires_in"`
	Profile   *profileFields `json:"profile,omitempty"`
	Role      string         `json:"role"`
}

var sixDigitRE = regexp.MustCompile(`^\d{6}$`)

func VerifyCode(ctx context.Context, req events.APIGatewayV2HTTPRequest, s *Services) (any, error) {
	var body verifyCodeBody
	if err := apihttp.ParseJSON(req, &body); err != nil {
		return nil, err
	}
	email, err := apihttp.NormalizeEmail(body.Email)
	if err != nil {
		return nil, err
	}
	if !sixDigitRE.MatchString(body.Code) {
		return nil, apihttp.BadRequest("code must be 6 digits")
	}

	auth, err := getAuth(ctx, s, email)
	if err != nil {
		return nil, apihttp.ServerError("Could not look up verification")
	}
	if auth == nil {
		return nil, apihttp.Unauthorized("No pending code for this email")
	}
	if auth.ExpiresAt < time.Now().Unix() {
		_ = deleteAuth(ctx, s, email)
		return nil, apihttp.Unauthorized("Code has expired — request a new one")
	}
	if auth.Attempts >= s.Cfg.MaxCodeAttempts {
		return nil, apihttp.TooManyRequests("Too many failed attempts — request a new code")
	}

	if !codes.Compare(auth.CodeHash, codes.Hash(email, body.Code)) {
		if bumpErr := bumpAttempts(ctx, s, email); bumpErr != nil {
			slog.Warn("bumpAttempts failed", "email", email, "err", bumpErr)
		}
		return nil, apihttp.Unauthorized("Code is incorrect")
	}

	// Single-use: delete the AUTH row before minting the token. If anything
	// after this fails, the user can simply request a new code.
	if err := deleteAuth(ctx, s, email); err != nil {
		slog.Warn("delete AUTH failed (token still issued)", "email", email, "err", err)
	}

	role, err := readRole(ctx, s, email)
	if err != nil {
		return nil, apihttp.ServerError("Could not read role")
	}
	jwtStr, err := s.Tokens.Sign(ctx, email, role)
	if err != nil {
		return nil, apihttp.ServerError("Could not sign token")
	}

	profile, err := readProfileFields(ctx, s, email)
	if err != nil {
		slog.Warn("read profile failed", "email", email, "err", err)
	}
	slog.Info("verify-code ok", "email", email, "role", role)
	return verifyCodeResp{
		Token:     jwtStr,
		ExpiresIn: int(s.Cfg.TokenTTL.Seconds()),
		Profile:   profile,
		Role:      role,
	}, nil
}

func getAuth(ctx context.Context, s *Services, email string) (*ddb.Auth, error) {
	keyAV, err := attributevalue.MarshalMap(map[string]string{
		"PK": ddb.ReviewerPK(email),
		"SK": ddb.SKAuth,
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
	var a ddb.Auth
	if err := attributevalue.UnmarshalMap(out.Item, &a); err != nil {
		return nil, err
	}
	return &a, nil
}

func bumpAttempts(ctx context.Context, s *Services, email string) error {
	keyAV, err := attributevalue.MarshalMap(map[string]string{
		"PK": ddb.ReviewerPK(email),
		"SK": ddb.SKAuth,
	})
	if err != nil {
		return err
	}
	_, err = s.DDB.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:           aws.String(s.Cfg.Table),
		Key:                 keyAV,
		UpdateExpression:    aws.String("ADD attempts :one"),
		ConditionExpression: aws.String("attribute_exists(PK)"),
		ExpressionAttributeValues: map[string]dynamodbtypes.AttributeValue{
			":one": &dynamodbtypes.AttributeValueMemberN{Value: "1"},
		},
	})
	var ccfe *dynamodbtypes.ConditionalCheckFailedException
	if errors.As(err, &ccfe) {
		return nil
	}
	return err
}

func deleteAuth(ctx context.Context, s *Services, email string) error {
	keyAV, err := attributevalue.MarshalMap(map[string]string{
		"PK": ddb.ReviewerPK(email),
		"SK": ddb.SKAuth,
	})
	if err != nil {
		return err
	}
	_, err = s.DDB.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Cfg.Table),
		Key:       keyAV,
	})
	return err
}

func readRole(ctx context.Context, s *Services, email string) (string, error) {
	keyAV, err := attributevalue.MarshalMap(map[string]string{
		"PK": ddb.InvitePK(email),
		"SK": ddb.SKMeta,
	})
	if err != nil {
		return "", err
	}
	out, err := s.DDB.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:                aws.String(s.Cfg.Table),
		Key:                      keyAV,
		ProjectionExpression:     aws.String("#r"),
		ExpressionAttributeNames: map[string]string{"#r": "role"},
	})
	if err != nil || out.Item == nil {
		return "rev", err
	}
	if rv, ok := out.Item["role"].(*dynamodbtypes.AttributeValueMemberS); ok && rv.Value == "admin" {
		return "admin", nil
	}
	return "rev", nil
}
