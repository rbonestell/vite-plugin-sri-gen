import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  outDir: 'dist',
  target: 'node18',
  minify: false,
  treeshake: true,
  splitting: false,
  sourcemap: true,
  bundle: true,
  // minify stays off so the published package remains auditable (Socket.dev
  // flags minified code). The one piece of this bundle that reaches browsers —
  // `installSriRuntime`, serialized into consumer entry chunks — is minified at
  // the consumer's build time instead, by buildSriRuntimeCode() (issue #45).
  //
  // keepNames is intentionally disabled: esbuild's keepNames transform injects
  // a module-scoped `__name` helper into named function expressions. Because
  // `installSriRuntime` is shipped to consumer bundles via `.toString()`, those
  // `__name(...)` references would be undefined in the consumer and break the
  // injected runtime (issue #30). buildSriRuntimeCode() also shims `__name`
  // defensively, and rejects any minifier output that grew such a prologue.
  keepNames: false,
})
