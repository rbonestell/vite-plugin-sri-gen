---
description: "How the injected import map declares per-module integrity so dynamically imported chunks are verified, plus browser support and CSP considerations."
---

# Import Map Integrity

When the build emits HTML and `base` is root-relative (`/`) or an absolute URL, the plugin injects a `<script type="importmap">` into each HTML file. The map declares an `integrity` object keyed by module URL, covering the chunks the browser actually reaches through the module graph — chunks pulled in via another chunk's static `import` or dynamic `import()`:

```html
<script type="importmap">
{"integrity":{"/assets/index-B3sb0LQp.js":"sha384-…","/assets/chunk-Cab12xJ4.js":"sha384-…"}}
</script>
```

A chunk that's only ever loaded via a rendered top-level `<script>` or `<link>` tag is left out of the map — that tag's own `integrity` attribute already covers it, so listing it again in the map would be redundant. This means a build with a single JS bundle and no code splitting emits **no import map at all**: its one entry chunk is fully covered by its `<script integrity>` tag. This matters for strict-CSP sites (payment pages, banking flows) that would otherwise need to whitelist an inline import map via a CSP hash or nonce for no additional coverage benefit.

A chunk is only dropped from the map when an emitted HTML file actually references it — absence of import edges alone isn't taken as proof of tag coverage. A chunk with no incoming imports that never appears in the build's own HTML (an extra `rollupOptions.input` entry consumed by server-rendered templates, or a module loaded through a runtime-constructed `import(url)`) stays in the map, since nothing else would verify it.

Browsers that support import map integrity apply the declared hashes to every matching module fetch — static `import` statements, dynamic `import()` calls, and module preloads alike. A module whose bytes don't match the declared hash is refused before execution. This catches statically imported chunks that modulepreload discovery misses, such as facade re-export modules.

## Browser Support

| Browser | Minimum version |
| --- | --- |
| Chrome | 127+ |
| Firefox | 138+ |
| Safari | 18+ |

Older browsers parse the import map but ignore the `integrity` key — module loads proceed normally, the same progressive-enhancement model as `integrity` attributes in HTML generally.

::: warning Older browsers and dynamic imports
When `runtimePatchDynamicLinks` is `false`, there is no JS-runtime fallback of any kind. On Chrome < 127, Firefox < 138, and Safari < 18, dynamic imports are entirely unverified regardless of the import map. If broad coverage across older browsers matters, keep `runtimePatchDynamicLinks` at its default (`true`).
:::

## Merging With Your Own Import Map

If your HTML already declares a `<script type="importmap">`, the plugin merges its `integrity` entries into the existing map rather than injecting a second one. Your own entries win on any key collision. A build warning is logged if a user-pinned hash differs from the build-computed hash, since that almost always indicates a stale template or a tampered build input.

## CSP Considerations

Import maps are necessarily inline — the HTML spec does not allow a `src` attribute on `<script type="importmap">`. A strict `Content-Security-Policy` with `script-src` that excludes `'unsafe-inline'` must permit the map via either:

- **A nonce** — your server templating injects a fresh nonce into both the CSP header and the `<script>` tag. This is the recommended approach.
- **A hash** — the browser can hash the inline script and match it against a `script-src` hash value. Note that the import map's content includes chunk content hashes, so it changes on every build. Automating hash extraction and CSP header updates is required.

If your build has no code splitting, none of this applies — see above, no import map is injected in the first place, so there's nothing to whitelist.

## Limitations

- **Workers and Service Workers** — import maps do not apply inside Web Workers or Service Workers. Module chunks loaded there are not covered by the import map, and the JS-runtime fallback does not cover them either. See [Limitations](/troubleshoot/limitations).

- **Relative `base`** — with `base: './'`, `''`, or any `'../…'` value, import map keys cannot be expressed portably (keys resolve against each document's URL and differ per page). Injection is skipped for relative base configurations. The JS-runtime fallback remains active for `preloadDynamicChunks: false` builds. See [Coverage Strategies](/learn/coverage-strategies) for the full decision tree.

- **`skipResources` patterns** — resources excluded via `skipResources` are also excluded from the import map. The opt-out applies to native module-fetch enforcement as well.

- **`<base href>` in HTML** — if your HTML contains a `<base href="https://…">` pointing to an absolute URL, the browser resolves import map keys against that base origin rather than the page origin. Root-relative keys like `/assets/index.js` may no longer match the URLs modules are actually fetched from. The plugin logs a build warning when it detects this.
