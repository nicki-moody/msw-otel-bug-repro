# MSW + OpenTelemetry: streaming requests lose their headers

When **OpenTelemetry's HTTP instrumentation** (`@opentelemetry/instrumentation-http`)
and **MSW** are both active, streaming `GET` requests (e.g. Server-Sent Events) reach
the destination **without their request headers** — including `Authorization`.

This broke the **LaunchDarkly Node SDK**: its flag-stream `GET` arrives with no key →
`401 Unauthorized` → the SDK never initialises → feature flags fall back to defaults.

This repo reproduces the bug and includes a one-line **fix patch for
`@mswjs/interceptors`**, applied automatically via pnpm `patchedDependencies`.

## Symptoms

- ✅ Regular requests (e.g. the SDK's analytics `POST` to `events.launchdarkly.com`) keep their headers.
- ❌ The streaming `GET` (`stream.launchdarkly.com/all`) loses its `Authorization` header → `401`.
- Only happens when **both** OTel and MSW are active. Each on its own is fine (so it's a dev-only problem — production typically runs OTel but not MSW).

## Run it

```bash
pnpm install
cp .env.example .env   # then set LAUNCHDARKLY_SDK_KEY
pnpm run repro         # OTel + MSW + LaunchDarkly SDK
```

You'll see the **bug**:

```
❌ FAILED: Authentication failed. Double check your SDK key.
```

The SDK's streaming `GET` reached LaunchDarkly with **no `Authorization` header** → `401`.

Control — MSW only, no OTel — succeeds, showing MSW alone is fine:

```bash
pnpm run repro:no-otel
```

### Verify the fix

Uncomment the `patchedDependencies` block in `pnpm-workspace.yaml` (it points at
[`patches/@mswjs__interceptors@0.41.9.patch`](patches/@mswjs__interceptors@0.41.9.patch)),
then:

```bash
pnpm install
pnpm run repro
# → ✅ SUCCESS: LaunchDarkly initialized
```

## Root cause

Both OTel and MSW wrap `http(s).request`. OTel normalises the SDK's
`request("https://…", { headers })` call into a **single options object** built from
Node's [`urlToHttpOptions()`](https://nodejs.org/api/url.html#urlurltohttpoptionsurl)
merged with the caller's options — so it carries URL fields (`hash`, `href`, `origin`, …)
**and** `headers`, and for a `GET` it has **no `method`**.

MSW's `normalizeClientRequestArgs` (in `@mswjs/interceptors`) then classifies that
object with this heuristic, meant to detect a legacy `url.parse()` URL:

```js
} else if ("hash" in args[0] && !("method" in args[0])) {
  const [legacyUrl] = args;
  // ...treats args[0] as a legacy URL...
  const resolvedUrl = new URL(legacyUrl.href);
  return normalizeClientRequestArgs(defaultProtocol, [resolvedUrl, args[1]]); // <- headers discarded
}
```

The OTel-shaped object matches (`hash` present, no `method`), so MSW treats it as a
legacy URL and **rebuilds the request from `href` alone — discarding the caller's
`headers`** (and `rejectUnauthorized`, etc.). A real legacy `url.parse()` URL never
carries `headers`, so the heuristic is too loose: it can't tell a legacy URL apart from
a RequestOptions object that happens to include URL fields.

The analytics `POST` is unaffected because it carries a `method`, which fails the
`!("method")` check and sends it down the branch that preserves the options.

## The fix

[`patches/@mswjs__interceptors@0.41.9.patch`](patches/@mswjs__interceptors@0.41.9.patch)
tightens the heuristic so objects carrying request options fall through to the
RequestOptions branch (which preserves headers):

```diff
- } else if ("hash" in args[0] && !("method" in args[0])) {
+ } else if ("hash" in args[0] && !("method" in args[0]) && !("headers" in args[0])) {
```

Genuine legacy URLs (no `headers`) are still detected as before. Verified against this
repro on `msw@2.15.0` / `@mswjs/interceptors@0.41.9` — the heuristic is unchanged in the
latest version, so upgrading MSW does not fix it.

## Relationship to [#188](https://github.com/mswjs/interceptors/issues/188)

This is the same underlying bug as **#188** (reported 2021, still open) — the same
`normalizeClientRequestArgs` legacy-URL branch. The only difference is how the
url-shaped options object is produced:

- **#188:** the old `eventsource` library built request options with Node's
  `url.parse()`, producing a single url-shaped object → headers dropped → the
  LaunchDarkly SDK failed to authenticate (the reporter's repro was literally
  `ld-msw-authentication-issue`).
- **Here:** OpenTelemetry's `urlToHttpOptions()` normalization produces the same shape.

**#188 was never fixed in MSW** — it's closed as `needs:discussion` with no PR.
LaunchDarkly worked _around_ it by changing `launchdarkly-eventsource` to pass the URL
as a separate string argument — `request(urlString, options)` instead of a single
`url.parse()` object — so MSW takes its string branch and keeps the headers. That
workaround is why MSW-alone works with LD today.

**OpenTelemetry defeats that workaround:** it intercepts the safe
`request(urlString, options)` call and re-normalizes it (via `urlToHttpOptions`) back
into a single url-shaped options object, re-triggering the latent MSW bug. So the header
loss is not LD-specific — any layer that normalizes a request into a url-shaped options
object (`url.parse`, `urlToHttpOptions`, …) re-exposes it.

The one-line patch above fixes the **root cause in MSW**, so no consumer has to work
around it.
