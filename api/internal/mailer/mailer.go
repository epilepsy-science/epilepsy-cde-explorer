// Package mailer sends transactional email through SES.
//
// The deploy account (pennsieve-dev) has SES production access for the
// `pennsieve.net` domain — we send from `noreply@pennsieve.net` directly,
// no cross-account assumption needed.
package mailer

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ses"
	"github.com/aws/aws-sdk-go-v2/service/ses/types"
)

type Mailer struct {
	client    *ses.Client
	from      string
	fromName  string
	appOrigin string
	codeTTLm  int // code TTL in minutes, used in body copy
}

func New(ctx context.Context, from, fromName, appOrigin string, codeTTLMinutes int) (*Mailer, error) {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("aws config: %w", err)
	}
	return &Mailer{
		client:    ses.NewFromConfig(cfg),
		from:      from,
		fromName:  fromName,
		appOrigin: appOrigin,
		codeTTLm:  codeTTLMinutes,
	}, nil
}

func (m *Mailer) SendVerificationCode(ctx context.Context, toEmail, code string) error {
	subject := fmt.Sprintf("Your verification code: %s", code)
	text := m.renderText(code)
	html := m.renderHTML(code)

	source := fmt.Sprintf("%s <%s>", m.fromName, m.from)
	_, err := m.client.SendEmail(ctx, &ses.SendEmailInput{
		Source:      aws.String(source),
		Destination: &types.Destination{ToAddresses: []string{toEmail}},
		Message: &types.Message{
			Subject: &types.Content{Data: aws.String(subject), Charset: aws.String("UTF-8")},
			Body: &types.Body{
				Text: &types.Content{Data: aws.String(text), Charset: aws.String("UTF-8")},
				Html: &types.Content{Data: aws.String(html), Charset: aws.String("UTF-8")},
			},
		},
	})
	return err
}

func (m *Mailer) renderText(code string) string {
	return fmt.Sprintf(
		"Your verification code is: %s\n\nEnter it on %s to finish signing in.\n\nThis code expires in %d minutes.\nIf you didn't request this, you can ignore this email.",
		code, m.appOrigin, m.codeTTLm,
	)
}

func (m *Mailer) renderHTML(code string) string {
	return fmt.Sprintf(
		`<!doctype html><html><body style="font-family: -apple-system, system-ui, Segoe UI, Roboto, sans-serif; color: #333; line-height: 1.55;">
  <p>Your verification code is:</p>
  <p style="font-size: 28px; font-weight: 700; letter-spacing: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f7f7f7; padding: 12px 16px; border-radius: 4px; display: inline-block;">%s</p>
  <p>Enter it on <a href="%s">%s</a> to finish signing in.</p>
  <p style="color: #888; font-size: 13px;">This code expires in %d minutes.<br>If you didn't request this, you can ignore this email.</p>
</body></html>`,
		code, m.appOrigin, m.appOrigin, m.codeTTLm,
	)
}
