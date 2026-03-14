# Goose OCA Bridge Runtime Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the `goose-oca-auth` scaffold into a working env-driven OCA bridge that can discover models, refresh tokens, and proxy chat completions for Goose.

**Architecture:** Keep auth/discovery logic in `oca-auth-core`, and make the bridge a thin runtime wrapper around it. The bridge owns env configuration, token/session caching, OpenAI-compatible route shaping, and request proxying to the discovered OCA upstream.

**Tech Stack:** Bun, TypeScript ESM, Bun test, `oca-auth-core`

---

### Task 1: Add session and proxy tests

**Files:**
- Modify: `test/app.test.ts`
- Create: `test/session.test.ts`

**Step 1: Write the failing test**

Add tests for token refresh, model discovery, and chat completion proxying.

**Step 2: Run test to verify it fails**

Run: `bun test test/app.test.ts test/session.test.ts`
Expected: FAIL because the runtime session and proxy behavior do not exist yet.

**Step 3: Write minimal implementation**

Add session methods and route behavior until the tests pass.

**Step 4: Run test to verify it passes**

Run: `bun test test/app.test.ts test/session.test.ts`
Expected: PASS.

### Task 2: Implement env-based auth session

**Files:**
- Modify: `src/config.ts`
- Modify: `src/runtime/session.ts`

**Step 1: Write the failing test**

Cover API-key passthrough, expired-token refresh, and discovery caching.

**Step 2: Run test to verify it fails**

Run: `bun test test/session.test.ts`
Expected: FAIL.

**Step 3: Write minimal implementation**

Add bridge config fields for access token, refresh token, expiry, and upstream override. Implement a session object that refreshes only when needed and caches discovered provider data.

**Step 4: Run test to verify it passes**

Run: `bun test test/session.test.ts`
Expected: PASS.

### Task 3: Implement live models and chat proxy routes

**Files:**
- Modify: `src/app.ts`
- Modify: `src/routes/models.ts`
- Modify: `src/routes/chat-completions.ts`

**Step 1: Write the failing test**

Cover `GET /v1/models` returning discovered models and `POST /v1/chat/completions` forwarding the request with auth headers.

**Step 2: Run test to verify it fails**

Run: `bun test test/app.test.ts`
Expected: FAIL.

**Step 3: Write minimal implementation**

Use the session to discover models and proxy chat completions to the first working upstream endpoint.

**Step 4: Run test to verify it passes**

Run: `bun test test/app.test.ts`
Expected: PASS.

### Task 4: Verify end-to-end behavior

**Files:**
- Modify: `README.md`

**Step 1: Run tests**

Run: `bun test`
Expected: PASS.

**Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS.

**Step 3: Verify upstream shared repo still passes**

Run: `bun test`
Workdir: `/Users/yezha/p/opencode-oca-auth`
Expected: PASS.
