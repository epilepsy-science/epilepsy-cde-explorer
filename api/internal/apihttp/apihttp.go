// Package apihttp wraps API Gateway HTTP API v2 request/response plumbing.
// Handlers stay focused on business logic; this package handles the
// request decode, error → response mapping, and JSON encode.
package apihttp

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/aws/aws-lambda-go/events"
)

type Response = events.APIGatewayV2HTTPResponse

// HTTPError is the canonical error type — handlers return one of these (or
// any error; non-HTTPError errors get mapped to 500).
type HTTPError struct {
	Status  int    // HTTP status code
	Code    string // short snake_case code for clients to switch on
	Message string // human-readable
}

func (e *HTTPError) Error() string { return e.Message }

func New(status int, code, message string) *HTTPError {
	return &HTTPError{Status: status, Code: code, Message: message}
}

func BadRequest(message string) *HTTPError      { return New(http.StatusBadRequest, "bad_request", message) }
func Unauthorized(message string) *HTTPError    { return New(http.StatusUnauthorized, "unauthorized", message) }
func Forbidden(message string) *HTTPError       { return New(http.StatusForbidden, "forbidden", message) }
func NotFound(message string) *HTTPError        { return New(http.StatusNotFound, "not_found", message) }
func TooManyRequests(message string) *HTTPError { return New(http.StatusTooManyRequests, "too_many_requests", message) }
func ServerError(message string) *HTTPError     { return New(http.StatusInternalServerError, "internal_error", message) }

// Render serializes a body to JSON with status 200. CORS headers come from
// the API Gateway HTTP API config (set in Terraform), not here.
func Render(body any) Response {
	return RenderStatus(http.StatusOK, body)
}

// RenderStatus is Render with a custom status — useful for 201/204/etc.
func RenderStatus(status int, body any) Response {
	if body == nil {
		return Response{StatusCode: status}
	}
	buf, err := json.Marshal(body)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, "internal_error", "Failed to encode response")
	}
	return Response{
		StatusCode: status,
		Headers:    map[string]string{"content-type": "application/json"},
		Body:       string(buf),
	}
}

// RenderError maps an error to a structured JSON response. HTTPError values
// preserve their status/code/message; anything else becomes 500.
func RenderError(err error) Response {
	var herr *HTTPError
	if errors.As(err, &herr) {
		return errorResponse(herr.Status, herr.Code, herr.Message)
	}
	return errorResponse(http.StatusInternalServerError, "internal_error", "Internal error")
}

func errorResponse(status int, code, message string) Response {
	body, _ := json.Marshal(map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
	return Response{
		StatusCode: status,
		Headers:    map[string]string{"content-type": "application/json"},
		Body:       string(body),
	}
}

// ParseJSON decodes the request body into v, returning a 400 on bad input.
func ParseJSON(req events.APIGatewayV2HTTPRequest, v any) error {
	if req.Body == "" {
		return BadRequest("Missing request body")
	}
	raw := []byte(req.Body)
	if req.IsBase64Encoded {
		decoded, err := base64.StdEncoding.DecodeString(req.Body)
		if err != nil {
			return BadRequest("Body is not valid base64")
		}
		raw = decoded
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return BadRequest("Body is not valid JSON")
	}
	return nil
}

var emailRegexp = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

// NormalizeEmail trims, lowercases, and validates an email string.
func NormalizeEmail(raw string) (string, error) {
	v := strings.ToLower(strings.TrimSpace(raw))
	if !emailRegexp.MatchString(v) {
		return "", BadRequest("email is not valid")
	}
	return v, nil
}

// AuthContext is what protected handlers receive — populated by the
// dispatcher in cmd/api/main.go after JWT verification.
type AuthContext struct {
	Email string // JWT subject — verified reviewer email
	Role  string // "rev" | "admin"
}

// RequireAdmin gates admin endpoints. Returns Forbidden if role isn't admin.
func RequireAdmin(c AuthContext) error {
	if c.Role != "admin" {
		return Forbidden("Admin role required")
	}
	return nil
}
