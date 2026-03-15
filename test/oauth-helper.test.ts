import { expect, test } from "bun:test"

test("oauth helper uses the fixed localhost callback", async () => {
  const oauth = await import("../scripts/shared/oauth").catch(() => ({})) as {
    CALLBACK_PORT?: number
    CALLBACK_PATH?: string
    redirectUri?: string
  }

  expect(oauth.CALLBACK_PORT).toBe(48801)
  expect(oauth.CALLBACK_PATH).toBe("/auth/oca")
  expect(oauth.redirectUri).toBe("http://127.0.0.1:48801/auth/oca")
})

test("oauth helper escapes error content before rendering HTML", async () => {
  const oauth = await import("../scripts/shared/oauth").catch(() => ({})) as {
    buildOauthErrorHtml?: (title: string, message: string) => string
  }

  expect(oauth.buildOauthErrorHtml?.("Error", '<script>alert("xss")</script>')).toBe(
    "<h1>Error</h1><p>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</p>",
  )
})

test("oauth helper returns a success page that closes the tab", async () => {
  const oauth = await import("../scripts/shared/oauth").catch(() => ({})) as {
    buildOauthSuccessHtml?: () => string
  }

  expect(oauth.buildOauthSuccessHtml?.()).toContain("You can close this tab")
  expect(oauth.buildOauthSuccessHtml?.()).toContain("window.close()")
})
