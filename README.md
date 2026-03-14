# goose-oca-auth

OpenAI-compatible local bridge for using OCA models from Goose.

Current bridge behavior:

- `GET /health` returns readiness status
- `GET /v1/models` discovers OCA models through the shared core and returns an OpenAI-compatible model list
- `POST /v1/chat/completions` proxies requests to the first working OCA chat completions endpoint
- auto-refreshes expired access tokens when `OCA_REFRESH_TOKEN` is available
- `scripts/install-goose-oca-auth.js` installs a Goose custom-provider JSON that points Goose at the bridge

## Configuration

Supported environment variables:

- `GOOSE_OCA_HOST` - bind host, default `127.0.0.1`
- `GOOSE_OCA_PORT` - bind port, default `8787`
- `GOOSE_OCA_PROVIDER` - outward provider prefix, default `oca`
- `GOOSE_OCA_DEFAULT_MODEL` - fallback model id, default `oca/gpt-5.3-codex`
- `GOOSE_OCA_REQUEST_TIMEOUT_MS` - upstream discovery timeout, default `10000`
- `OCA_BASE_URL` - preferred upstream OCA base URL to probe first
- `OCA_API_KEY` - API key or bearer token for direct access mode
- `OCA_ACCESS_TOKEN` - OAuth access token for bridge-managed session mode
- `OCA_ACCESS_TOKEN_EXPIRES_AT` - token expiry as epoch milliseconds or ISO timestamp
- `OCA_REFRESH_TOKEN` - refresh token used for automatic access-token renewal
- `OCA_IDCS_URL` - optional OAuth issuer override
- `OCA_CLIENT_ID` - optional OAuth client id override

## Run

```bash
bun src/index.ts
```

## Install into Goose

This writes `oca_bridge.json` into Goose's `custom_providers` directory.

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
goose run --provider oca_bridge --model oca/gpt-5.3-codex --no-profile --no-session --text "Reply with exactly: ok"
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
