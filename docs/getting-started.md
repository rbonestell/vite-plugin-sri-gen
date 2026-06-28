---
description: "Install vite-plugin-sri-gen, add it to your Vite config, and get SRI integrity attributes on every script and stylesheet in your next build."
---

# Getting Started

## Install

```sh
npm i -D vite-plugin-sri-gen
```

## Quick Start

The minimal configuration — add the plugin and you're done:

```ts
// vite.config.ts
import sri from 'vite-plugin-sri-gen'

export default {
  plugins: [sri()],
}
```

All options have sensible defaults. When you need to tune things, here's the full annotated form:

```ts
// vite.config.ts
import sri from 'vite-plugin-sri-gen'

export default {
  plugins: [
    sri({
      algorithm: 'sha384',        // 'sha256' | 'sha384' | 'sha512' (default: 'sha384')
      crossorigin: 'anonymous',   // 'anonymous' | 'use-credentials' | undefined
      fetchCache: true,           // cache remote fetches in-memory and dedupe concurrent requests (default: true)
      fetchTimeoutMs: 5000,       // abort remote fetches after N ms; 0 disables timeout (default: 5000)
      skipResources: [],          // skip SRI for resources matching these patterns (default: [])
      verboseLogging: true,       // show all info-level build logs (default: false)
    }),
  ],
}
```

See [Options](/configure/options) for the full reference, including `preloadDynamicChunks` and `runtimePatchDynamicLinks`.

## What You Get

Running `vite build` with this plugin produces HTML where every relevant tag carries a computed integrity hash:

- **Scripts, stylesheets, and modulepreload links** already present in your HTML get `integrity` (and `crossorigin`, if configured) added automatically. See [Coverage Strategies](/learn/coverage-strategies).
- **import map integrity** — an injected `<script type="importmap">` declares hashes for every emitted JS module, giving supported modern browsers native SRI enforcement over both static and dynamic module imports. See [Import Map Integrity](/integrate/import-map).
- **Modulepreload injection for lazy chunks** — the plugin scans Rollup output for dynamically imported chunks and injects `<link rel="modulepreload" integrity=...>` links into each HTML file, so lazy chunks are preloaded with verified hashes. See [Coverage Strategies](/learn/coverage-strategies).
- **CSP-safe runtime patching of dynamic tags** — a tiny runtime prepended to entry chunks intercepts dynamically created `<script>` and `<link>` elements and adds the appropriate `integrity` and `crossorigin` attributes before the browser makes the request. See [Runtime Patching](/integrate/runtime-patching).
- **Vite manifest augmentation** — when `build.manifest: true` is set, the plugin adds `integrity` and `cssIntegrity` fields to each manifest entry so backends that own HTML generation can attach integrity without re-hashing the files. See [Backend-Owned HTML (Manifest)](/integrate/backend-manifest).

## Requirements & Compatibility

| Project type | Status |
| --- | --- |
| SPA | Supported — `generateBundle` processes the emitted HTML file |
| MPA | Supported — `generateBundle` scans all emitted `.html` files |
| Prerendered SSG | Supported — any `.html` files emitted during the build are processed |
| Pure SSR (no HTML emitted) | Manifest only — see [SSR, SSG & Prerendering](/integrate/ssr-ssg) |

Additional requirements:

- **Node ≥ 18** — the plugin uses the global `fetch` API introduced in Node 18.
- **ESM-only** — import with `import sri from 'vite-plugin-sri-gen'`. CommonJS `require()` is not supported.
- **Vite ≥ 4** — declared as a peer dependency; Vite 5, 6, 7, and 8 (Rolldown) are all supported.
- **Build-only** — SRI is intentionally disabled during `vite dev`. See [Dev Mode](/troubleshoot/dev-mode) for why.

## Next Steps

- [What is Subresource Integrity?](/learn/what-is-sri) — the security background behind this plugin
- [Options](/configure/options) — every configuration option explained
- [Limitations](/troubleshoot/limitations) — known edge cases and constraints
