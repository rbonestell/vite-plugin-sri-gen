---
description: "Complete reference for every vite-plugin-sri-gen option with types, defaults, and examples — algorithm, crossorigin, fetchCache, skipResources, and more."
---

# Options

## Type Reference

```ts
interface SriPluginOptions {
  algorithm?: 'sha256' | 'sha384' | 'sha512'
  crossorigin?: 'anonymous' | 'use-credentials'
  fetchCache?: boolean
  fetchTimeoutMs?: number
  importMapIntegrity?: boolean
  preloadDynamicChunks?: boolean
  runtimePatchDynamicLinks?: boolean
  skipResources?: string[]
  verboseLogging?: boolean
}
```

## Summary

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `algorithm` | `'sha256' \| 'sha384' \| 'sha512'` | `'sha384'` | Hash algorithm for all computed integrity values |
| `crossorigin` | `'anonymous' \| 'use-credentials'` | `undefined` | CORS attribute added to integrity-enabled elements |
| `fetchCache` | `boolean` | `true` | Cache remote fetches in-memory and deduplicate concurrent requests |
| `fetchTimeoutMs` | `number` | `5000` | Abort remote fetches after N ms; `0` disables the timeout |
| `importMapIntegrity` | `boolean` | `true` | Deliver module-graph integrity via an inline `<script type="importmap">`. Set `false` for a strict CSP with no `'unsafe-inline'` |
| `preloadDynamicChunks` | `boolean` | `true` | Inject `<link rel="modulepreload" integrity=...>` for dynamically imported chunks |
| `runtimePatchDynamicLinks` | `boolean` | `true` | Prepend a small runtime to entry chunks that adds integrity to dynamically created elements |
| `skipResources` | `string[]` | `[]` | Patterns (exact or glob) matched against element `id`, `src`, or `href`; matching resources are excluded from SRI |
| `verboseLogging` | `boolean` | `false` | Print detailed step-by-step info messages during the build |

## `algorithm`

Controls the hash algorithm used for every integrity value the plugin emits — static HTML tags, the import map, injected modulepreload links, the runtime integrity map, and manifest entries.

**Default:** `'sha384'`

