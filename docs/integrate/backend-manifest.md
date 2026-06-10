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
    "integrity": "sha384-...",
    "cssIntegrity": ["sha384-..."]
  },
  "_shared-GHI.js": {
    "file": "_shared-GHI.js",
    "integrity": "sha384-..."
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
import manifest from './dist/.vite/manifest.json' assert { type: 'json' }

function renderPage(entryKey) {
  const entry = manifest[entryKey]

  // Render the entry script tag
  const scriptTag = entry.integrity
    ? `<script type="module" src="/${entry.file}" integrity="${entry.integrity}" crossorigin="anonymous"></script>`
    : `<script type="module" src="/${entry.file}"></script>`

  // Render CSS link tags
  const cssTags = (entry.css ?? []).map((href, i) => {
    const hash = entry.cssIntegrity?.[i]
    return hash
      ? `<link rel="stylesheet" href="/${href}" integrity="${hash}" crossorigin="anonymous">`
      : `<link rel="stylesheet" href="/${href}">`
  }).join('\n')

  return `${cssTags}\n${scriptTag}`
}
```

Chunks listed in `imports` (static dependencies) and `dynamicImports` (lazy chunks) can be resolved the same way — look up each value as a key in the manifest and read its `integrity`.

::: tip
Existing `integrity` or `cssIntegrity` values on manifest entries are preserved and never overwritten. If you pre-populate these fields in a custom build step, the plugin leaves them alone.
:::

::: info What gets hashed
Only JS and CSS files are hashed, matching what the plugin hashes everywhere else. Entries in `assets` arrays (images, fonts, and other binary files) are left untouched.
:::

::: warning Manifest parse failure
If the manifest file cannot be parsed as JSON, the plugin logs a warning and leaves the file unchanged. The rest of the build continues normally.
:::
