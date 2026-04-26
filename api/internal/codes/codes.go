// Package codes generates and verifies short numeric verification codes.
//
// Codes are 6 numeric digits — short enough to type from email, but with
// 10^6 entropy. Combined with a 10-minute TTL and 5-attempt lockout, the
// brute-force surface is small.
//
// Persisted form is sha256("<email>:<code>") — salting by email prevents
// rainbow-table replay against a leaked DynamoDB snapshot.
package codes

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"math/big"
)

// Generate returns a 6-digit decimal code as a string ("000000" through "999999").
func Generate() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", fmt.Errorf("rand.Int: %w", err)
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

// Hash returns the hex sha256 of the email-salted code.
func Hash(email, code string) string {
	sum := sha256.Sum256([]byte(email + ":" + code))
	return hex.EncodeToString(sum[:])
}

// Compare is a constant-time comparison of two hex hashes.
func Compare(expectedHex, candidateHex string) bool {
	a, err := hex.DecodeString(expectedHex)
	if err != nil {
		return false
	}
	b, err := hex.DecodeString(candidateHex)
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(a, b) == 1
}
