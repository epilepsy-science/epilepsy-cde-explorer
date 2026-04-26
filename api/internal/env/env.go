// Package env validates required environment variables once at handler init
// (in main.go) so we fail fast on a misconfigured Lambda rather than
// surfacing a confusing nil-pointer mid-request.
package env

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	// Region — Lambda exposes this automatically.
	Region string

	// DynamoDB single-table name.
	Table string

	// SSM Parameter Store name (SecureString) holding the JWT signing secret.
	JWTSecretSSMName string

	// SES verified sender, e.g. noreply@pennsieve.net.
	EmailFrom     string
	EmailFromName string

	// Origin where the dashboard is served — used in email body links.
	AppOrigin string

	CodeTTL         time.Duration
	TokenTTL        time.Duration
	MaxCodeAttempts int

	// Operator-flippable toggles live in SSM (read at runtime, cached for
	// 60s in `runtimecfg.Cache`). The Lambda just needs the names.
	AllowlistToggleSSM string // SSM String, "true" / "false"
	RecaptchaToggleSSM string // SSM String, "true" / "false"
	RecaptchaSecretSSM string // SSM SecureString — Google reCAPTCHA secret key

	// reCAPTCHA bookkeeping (action name + minimum acceptable score)
	RecaptchaAction   string
	RecaptchaMinScore float64

	// Per-email "don't issue another code if one was issued in the last N
	// seconds" — protects against SES abuse when the allowlist is off.
	RequestCodeMinIntervalSec int
}

// MustLoad panics on missing/invalid required vars. Call at module init in main.go.
func MustLoad() Config {
	c := Config{
		Region:          requireEnv("AWS_REGION"),
		Table:           requireEnv("TABLE_NAME"),
		JWTSecretSSMName: requireEnv("JWT_SECRET_SSM_NAME"),
		EmailFrom:       requireEnv("EMAIL_FROM"),
		EmailFromName:   optionalEnv("EMAIL_FROM_NAME", "Epilepsy CDE Explorer"),
		AppOrigin:       requireEnv("APP_ORIGIN"),
		CodeTTL:         optionalDurationSeconds("CODE_TTL_SECONDS", 600),
		TokenTTL:        optionalDurationSeconds("TOKEN_TTL_SECONDS", 30*24*60*60),
		MaxCodeAttempts: optionalInt("MAX_CODE_ATTEMPTS", 5),

		AllowlistToggleSSM: requireEnv("ALLOWLIST_TOGGLE_SSM_NAME"),
		RecaptchaToggleSSM: requireEnv("RECAPTCHA_TOGGLE_SSM_NAME"),
		RecaptchaSecretSSM: requireEnv("RECAPTCHA_SECRET_SSM_NAME"),

		RecaptchaAction:   optionalEnv("RECAPTCHA_ACTION", "request_code"),
		RecaptchaMinScore: optionalFloat("RECAPTCHA_MIN_SCORE", 0.5),

		RequestCodeMinIntervalSec: optionalInt("REQUEST_CODE_MIN_INTERVAL_SECONDS", 60),
	}
	return c
}

func optionalFloat(name string, fallback float64) float64 {
	v := os.Getenv(name)
	if v == "" {
		return fallback
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		panic(fmt.Sprintf("env %s is not a number: %q", name, v))
	}
	return f
}

func requireEnv(name string) string {
	v := os.Getenv(name)
	if v == "" {
		panic(fmt.Sprintf("missing required env var: %s", name))
	}
	return v
}

func optionalEnv(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func optionalInt(name string, fallback int) int {
	v := os.Getenv(name)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		panic(fmt.Sprintf("env %s is not an integer: %q", name, v))
	}
	return n
}

func optionalDurationSeconds(name string, fallbackSeconds int) time.Duration {
	return time.Duration(optionalInt(name, fallbackSeconds)) * time.Second
}
