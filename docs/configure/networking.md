---
description: "When the plugin fetches remote assets at build time, and how to tune fetchCache and fetchTimeoutMs for fast, reliable builds."
---

# Networking

The plugin touches the network only for **remote assets** — resources with an `http://`, `https://`, or protocol-relative `//` URL in your HTML. Protocol-relative URLs are treated as `https`. All locally-built assets (JS chunks, CSS, anything Vite emits into the bundle) are read directly from the in-memory bundle; no network request is made for them.

Remote fetches happen at build time, after Rollup finishes writing the bundle. The plugin fetches each remote resource's bytes in order to compute its hash.

::: tip
Builds with no remote assets never make network requests regardless of how `fetchCache` or `fetchTimeoutMs` are configured.
:::

## Caching (`fetchCache`)

**Default: `true`**

When caching is enabled, each remote URL is fetched at most once per build:

- **In-memory cache** — the first successful response is stored and reused for any subsequent reference to the same URL within the same build.
- **In-flight deduplication** — if two HTML files reference the same remote URL and processing begins concurrently, only one network request is made. Both consumers wait on the same pending promise.

Disabling `fetchCache` causes a fresh fetch for every reference to every remote URL, with no deduplication. This is rarely useful in normal builds but can be appropriate in CI environments where you want to guarantee that integrity is computed from live bytes on every run.

See [`fetchCache`](/configure/options#fetchcache) in the options reference.

## Timeouts (`fetchTimeoutMs`)

**Default: `5000` (5 seconds)**

The plugin sets an `AbortController` timeout on every remote fetch. If the response has not completed within the configured duration, the request is aborted, an error is logged, and the element is left without an `integrity` attribute — the build continues normally.

Set `fetchTimeoutMs: 0` to disable the timeout entirely. This is appropriate when your build fetches from a private network or slow origin where latency is known and acceptable.

See [`fetchTimeoutMs`](/configure/options#fetchtimeoutms) in the options reference.

## Example

Tightening the timeout for a build that fetches from an external CDN — fail fast rather than letting a slow or unresponsive host stall the build:

```ts
// vite.config.ts
import sri from 'vite-plugin-sri-gen'

export default {
  plugins: [
    sri({
      crossorigin: 'anonymous',
      fetchTimeoutMs: 3000, // tighter deadline for flaky or external CDNs
    }),
  ],
}
```
