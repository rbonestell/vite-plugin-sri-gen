# Limitations

Most Vite apps are fully covered with the default configuration, but a few scenarios fall outside what the plugin can address at build time. The sections below describe each limitation, why it exists, and what to do about it.

## Pure SSR Output

**What:** When Vite runs in SSR mode and produces only server-side JavaScript — no HTML files in the bundle — the plugin skips SRI processing entirely and logs a warning.

**Why:** SRI attributes live in HTML tags. The plugin operates in the `generateBundle` hook, which runs on emitted files. Request-time HTML rendered by your server is not an emitted file; it doesn't exist at build time.

**Workaround:** Use the manifest integration path. The plugin augments `manifest.json` with integrity hashes for every chunk. Your server reads the manifest and injects the correct `integrity` attribute when it renders the `<script>` and `<link>` tags for each response. See [Backend Manifest](/integrate/backend-manifest) and [SSR and SSG](/integrate/ssr-ssg).

## Web Workers & Service Workers

**What:** Module chunks loaded inside Web Workers or Service Workers are not covered by SRI.

**Why:** Import maps do not apply inside worker contexts — the browser runs them in a separate module graph with no access to the page's import map. The JS `import()` fallback path is also scoped to the main thread and does not run inside workers.

**Workaround:** There is no automatic workaround. If your worker loads a chunk from the same origin, you can manually add an integrity check via the [Trusted Types API](https://developer.mozilla.org/en-US/docs/Web/API/Trusted_Types_API) or by fetching the script as text, verifying the hash in worker code, and constructing an object URL.

See [Import Map Integrity](/integrate/import-map) for additional context on this constraint.

## Older Browsers & Import Map Integrity

**What:** Chrome < 127, Firefox < 138, and Safari < 18 parse the injected import map but silently ignore the `integrity` key. Dynamic `import()` calls in these browsers are not verified by the native module system.

**Why:** Support for `integrity` in import maps was added incrementally across browsers. Older versions treat the `integrity` field as an unrecognized extension and discard it.

**What still works on older browsers:**
- `integrity` attributes on static `<script src>`, `<link rel="stylesheet">`, and `<link rel="modulepreload">` tags are enforced by all SRI-capable browsers regardless of import map support.
- `<link rel="modulepreload" integrity=...>` injected by `preloadDynamicChunks` (the default) provides native SRI coverage for lazy chunks on older browsers.
- Runtime patching (`runtimePatchDynamicLinks`) enforces integrity on dynamically created `<script>` and `<link>` elements in all browsers via JavaScript.

::: tip Keep the defaults for broad coverage
With `preloadDynamicChunks: true` and `runtimePatchDynamicLinks: true` (both defaults), older browsers receive meaningful SRI coverage through modulepreload and runtime patching even without import map integrity support.
:::

See [Import Map Integrity](/integrate/import-map) for the full browser support table and progressive-enhancement model.

## Source Maps & `import()` Rewriting

**What:** Source maps are dropped for any chunk whose dynamic `import()` call sites are rewritten by the JS-fallback path. Stack traces from those chunks will not map back to original source lines.

**Why:** The rewrite wraps `import(...)` with `__sriImport(import.meta.url, ...)`. This shifts byte offsets throughout the file, making the original source map mappings inaccurate. The plugin does not regenerate source maps for rewritten chunks.

**Workaround:** The JS-fallback path is only active under specific conditions (see [Coverage Strategies](/learn/coverage-strategies)). The most direct way to avoid it is to keep `preloadDynamicChunks: true` (the default) and use a root-relative or absolute `base` — that combination covers dynamic imports via import map integrity and modulepreload, with no `import()` rewriting needed.

## JS Fallback Constraints

**What:** The JS `import()` rewriting path has three constraints that do not apply to other coverage strategies.

**Why and workaround for each:**

- **Secure context required.** `crypto.subtle` is only available in [secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) (HTTPS or `localhost`). Serving your app over plain HTTP in production means the verifier cannot run.
- **CORS must be configured.** The verifier fetches each chunk before passing it to the native `import()`. Your server must respond with `Access-Control-Allow-Origin` headers covering the page's origin, or the preflight will be rejected.
- **Double fetch per chunk.** Each chunk is fetched once by the verifier and once by the browser's module loader. Use `Cache-Control: immutable` on content-hashed chunk filenames (Vite's default output naming already produces content hashes) so the second request is served from the browser cache rather than making a real network round-trip.

These constraints don't apply to builds fully covered by the import map or modulepreload paths. See [Coverage Strategies](/learn/coverage-strategies) for the decision tree.

## Hand-Written Integrity Attributes

**What:** If you manually write an `integrity` attribute on a `<script src>` or `<link>` tag in your HTML source, the plugin overwrites it with the hash recomputed from the built output. Your pinned value does not survive the build.

**Why:** The plugin processes every eligible element it finds in emitted HTML. It does not distinguish between attributes the developer wrote and ones it added in a previous pass. The recomputed hash is always the authoritative one for that build.

**Workaround:** To keep an element's existing `integrity` value untouched, exclude it via `skipResources`. Elements that match a skip pattern are not processed at all — they retain every attribute exactly as they appear in source.

```ts
sri({
  skipResources: ['#my-pinned-script', 'https://cdn.example.com/specific-file.js'],
})
```

See [Skipping Resources](/configure/skipping-resources) for the full pattern reference.

## Dev Server

The plugin is intentionally disabled during `vite dev`. There is no integrity enforcement, no import map injection, and no runtime patching in development. This is by design, not a configuration issue.

See [Dev Mode](/troubleshoot/dev-mode) for the full explanation.
