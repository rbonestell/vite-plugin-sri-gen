<p align="center">
 	<img src="https://repository-images.githubusercontent.com/1034544632/2a282a35-ba36-49c1-ae44-407569c62a4b" width=50% height=50% alt="vite-plugin-sri-gen" />
</p>
<p align="center">
	Add <a href="https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity">Subresource Integrity (SRI)</a> hashes to your Vite build HTML output automatically.
</p>
<p align="center">
	<a href="https://www.npmjs.com/package/vite-plugin-sri-gen"><img src="https://img.shields.io/npm/v/vite-plugin-sri-gen.svg" alt="NPM Version"></a>
<a href="https://github.com/rbonestell/vite-plugin-sri-gen/actions/workflows/build.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/rbonestell/vite-plugin-sri-gen/build.yml?logo=typescript&logoColor=white" alt="Build Status"></a>
<a href="https://github.com/rbonestell/vite-plugin-sri-gen/actions/workflows/test.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/rbonestell/vite-plugin-sri-gen/test.yml?branch=main&logo=vite&logoColor=white&label=tests" alt="Test Results"></a>
<a href="https://app.codecov.io/gh/rbonestell/vite-plugin-sri-gen/"><img src="https://img.shields.io/codecov/c/github/rbonestell/vite-plugin-sri-gen?logo=codecov&logoColor=white" alt="Code Coverage"></a>
<a href="https://snyk.io/test/github/rbonestell/vite-plugin-sri-gen"><img src="https://snyk.io/test/github/rbonestell/vite-plugin-sri-gen/badge.svg" alt="Known Vulnerabilities"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
</p>

# vite-plugin-sri-gen

- Adds integrity attribute to script tags, stylesheet links, and modulepreload links in index.html
- Works out of the box in production builds
- Optionally injects rel="modulepreload" with integrity for lazy-loaded chunks
- Optionally injects a tiny CSP-safe runtime that adds integrity/crossorigin to dynamically inserted \<script\>/\<link\>
- Build-only by design (no dev server SRI)
- Supports SPA, MPA, and prerendered SSR/SSG HTML (logs a warning when a pure SSR server emits no HTML)
- Fast and network-friendly: in-memory HTTP cache with in-flight dedupe; optional fetch timeouts
- ESM-only, Node 18+ (uses global fetch)

## Install

```sh
npm i -D vite-plugin-sri-gen
```

## Quick start

vite.config.ts / vite.config.js:

```ts
import sri from 'vite-plugin-sri-gen'

export default {
  plugins: [
    sri({
      algorithm: 'sha384',       // 'sha256' | 'sha384' | 'sha512' (default: 'sha384')
      crossorigin: 'anonymous',  // 'anonymous' | 'use-credentials' | undefined
      fetchCache: true,          // cache remote fetches in-memory and dedupe concurrent requests (default: true)
      fetchTimeoutMs: 5000,      // abort remote fetches after N ms; 0 disables timeout (default: 5000)
      skipResources: [],         // skip SRI for resources matching these patterns (default: [])
    })
  ]
}
```

During build, the plugin updates index.html in memory and adds an integrity attribute to scripts, stylesheets, and modulepreload links. If crossorigin is provided, it is also added.

Advanced (optional): you can enable automatic rel="modulepreload" injection for lazy-loaded chunks and a CSP-safe runtime patch that sets integrity on dynamically inserted tags. See the Configuration section.

TypeScript/ESM notes:

- The package ships ESM only with types. Import as `import sri from 'vite-plugin-sri-gen'`.
- Built files live in `dist/` and type definitions at `dist/index.d.ts`.


## Dev mode

SRI is intentionally disabled during the Vite dev server. Use this plugin for build output only.

Why dev SRI doesn’t help:

- HMR bypasses SRI entirely: code updates are delivered over WebSocket and inlined into the page, not via normal `script`/`link` fetches that support integrity checks.
- Non-stable module URLs: the dev server rewrites ESM imports and appends timestamps/query params. Content changes frequently during edits, so any integrity value would break on each save.
- No transitive guarantees: browsers don’t enforce SRI for modules imported by a script with integrity. Each module request would need its own integrity, which the browser won’t verify in dev.
- Partial coverage is misleading: hashing only top-level tags (or some assets) provides a false sense of security while leaving the rest of the module graph and HMR updates unverified.

Conclusion: SRI is enforced only for build outputs, where assets are content-addressed and stable. That’s when browsers can reliably validate integrity and you get real protection.

## Configuration

```ts
type SriPluginOptions = {
  algorithm?: 'sha256' | 'sha384' | 'sha512', // default: 'sha384'
  crossorigin?: 'anonymous' | 'use-credentials', // default: undefined
  fetchCache?: boolean, // default: true (in-memory cache + in-flight dedupe for remote assets)
  fetchTimeoutMs?: number, // default: 5000 (5 seconds). Abort remote fetches after N ms, 0 to disable timeout
  preloadDynamicChunks?: boolean, // default: true. Inject rel="modulepreload" with integrity for discovered lazy chunks
  runtimePatchDynamicLinks?: boolean, // default: true. Inject a tiny runtime that adds integrity to dynamically created <script>/<link>
  skipResources?: string[], // default: []. Skip SRI for resources matching these patterns (by id or src/href)
}
```