All three values (`sha256`, `sha384`, `sha512`) are strong enough for this use case. `sha384` is the default because it offers a good balance of hash length and security margin. See [Choosing an Algorithm](/learn/what-is-sri#choosing-an-algorithm) for a comparison.

::: warning Invalid algorithm values fall back to `'sha384'`
If you pass a value that is not one of the three supported strings, the plugin replaces it with `'sha384'` at build time and logs a warning. This handles cases where the option is set dynamically from a variable that might be misconfigured.
:::

```ts
// vite.config.ts
import sri from 'vite-plugin-sri-gen'

export default {
  plugins: [
    sri({
      // Use sha512 for the highest security margin — useful when your
      // security policy mandates a specific minimum algorithm strength.
      algorithm: 'sha512',
    }),
  ],
}
```

## `crossorigin`

Adds a `crossorigin` attribute to every element that receives an `integrity` attribute. Also passed into the injected runtime so dynamically created elements get the same attribute.

**Default:** `undefined` (attribute not added)

For cross-origin resources, the browser requires both an `integrity` attribute and a matching `crossorigin` attribute to actually enforce the integrity check. Without `crossorigin`, the check is silently skipped for cross-origin resources. For same-origin assets this attribute is not required. See [CORS and the `crossorigin` Attribute](/learn/what-is-sri#cors-and-the-crossorigin-attribute) for full details.

```ts
// vite.config.ts
import sri from 'vite-plugin-sri-gen'

export default {
  plugins: [
    sri({
      // Required when your assets are served from a CDN on a different origin.
      // The CDN must respond with Access-Control-Allow-Origin covering your page's origin.
      crossorigin: 'anonymous',
    }),
  ],
}
```

## `fetchCache`

Enables in-memory caching for remote asset fetches. When on, the first successful fetch for a URL is stored for the remainder of the build, and concurrent requests to the same URL are deduplicated — only one network request is made regardless of how many HTML files reference the resource.

**Default:** `true`

This setting has no effect when your build has no remote assets.

```ts
// vite.config.ts
import sri from 'vite-plugin-sri-gen'

export default {
  plugins: [
    sri({
      // Disable caching when running integrity verification in CI and you
      // want to guarantee a fresh fetch for every resource on every run.
      fetchCache: false,
    }),
  ],
}
```

See [Networking](/configure/networking) for more detail on how caching and timeouts interact.

## `fetchTimeoutMs`

Sets the per-request timeout for remote asset fetches. When a fetch exceeds this limit, the request is aborted, an error is logged, and the affected element is left without an integrity attribute.

**Default:** `5000` (5 seconds). Set to `0` to disable the timeout entirely.

```ts
// vite.config.ts
import sri from 'vite-plugin-sri-gen'

export default {
  plugins: [
    sri({
      // Tighten the timeout so slow or unresponsive CDNs fail fast during CI.
      fetchTimeoutMs: 3000,
    }),
  ],
}
```

See [Networking](/configure/networking) for more detail on timeout behavior.

## `importMapIntegrity`

Controls whether module-graph integrity is delivered through an inline `<script type="importmap">`.

**Default:** `true`

Import maps must be inline — the HTML spec forbids `src` on `<script type="importmap">`, and external import maps have never shipped in any browser. So a `Content-Security-Policy` whose `script-src` omits `'unsafe-inline'` blocks the injected map. Nothing appears broken when this happens: the map carries only an `integrity` key, so module resolution never depended on it. What is lost, silently, is SRI on every chunk the map was the only cover for.

Set this to `false` when your CSP does not permit inline scripts:

```ts
// vite.config.ts
import sri from 'vite-plugin-sri-gen'

export default {
  plugins: [
    sri({
      // No inline script is emitted; the same hashes ship as
      // <link rel="modulepreload" integrity=...> instead.
      importMapIntegrity: false,
    }),
  ],
}
```

Coverage is preserved rather than reduced, **provided `preloadDynamicChunks` stays at its default `true`** — that is the channel the hashes move to. With the map disabled, modulepreload injection widens from "dynamically imported chunks" to the whole module graph, so chunks reached only by a static `import` inside a lazy chunk — which have no HTML element of their own and cannot be annotated at the import site — stay verified. `importMapIntegrity: false` + `preloadDynamicChunks: true` is the one configuration that satisfies a strict CSP with no gaps and no server coordination.

Turning both off leaves chunks reached only by a static import with no channel at all. The `import()` rewrite is not a substitute — it hooks call sites, and a static import is not a call site. The build warns when this would actually leave chunks uncovered, naming the count.

The tradeoff is eager fetching: those chunks are downloaded when the HTML is parsed rather than when the lazy route needs them.

**Single-page apps.** The increment is usually modest, because `preloadDynamicChunks` (on by default) already preloads the lazy chunks themselves; what gets added is their private dependencies.

**Multi-page apps.** The widened set is computed per bundle, not per page, so every emitted HTML file receives preload links for every module-graph chunk in the build — including chunks private to other pages. The import map has always had this same bundle-wide scope, but as inert bytes in an inline script; as preload links it becomes real network fetches. On an MPA with large, independent per-page graphs, measure before adopting.

## `preloadDynamicChunks`

When enabled, the plugin reads Rollup's chunk graph after the build, identifies every dynamically imported chunk, and injects `<link rel="modulepreload" integrity=...>` for each one into every emitted HTML file. The browser validates the chunk bytes via the preload entry when it fetches the module — native SRI, no JavaScript involved.

**Default:** `true`

Disabling this option changes the coverage strategy for dynamic imports. The import map covers them when the build emits HTML-only with a root-relative or absolute `base`; for other configurations (no HTML, mixed HTML + manifest, or relative `base`), the plugin falls back to rewriting `import()` call sites to a JavaScript-level verifier.

See [Coverage Strategies](/learn/coverage-strategies) for the full decision tree and tradeoffs.

```ts
// vite.config.ts
import sri from 'vite-plugin-sri-gen'

export default {
  plugins: [
    sri({
      // Disable if eager preloading of all lazy chunks is causing too much
      // upfront bandwidth on initial page load for your app.
      preloadDynamicChunks: false,
    }),
  ],
}
```

## `runtimePatchDynamicLinks`

When enabled, the plugin prepends a small runtime to every entry chunk. The runtime patches DOM mutation methods (`setAttribute`, `appendChild`, `append`, `prepend`, `insertBefore`) to intercept dynamically created `<script>` and `<link>` elements and add `integrity` (and `crossorigin`, if configured) before the browser makes the request.

**Default:** `true`

The runtime is bundled code injected into the chunk — not an inline script — so it is CSP-safe without `'unsafe-inline'`. It also installs the `__sriImport` helper used by the JS-level dynamic import fallback when that path is active.

See [Coverage Strategies](/learn/coverage-strategies) for when the JS-level import rewriting kicks in, and [Runtime Patching](/integrate/runtime-patching) for full details on what the runtime patches.

```ts
// vite.config.ts
import sri from 'vite-plugin-sri-gen'

export default {
  plugins: [
    sri({
      // Disable if you have confirmed that no code in your app creates
      // <script> or <link> elements dynamically at runtime and you want
      // to minimize the injected code in entry chunks.
      runtimePatchDynamicLinks: false,
    }),
  ],
}
```

## `skipResources`

An array of patterns matched against each element's `id`, `src`, and `href` attributes. Elements where any attribute matches any pattern are excluded from SRI processing entirely.

**Default:** `[]`

Patterns support exact string matches and simple glob wildcards with `*`. See [Skipping Resources](/configure/skipping-resources) for the full pattern reference and use cases.

```ts
// vite.config.ts
import sri from 'vite-plugin-sri-gen'

export default {
  plugins: [
    sri({
      skipResources: [
        'analytics-script',              // element ID match (globs work here too)
        'https://www.googletagmanager.com/*', // URL glob
        'vendor-*',                      // filename glob
      ],
    }),
  ],
}
```

## `verboseLogging`

Controls how much the plugin prints during the build. With the default `false`, only warnings, errors, and a single completion summary line are printed. Setting this to `true` enables detailed step-by-step info messages: each processing phase, per-chunk runtime injection, HTML file results, and integrity mapping statistics.

**Default:** `false`

```ts
// vite.config.ts
import sri from 'vite-plugin-sri-gen'

export default {
  plugins: [
    sri({
      // Enable when debugging unexpected SRI output — the verbose logs
      // show exactly which files were processed and which were skipped.
      verboseLogging: true,
    }),
  ],
}
```
