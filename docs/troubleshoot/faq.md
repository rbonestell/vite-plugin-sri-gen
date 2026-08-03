---
description: "Answers to common questions: missing integrity attributes, CSP and import map conflicts, double-downloading chunks, ESM-only packaging, and more."
---

# FAQ

## Why is there no `integrity` on some of my tags?

Several things can cause an element to come through the build without an `integrity` attribute:

- **Asset not found in the bundle.** If the `src` or `href` resolves to a file that isn't part of the emitted bundle (for example, a path that doesn't correspond to any output chunk), the plugin can't compute a hash and silently skips the element.
- **Matched a `skipResources` pattern.** If the element's `id`, `src`, or `href` matches any pattern in your `skipResources` option, it is excluded from SRI processing entirely. See [Skipping Resources](/configure/skipping-resources).
- **Remote fetch failed or timed out.** For elements pointing to remote URLs, the plugin fetches the resource at build time to compute its hash. If the request fails or exceeds `fetchTimeoutMs`, an error is logged and the element is left without an integrity attribute. Check your build output for error messages. See [Networking](/configure/networking).

## What does the "No emitted HTML detected" warning mean?

You'll see this warning when running a Vite SSR build that produces only server-side JavaScript with no HTML files in the emitted bundle:

```
No emitted HTML detected during SSR build. SRI can only be added to HTML files; pure SSR server output will be skipped.
```

The plugin operates on emitted files. When your SSR build produces only server code, there are no HTML files for it to annotate, so it skips processing and logs this warning. This is expected behavior for pure server-output builds.

To add SRI to the HTML your server renders at request time, use the manifest integration path: the plugin augments `manifest.json` with integrity values, and your server reads those values when constructing `<script>` and `<link>` tags. See [SSR and SSG](/integrate/ssr-ssg) and [Backend Manifest](/integrate/backend-manifest).

## Why does my CSP block the injected import map?

Import maps are necessarily inline — the HTML spec does not allow a `src` attribute on `<script type="importmap">`. A strict `Content-Security-Policy` with a `script-src` directive that excludes `'unsafe-inline'` will block the injected map.

Watch for this, because **nothing appears broken when it happens**. The injected map has no `imports` key — only `integrity` — so module resolution never depended on it and your app loads normally. What is silently lost is SRI on every chunk the map was the only cover for.

The simplest fix needs no CSP cooperation at all:

```ts
sri({ importMapIntegrity: false })
```

No inline script is emitted, and the same hashes ship as `<link rel="modulepreload" integrity=...>` instead. Coverage is preserved as long as `preloadDynamicChunks` stays at its default `true` — see [`importMapIntegrity`](/configure/options#importmapintegrity) for the mechanics and the eager-fetch tradeoff.

If you would rather keep the map, you must get it past `script-src` yourself:

- **Nonce** — your server templating injects a fresh nonce into both the `script-src` CSP header and the `<script type="importmap">` tag on every response. The nonce changes per request, so there's nothing to update after a build.
- **Hash** — the browser matches the inline script against a `script-src` hash value. Because the map contains chunk content hashes, its content changes on every build, so hash extraction and CSP header updates have to be automated in your deploy pipeline.

To catch a gap like this the day it appears rather than months later, deploy `Integrity-Policy-Report-Only: blocked-destinations=(script)`. It reports any script fetch that carries no integrity metadata, which is exactly the failure mode a blocked import map produces.

See [Import Map Integrity](/integrate/import-map) for full CSP details.

## Why does my lazy chunk download twice?

When the JS `import()` rewriting path is active, the `__sriImport` helper fetches each chunk once to verify its hash before calling the native `import()`. The browser's module loader then fetches it again to execute it. That's two requests for the same file.

In practice this isn't a second network round-trip if you serve your chunks with `Cache-Control: immutable`. Vite's default output naming already includes a content hash in filenames (e.g. `chunk-Cab12xJ4.js`), so the second fetch is served from the browser's disk cache.

If you're seeing actual double network requests, check that your server sends `Cache-Control: immutable` (or at minimum a long `max-age`) for files in your assets directory.

See [Coverage Strategies](/learn/coverage-strategies) for when the JS fallback path is active and how to avoid it.

## What happens if I pass an invalid algorithm?

If the value you pass for the `algorithm` option isn't one of the three supported strings (`sha256`, `sha384`, `sha512`), the plugin replaces it with `'sha384'` at build time and logs a warning. Your build completes normally, and all integrity values are computed with `sha384`. Look for the warning in your build output to catch misconfigured options early.

## Why is the package ESM-only?

Vite and modern Node tooling are native ESM-first. Dropping CommonJS simplifies the package and aligns with Vite's own expectations.

## Does the plugin overwrite `integrity` attributes I wrote by hand?

No. An element that already carries an `integrity` attribute is left completely untouched — the plugin does not recompute the hash or add `crossorigin` to it. The same rule applies everywhere: static HTML tags, manifest entries, and runtime-patched elements all preserve existing values.

Keep in mind that a hand-written hash is your responsibility: if the file's content changes, browsers will refuse to load it until you update the value. To exclude an element from SRI processing entirely (including the import map), use `skipResources` — see [Skipping Resources](/configure/skipping-resources).