Notes:

- Remote assets (http/https) are fetched at build to compute hashes. Protocol-relative URLs (//cdn.example.com/foo.js) are supported and treated as https.
- Local assets are read from the build bundle output.
- Existing integrity attributes are preserved and not overwritten.
- If an asset cannot be found in the bundle, it is skipped.
- Invalid or unsupported algorithms are automatically replaced with 'sha384' and a warning is logged.
- Caching: when enabled, remote fetches are cached in-memory per build and concurrent requests are deduplicated.
- Timeout: when a non-zero fetchTimeoutMs is set, slow remote fetches are aborted and the affected elements are left unchanged (a warning is logged).

### Skipping Resources

You can exclude specific resources from SRI generation using the `skipResources` option. This is useful for third-party scripts, analytics, or dynamically-loaded content that may change frequently:

```ts
sri({
  skipResources: [
    'analytics-script',              // Skip by element ID
    'https://www.googletagmanager.com/*', // Skip by URL pattern
    '*/gtm.js',                      // Skip Google Tag Manager
    'vendor-*',                      // Skip vendor assets by pattern
    '*.googleapis.com/*',            // Skip Google APIs
  ]
})
```

**Pattern Types:**
- **Element ID**: Matches the `id` attribute value exactly (`'analytics-script'`)
- **URL Exact Match**: Matches `src` or `href` attribute exactly (`'https://example.com/script.js'`)
- **URL Glob Pattern**: Use `*` as wildcard in URL patterns (`'*.googleapis.com/*'`, `'vendor-*'`)

**Use Cases:**
- Third-party analytics scripts that change frequently
- A/B testing scripts with dynamic content
- CDN resources that may be modified by the provider
- Development/staging resources that shouldn't have integrity checks

**Note**: Skipped elements will not have `integrity` attributes added, allowing them to be modified by CDNs or served with different content without breaking the page.

### Lazy-loaded chunks and dynamic tags

- If `preloadDynamicChunks` is enabled (default), the plugin scans Rollup output for dynamically imported chunks and injects `<link rel="modulepreload" integrity=...>` for them into emitted HTML, honoring Vite `base` and `crossorigin`.
- If `runtimePatchDynamicLinks` is enabled (default), a tiny runtime is prepended to entry chunks. It sets `integrity` (and `crossorigin` if configured) on dynamically created `<script>` and `<link>` elements for eligible resources (scripts, stylesheets, modulepreload, or preload as=script/style/font) before the network request happens. This is bundled code (not inline) and is CSP-safe.

## Compatibility

- SPA (appType: 'spa'): supported. transformIndexHtml runs at build to add SRI to index.html.
- MPA: supported. generateBundle scans emitted .html files and injects SRI.
- SSR/SSG: prerendered/static HTML is supported via generateBundle. For pure SSR server output (no .html emitted), there's nothing to modify at build time.
- Node 18+ only (uses global fetch). ESM-only package.

When building for SSR, if no HTML files are emitted, the plugin logs a warning to help diagnose why SRI wasn't applied:

> No emitted HTML detected during SSR build. SRI can only be added to HTML files; pure SSR server output will be skipped.

## Examples

### MPA (multiple HTML entry points)

Configure multiple HTML inputs so Vite emits several .html files. The plugin will inject SRI into all of them:

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import sri from 'vite-plugin-sri-gen'

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        about: 'about/index.html',
        admin: 'admin/index.html',
      },
    },
  },
  plugins: [
    sri({ crossorigin: 'anonymous' }),
  ],
})
```

### SSR/SSG with prerendered HTML

If your SSR/SSG setup emits static HTML during build (for example via a prerender step), the plugin will add SRI to those files automatically via generateBundle:

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import sri from 'vite-plugin-sri-gen'

export default defineConfig({
  // Your SSR/SSG tooling may set build.ssr, use a prerender plugin/step, etc.
  plugins: [
    sri(),
  ],
})
```

Notes:

- If no HTML is emitted (pure SSR server output), you’ll see a warning and nothing is changed.
- You don’t need extra configuration for SRI; inclusion of the plugin is enough when HTML files are produced.

### Advanced: networking controls

Tune caching and timeouts for remote assets:

```ts
import sri from 'vite-plugin-sri-gen'

export default {
  plugins: [
    sri({
      crossorigin: 'anonymous',
      fetchCache: true,      // keep enabled for best performance
      fetchTimeoutMs: 5000,  // fail fast if a CDN becomes slow or unresponsive
    })
  ]
}
```

## Why ESM-only?

Vite and modern Node tooling are native ESM-first. Dropping CommonJS simplifies the package and aligns with Vite expectations.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for the fork/branch/PR workflow (git-flow style with prefixes like `feat/`, `fix/`, `bug/`) and the testing/linting expectations.

## Security

See [SECURITY.md](./SECURITY.md) for supported versions and how to report vulnerabilities via the repository’s Security section.

## License

MIT — see [LICENSE](./LICENSE).
