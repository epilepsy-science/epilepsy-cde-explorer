// Package recaptcha verifies Google reCAPTCHA v3 tokens.
//
// v3 is invisible/score-based — the dashboard runs `grecaptcha.execute()` on
// the email-input form, which returns a token (~5 minute lifetime). The
// server POSTs the token + secret to Google; the response includes a
// `success` flag and a `score` from 0.0 (likely bot) to 1.0 (likely human).
//
// We accept tokens with score >= MinScore (default 0.5) and the matching
// `action` claim. Lower scores get rejected as 401 — visible to legitimate
// users in rare cases (privacy-extension users, Tor exits), but those users
// can retry; the false-positive rate is acceptable for a research tool.
package recaptcha

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	verifyURL = "https://www.google.com/recaptcha/api/siteverify"
	timeout   = 5 * time.Second
)

// Verifier holds the secret key + threshold; safe to share across handler
// invocations.
type Verifier struct {
	secret   string
	minScore float64
	action   string
	client   *http.Client
}

// New returns a Verifier. `expectedAction` is the action name set on
// `grecaptcha.execute(siteKey, {action})` — it MUST match.
func New(secret, expectedAction string, minScore float64) *Verifier {
	return &Verifier{
		secret:   secret,
		minScore: minScore,
		action:   expectedAction,
		client:   &http.Client{Timeout: timeout},
	}
}

type verifyResponse struct {
	Success     bool      `json:"success"`
	Score       float64   `json:"score"`
	Action      string    `json:"action"`
	ChallengeTS time.Time `json:"challenge_ts"`
	Hostname    string    `json:"hostname"`
	ErrorCodes  []string  `json:"error-codes"`
}

// Verify POSTs the token to Google. Returns nil on a successful, high-score
// response; a descriptive error otherwise.
func (v *Verifier) Verify(ctx context.Context, token, remoteIP string) error {
	if v.secret == "" {
		return fmt.Errorf("recaptcha secret not configured")
	}
	if token == "" {
		return fmt.Errorf("recaptcha token missing")
	}

	form := url.Values{
		"secret":   []string{v.secret},
		"response": []string{token},
	}
	if remoteIP != "" {
		form.Set("remoteip", remoteIP)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, verifyURL, strings.NewReader(form.Encode()))
	if err != nil {
		return fmt.Errorf("recaptcha request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := v.client.Do(req)
	if err != nil {
		return fmt.Errorf("recaptcha verify: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<14))
	if err != nil {
		return fmt.Errorf("recaptcha read: %w", err)
	}

	var out verifyResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return fmt.Errorf("recaptcha decode: %w", err)
	}
	if !out.Success {
		return fmt.Errorf("recaptcha rejected: %s", strings.Join(out.ErrorCodes, ","))
	}
	if out.Action != v.action {
		return fmt.Errorf("recaptcha action mismatch: got %q, expected %q", out.Action, v.action)
	}
	if out.Score < v.minScore {
		return fmt.Errorf("recaptcha score too low: %.2f < %.2f", out.Score, v.minScore)
	}
	return nil
}
