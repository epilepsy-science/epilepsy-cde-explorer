// Package handlers contains the route implementations as plain functions
// keyed off a shared *Services value (DynamoDB client, mailer, JWT service,
// runtime config cache, env). The Lambda entrypoint in cmd/api wires the
// route table.
package handlers

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"github.com/epilepsy-science/epilepsy-cde-explorer/api/internal/ddb"
	"github.com/epilepsy-science/epilepsy-cde-explorer/api/internal/env"
	"github.com/epilepsy-science/epilepsy-cde-explorer/api/internal/mailer"
	"github.com/epilepsy-science/epilepsy-cde-explorer/api/internal/runtimecfg"
	"github.com/epilepsy-science/epilepsy-cde-explorer/api/internal/tokens"
)

type Services struct {
	Cfg     env.Config
	DDB     *dynamodb.Client
	Mailer  *mailer.Mailer
	Tokens  *tokens.Service
	Runtime *runtimecfg.Cache
}

func New(ctx context.Context) (*Services, error) {
	cfg := env.MustLoad()

	dyn, err := ddb.New(ctx)
	if err != nil {
		return nil, err
	}
	ml, err := mailer.New(ctx, cfg.EmailFrom, cfg.EmailFromName, cfg.AppOrigin, int(cfg.CodeTTL.Minutes()))
	if err != nil {
		return nil, err
	}
	rt, err := runtimecfg.New(ctx)
	if err != nil {
		return nil, err
	}
	return &Services{
		Cfg:     cfg,
		DDB:     dyn,
		Mailer:  ml,
		Tokens:  tokens.NewService(cfg.JWTSecretSSMName, cfg.TokenTTL),
		Runtime: rt,
	}, nil
}
