// Package tokens signs and verifies JWTs for the API.
//
// Signing key is fetched once per Lambda container from SSM Parameter Store
// (SecureString) and cached at package scope. Lambda init pays the read; the
// invocations get a hot key.
package tokens

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	"github.com/golang-jwt/jwt/v5"
)

const (
	RoleReviewer = "rev"
	RoleAdmin    = "admin"
)

type Claims struct {
	Role string `json:"role"`
	jwt.RegisteredClaims
}

// Service signs and verifies tokens. Construct once at handler init.
type Service struct {
	ssmName string
	ttl     time.Duration

	once sync.Once
	key  []byte
	err  error
}

// NewService doesn't fetch the key yet — that's lazy on first Sign/Verify.
func NewService(ssmParameterName string, ttl time.Duration) *Service {
	return &Service{ssmName: ssmParameterName, ttl: ttl}
}

func (s *Service) loadKey(ctx context.Context) ([]byte, error) {
	s.once.Do(func() {
		cfg, err := config.LoadDefaultConfig(ctx)
		if err != nil {
			s.err = fmt.Errorf("aws config: %w", err)
			return
		}
		client := ssm.NewFromConfig(cfg)
		out, err := client.GetParameter(ctx, &ssm.GetParameterInput{
			Name:           aws.String(s.ssmName),
			WithDecryption: aws.Bool(true),
		})
		if err != nil {
			s.err = fmt.Errorf("ssm GetParameter %s: %w", s.ssmName, err)
			return
		}
		if out.Parameter == nil || out.Parameter.Value == nil {
			s.err = fmt.Errorf("ssm parameter %s is empty", s.ssmName)
			return
		}
		s.key = []byte(*out.Parameter.Value)
	})
	return s.key, s.err
}

func (s *Service) Sign(ctx context.Context, subject, role string) (string, error) {
	key, err := s.loadKey(ctx)
	if err != nil {
		return "", err
	}
	now := time.Now()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, Claims{
		Role: role,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   subject,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(s.ttl)),
		},
	})
	return tok.SignedString(key)
}

func (s *Service) Verify(ctx context.Context, raw string) (*Claims, error) {
	key, err := s.loadKey(ctx)
	if err != nil {
		return nil, err
	}
	tok, err := jwt.ParseWithClaims(raw, &Claims{}, func(t *jwt.Token) (any, error) {
		if t.Method.Alg() != jwt.SigningMethodHS256.Alg() {
			return nil, fmt.Errorf("unexpected signing method: %s", t.Method.Alg())
		}
		return key, nil
	})
	if err != nil {
		return nil, fmt.Errorf("parse token: %w", err)
	}
	claims, ok := tok.Claims.(*Claims)
	if !ok || !tok.Valid {
		return nil, fmt.Errorf("invalid token")
	}
	return claims, nil
}
