# SPA & MPA

## Single-Page Apps

No configuration is required beyond adding the plugin. At build time, the plugin's `generateBundle` hook scans the in-memory bundle for emitted `.html` assets — for a standard SPA this is `index.html` — and injects `integrity` (and `crossorigin`, if configured) onto every eligible tag.

```ts
// vite.config.ts
import sri from 'vite-plugin-sri-gen'

export default {
  plugins: [sri()],
}
```

After `vite build`, your `index.html` contains hashed tags for the entry chunk, eagerly-imported CSS, and injected modulepreload links for lazy chunks:

```html
<script type="module" src="/assets/index-B3sb0LQp.js" integrity="sha384-…" crossorigin="anonymous"></script>
<link rel="stylesheet" href="/assets/index-ABC.css" integrity="sha384-…" crossorigin="anonymous">
<link rel="modulepreload" href="/assets/Settings-Kx2bL9qP.js" integrity="sha384-…" crossorigin="anonymous">
```

## Multi-Page Apps

For MPAs with multiple HTML entry points, configure `rollupOptions.input` to list each page. Vite emits a separate `.html` file for every entry, and the plugin processes all of them in a single pass:

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
  plugins: [sri({ crossorigin: 'anonymous' })],
})
```

Every emitted HTML file — `index.html`, `about/index.html`, and `admin/index.html` — receives SRI attributes. Each page's static tags are hashed independently; the import map and any injected modulepreload links reflect the chunks that page actually loads.

## Further Reading

Lazy chunks and dynamically inserted tags require separate coverage strategies. See [Coverage Strategies](/learn/coverage-strategies) for how modulepreload injection, the import map, and runtime patching layer together to cover the full module graph.
