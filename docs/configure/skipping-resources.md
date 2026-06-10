---
description: "Use skipResources patterns to exclude third-party analytics, A/B testing scripts, and mutable CDN assets from SRI processing."
---

# Skipping Resources

Some resources should not have integrity attributes. Third-party analytics scripts are updated by the vendor without notice. A/B testing tools serve intentionally varying content. CDN assets delivered from a provider's infrastructure may be rewritten by edge workers or personalization layers before they reach the browser. Adding an integrity hash to these resources would break your page every time the bytes change.

The `skipResources` option lets you exclude specific resources from all SRI processing.

## Configuration

Pass an array of patterns to `skipResources`. Each pattern is matched against the element's `id`, `src`, and `href` attributes:

```ts
// vite.config.ts
import sri from 'vite-plugin-sri-gen'

export default {
  plugins: [
    sri({
      skipResources: [
        'analytics-script',                   // skip by element ID
        'https://www.googletagmanager.com/*', // skip by URL pattern
        'vendor-*',                           // skip vendor assets by pattern
        '*.googleapis.com/*',                 // skip Google APIs
      ],
    }),
  ],
}
```

## Pattern Types

Three kinds of patterns are supported:

**Element ID match** — matches the `id` attribute value. The same glob engine applies, so `*` wildcards work here just as they do for URLs. Matching is anchored and case-sensitive.

```ts
skipResources: ['analytics-script']   // exact ID
skipResources: ['analytics-*']        // matches id="analytics-v2", id="analytics-prod", etc.
// matches: <script id="analytics-script" src="...">
```

**URL exact match** — matches the full `src` or `href` attribute value.

```ts
skipResources: ['https://cdn.example.com/tracker.js']
// matches: <script src="https://cdn.example.com/tracker.js">
```

**URL glob pattern** — use `*` as a wildcard that matches any sequence of characters (including none). Patterns are anchored: `*` must cover the entire attribute value.

```ts
skipResources: ['https://www.googletagmanager.com/*', '*.googleapis.com/*', 'vendor-*']
// matches: <script src="https://www.googletagmanager.com/gtm.js?id=GTM-XXXX">
// matches: <link href="https://fonts.googleapis.com/css2?family=Inter">
// matches: <script src="/assets/vendor-react-Abc123.js">
```

Matching is case-sensitive. Each pattern is tested independently against `id`, `src`, and `href` — a single match on any attribute causes the element to be skipped.

## Use Cases

Typical resources to exclude:

- **Third-party analytics** — scripts managed by marketing platforms that update their own CDN without coordinating a release with you
- **A/B testing tools** — scripts that serve different variants per request by design
- **CDN resources that mutate** — assets delivered through a provider's edge network that may rewrite content (personalization, compression, minification proxies)
- **Development or staging scripts** — scripts that are only present in non-production environments and change frequently

## One Opt-Out, Everywhere

A `skipResources` exclusion is applied consistently across every mechanism the plugin uses. A skipped resource receives no integrity attribute in:

- **Static HTML tags** — `<script>`, `<link rel="stylesheet">`, `<link rel="modulepreload">` found in your HTML at build time
- **The import map** — the `integrity` object inside the injected `<script type="importmap">` (see [Import Map Integrity](/integrate/import-map))
- **Runtime patching** — the built-in integrity map passed to the injected runtime, so dynamically created elements for skipped resources are also left alone (see [Runtime Patching](/integrate/runtime-patching))
- **Manifest entries** — the `integrity` and `cssIntegrity` fields added to Vite manifest entries (see [Backend-Owned HTML (Manifest)](/integrate/backend-manifest))

::: warning Skipped resources are unverified
Elements excluded via `skipResources` receive no `integrity` attribute. Their bytes are not verified by the browser, so they can be modified in transit, at the CDN edge, or by the provider without the page detecting the change. Only exclude resources where that is intentional and expected.
:::
