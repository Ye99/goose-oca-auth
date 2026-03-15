# goose-oca-auth

OpenAI-compatible local bridge for using OCA models from Goose via `POST /v1/responses`.

The installed Goose custom provider now advertises streaming Responses support, so Goose can stay on its expected streaming path instead of failing with `Non Streaming Request are not supported` against Responses-only bridges.

Current bridge behavior:

- `GET /health` returns readiness status
- `GET /v1/models` discovers OCA models through the shared core and returns an OpenAI-compatible model list
- `POST /v1/responses` proxies requests to the first working OCA responses endpoint
- auto-refreshes expired access tokens when `OCA_REFRESH_TOKEN` is available
- `scripts/install-goose-oca-auth.js` installs a Goose custom-provider JSON that points Goose at the bridge and marks Responses streaming as supported

## Configuration

Supported environment variables:

- `GOOSE_OCA_HOST` - bind host, default `127.0.0.1`
- `GOOSE_OCA_PORT` - bind port, default `8787`
- `GOOSE_OCA_PROVIDER` - outward provider prefix, default `oca`
- `GOOSE_OCA_DEFAULT_MODEL` - fallback model id, default `oca/gpt-5.4`
- `GOOSE_OCA_REQUEST_TIMEOUT_MS` - upstream request timeout, default `3600000` (1 hour)
- `OCA_BASE_URL` - preferred upstream OCA base URL to probe first
- `OCA_API_KEY` - API key or bearer token for direct access mode
- `OCA_ACCESS_TOKEN` - OAuth access token for bridge-managed session mode
- `OCA_ACCESS_TOKEN_EXPIRES_AT` - token expiry as epoch milliseconds or ISO timestamp
- `OCA_REFRESH_TOKEN` - refresh token used for automatic access-token renewal
- `OCA_IDCS_URL` - optional OAuth issuer override
- `OCA_CLIENT_ID` - optional OAuth client id override

## Run the bridge

```bash
bun src/index.ts
```

## Install into Goose

This writes `oca_bridge.json` into Goose's `custom_providers` directory, points Goose at the bridge's `/v1/responses` endpoint, and enables Goose's streaming Responses mode for the provider.

```bash
./scripts/install-goose-oca-auth.js
```

Optional arguments:

```bash
./scripts/install-goose-oca-auth.js <goose-config-dir> <bridge-base-url>
```

Example:

```bash
./scripts/install-goose-oca-auth.js ~/.config/goose http://127.0.0.1:8787
goose run --provider oca_bridge --model oca/gpt-5.4 --no-profile --no-session --text "Reply with exactly: ok"
```

## Goose v1.27.2 bug workaround

Goose custom providers support a `context_limit` field per model in the provider JSON, but Goose ignores it. When creating a `ModelConfig`, Goose calls `ModelConfig::new()` which reads `GOOSE_CONTEXT_LIMIT` via `std::env::var()` (process environment only), then `with_canonical_limits()` which checks a built-in canonical model registry. It never consults the `known_models` list from the provider registry where the custom provider's `context_limit` values are stored. Unrecognized models fall back to the hardcoded `DEFAULT_CONTEXT_LIMIT` of 128,000 tokens.

Relevant Goose source locations (commit `831cb9b`):

- [`model.rs:85`](https://github.com/block/goose/blob/831cb9bb82de6dec9ec1561c1e260309de11b1e6/crates/goose/src/model.rs#L85) — reads `GOOSE_CONTEXT_LIMIT` from `std::env::var()` only (not `config.yaml`)
- [`model.rs:8`](https://github.com/block/goose/blob/831cb9bb82de6dec9ec1561c1e260309de11b1e6/crates/goose/src/model.rs#L8) — `const DEFAULT_CONTEXT_LIMIT: usize = 128_000`
- [`builder.rs:384`](https://github.com/block/goose/blob/831cb9bb82de6dec9ec1561c1e260309de11b1e6/crates/goose-cli/src/session/builder.rs#L384) — creates `ModelConfig::new(&model_name).with_canonical_limits(&provider_name)` without looking up `known_models`

**Workaround:** `scripts/start-bridge.ts` writes a wrapper script at `~/.config/goose/goose-oca` that exports the correct `GOOSE_CONTEXT_LIMIT` as an environment variable before exec-ing goose. Launch goose through this wrapper instead of directly:

```bash
~/.config/goose/goose-oca session
```

## Development

```bash
bun install
bun test
bun run typecheck
```

The test suite includes a Goose CLI end-to-end regression that uses the installed `goose` binary on this host with isolated XDG directories.

This scaffold depends on the shared OCA auth core via a local path dependency:
`../opencode-oca-auth/packages/oca-auth-core`.
