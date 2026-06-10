# SSR, SSG & Prerendering

## Why Pure SSR Can't Be Modified

The plugin works by scanning emitted `.html` assets inside its `generateBundle` hook — a build-time step that runs once, after the bundle has been fully assembled. For pure server-side rendering, HTML is produced at request time by the running server, not during the build. There are no `.html` files in the bundle, so there is nothing for `generateBundle` to inject into.

This is not a limitation of the plugin's implementation; it reflects the architecture of SSR itself. HTML that doesn't exist at build time cannot receive build-time hashes.

## What Works

If your SSR or SSG setup emits static HTML during the build — via a prerender step, a static generation plugin, or any mechanism that writes `.html` files into Rollup's output bundle — those files are processed automatically. No extra configuration is needed beyond adding the plugin:

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import sri from 'vite-plugin-sri-gen'

export default defineConfig({
  plugins: [sri()],
})
```

Any `.html` asset emitted during the build receives the full treatment: static tag SRI, import map integrity injection, and modulepreload links for lazy chunks.

[Vike](https://vike.dev/) (formerly vite-plugin-ssr) is a common example. When Vike's prerendering step is active, it emits the prerendered pages as HTML assets into the bundle, and the plugin picks them up automatically.

## The Warning You'll See

When a build is detected as SSR (via `build.ssr`) and no `.html` files are found in the bundle output, the plugin logs:

```
No emitted HTML detected during SSR build. SRI can only be added to HTML files; pure SSR server output will be skipped.
```

This warning is informational — the build completes successfully, and any manifest augmentation still runs normally. To suppress it, switch to the manifest path instead (see [Backend-Owned HTML (Manifest)](/integrate/backend-manifest)), or enable prerendering in your SSR framework so HTML is emitted during the build.

## Backend-Owned HTML

If your server owns HTML generation at runtime and reads the Vite manifest to decide which scripts and stylesheets to load, the manifest augmentation path is the right solution. See [Backend-Owned HTML (Manifest)](/integrate/backend-manifest) for how to enable it and consume the `integrity` fields it adds.
