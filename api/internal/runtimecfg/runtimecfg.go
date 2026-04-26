// Package runtimecfg fetches operator-flippable config from SSM Parameter
// Store with a short TTL cache. Toggle a parameter via `aws ssm put-parameter`
// and the change propagates to warm Lambda containers within ~1 min — no
// redeploy needed.
//
// This is the right granularity for toggles like "allowlist-enabled" and
// "recaptcha-enabled" that the operator may want to flip during a soft-launch
// to wider-access transition. For full feature-flag tooling, AWS AppConfig
// is the heavier-but-richer alternative.
package runtimecfg

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
)

// TTL the cache for 60s — one extra SSM call per warm container per minute
// is cheap, and keeps fail-time bounded after a flip.
const cacheTTL = 60 * time.Second

type Cache struct {
	mu     sync.Mutex
	client *ssm.Client
	values map[string]cachedValue
}

type cachedValue struct {
	value     string
	fetchedAt time.Time
}

// New constructs a Cache. Pass a context to use for the AWS config load.
func New(ctx context.Context) (*Cache, error) {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, fmt.Errorf("aws config: %w", err)
	}
	return &Cache{
		client: ssm.NewFromConfig(cfg),
		values: make(map[string]cachedValue),
	}, nil
}

// Get returns the parameter value, fetching from SSM if absent or stale.
// Falls back to the cached value (even if stale) on transient SSM errors —
// preferable to failing every request when SSM has a hiccup.
func (c *Cache) Get(ctx context.Context, name string, withDecryption bool) (string, error) {
	c.mu.Lock()
	if v, ok := c.values[name]; ok && time.Since(v.fetchedAt) < cacheTTL {
		c.mu.Unlock()
		return v.value, nil
	}
	c.mu.Unlock()

	out, err := c.client.GetParameter(ctx, &ssm.GetParameterInput{
		Name:           aws.String(name),
		WithDecryption: aws.Bool(withDecryption),
	})
	c.mu.Lock()
	defer c.mu.Unlock()
	if err != nil {
		// Serve stale on transient errors — never thrash the live API.
		if v, ok := c.values[name]; ok {
			return v.value, nil
		}
		return "", fmt.Errorf("ssm get %s: %w", name, err)
	}
	if out.Parameter == nil || out.Parameter.Value == nil {
		return "", fmt.Errorf("ssm parameter %s is empty", name)
	}
	c.values[name] = cachedValue{value: *out.Parameter.Value, fetchedAt: time.Now()}
	return *out.Parameter.Value, nil
}

// Bool reads a parameter expected to hold "true"/"false". Anything not
// matching "true" (case-insensitive) is treated as false.
func (c *Cache) Bool(ctx context.Context, name string) (bool, error) {
	v, err := c.Get(ctx, name, false)
	if err != nil {
		return false, err
	}
	return v == "true" || v == "TRUE" || v == "True", nil
}
