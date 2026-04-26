# Build each handler in cmd/ into dist/<handler>/bootstrap, ready for Terraform's
# archive_file to zip and upload to Lambda. Lambda's `provided.al2023` runtime
# expects a binary literally named `bootstrap`.
#
# Usage:
#   make            build all handlers
#   make build      same
#   make tidy       go mod tidy
#   make clean      remove dist/

HANDLERS := $(notdir $(wildcard cmd/*))
DIST     := dist

GOOS        := linux
GOARCH      := arm64    # arm64 Lambda is cheaper + faster on AWS Graviton
CGO_ENABLED := 0

# Override with GO=… if your default `go` is older than 1.24.
GO ?= go

GO_BUILD_ENV := GOOS=$(GOOS) GOARCH=$(GOARCH) CGO_ENABLED=$(CGO_ENABLED)
GO_BUILD_FLAGS := -trimpath -ldflags='-s -w'

.PHONY: build clean tidy all $(HANDLERS)

all: build
build: $(HANDLERS)

# Generate a phony per-handler target named `auth-request-code`, etc.
$(HANDLERS):
	@mkdir -p $(DIST)/$@
	$(GO_BUILD_ENV) $(GO) build $(GO_BUILD_FLAGS) -o $(DIST)/$@/bootstrap ./cmd/$@
	@echo "✓ $(DIST)/$@/bootstrap"

tidy:
	$(GO) mod tidy

clean:
	rm -rf $(DIST)
