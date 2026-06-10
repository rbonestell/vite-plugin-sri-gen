---
description: "The plugin augments Vite's manifest with integrity and cssIntegrity fields so backend-rendered HTML can attach SRI hashes without re-hashing files."
---

# Backend-Owned HTML (Manifest)

When your backend owns HTML generation — a Node server, a Django template, a Go handler, or anything else that reads the Vite manifest to decide which assets to load — enable `build.manifest: true` in your Vite config. The plugin automatically augments the emitted manifest with `integrity` and `cssIntegrity` fields so your server can attach them to the tags it renders without re-hashing the files.

```ts
// vite.config.ts
import sri from 'vite-plugin-sri-gen'

export default {
  build: {
    manifest: true,
  },
  plugins: [sri()],
}
```

The feature is purely additive and automatic. If no manifest is emitted, nothing changes. It runs even when the bundle emits no HTML — which is the typical case for backend-owned HTML generation.

## Augmented Schema

Two fields are added per manifest entry:

- `integrity` — SRI hash for the entry's primary `file`, when the file is a JS or CSS asset.
- `cssIntegrity` — a `(string | null)[]` array aligned 1:1 with the entry's `css[]` array. A `null` at index `i` means `css[i]` has no hash (for example, because it matched a `skipResources` pattern, or because it isn't a JS or CSS file).

Both fields are appended after the existing Vite-emitted keys. Example manifest after augmentation:

```json
{
  "src/main.tsx": {
    "file": "assets/main-XYZ.js",
    "src": "src/main.tsx",
    "isEntry": true,
    "css": ["assets/main-ABC.css"],
    "imports": ["_shared-GHI.js"],
    "integrity": "sha384-…",
    "cssIntegrity": ["sha384-…"]
  },
  "_shared-GHI.js": {
    "file": "_shared-GHI.js",
    "integrity": "sha384-…"
  }
}
```

## Detection Rules

The plugin detects and augments manifest files by location and content:

- **Modern path** — `.vite/manifest.json` (Vite ≥ 4.3). Recognized automatically.
- **Legacy path** — `manifest.json` at the bundle root (Vite < 4.3). Recognized automatically.
- **Custom name** — when `build.manifest` is set to a string ending in `manifest.json`, the plugin augments it only if its contents match the Vite manifest shape. This prevents unrelated JSON assets that happen to share the suffix (such as PWA Web App manifests) from being touched.
- **SSR manifest** — `.vite/ssr-manifest.json` is never touched. It has a different schema (a module-to-chunk mapping used at runtime, not an asset registry).

## Consuming the Manifest

Backends resolve chunk dependencies by walking the `imports` and `dynamicImports` arrays as keys into the manifest, then attaching `integrity` from each resolved entry to the rendered `<script>` and `<link>` tags.

A simplified Node/Express example:

```js
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync('./dist/.vite/manifest.json', 'utf8'))

function renderPage(entryKey) {
  const entry = manifest[entryKey]
  const tags = []

  // Emit modulepreload links for statically imported chunks so the browser
  // fetches and verifies them in parallel with the entry script.
  for (const chunkKey of entry.imports ?? []) {
    const chunk = manifest[chunkKey]
    if (!chunk) continue
    tags.push(
      chunk.integrity
        ? `<link rel="modulepreload" href="/${chunk.file}" integrity="${chunk.integrity}" crossorigin="anonymous">`
        : `<link rel="modulepreload" href="/${chunk.file}">`
    )
  }

  // Render CSS link tags
  for (const [i, href] of (entry.css ?? []).entries()) {
    const hash = entry.cssIntegrity?.[i]
    tags.push(
      hash
        ? `<link rel="stylesheet" href="/${href}" integrity="${hash}" crossorigin="anonymous">`
        : `<link rel="stylesheet" href="/${href}">`
    )
  }

  // Render the entry script tag
  tags.push(
    entry.integrity
      ? `<script type="module" src="/${entry.file}" integrity="${entry.integrity}" crossorigin="anonymous"></script>`
      : `<script type="module" src="/${entry.file}"></script>`
  )

  return tags.join('\n')
}
```

`dynamicImports` (lazy chunks) can be resolved the same way — look up each value as a key in the manifest and read its `integrity`. For deeply nested dependency trees, walk `imports` recursively, tracking visited keys to avoid cycles.

::: tip Existing values are preserved
Existing `integrity` or `cssIntegrity` values on manifest entries are preserved and never overwritten. If you pre-populate these fields in a custom build step, the plugin leaves them alone.
:::

::: info What gets hashed
Only JS and CSS files are hashed, matching what the plugin hashes everywhere else. Entries in `assets` arrays (images, fonts, and other binary files) are left untouched.
:::

::: warning Manifest parse failure
For the standard manifest paths (`.vite/manifest.json` and `manifest.json`), a JSON parse failure is logged as a warning and the file is left unchanged. Custom `*manifest.json` filenames that fail to parse are silently skipped — they may be unrelated assets such as PWA Web App manifests. Either way, the rest of the build continues normally.
:::
