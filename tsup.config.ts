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
  // keepNames is intentionally disabled: esbuild's keepNames transform injects
  // a module-scoped `__name` helper into named function expressions. Because
  // `installSriRuntime` is shipped to consumer bundles via `.toString()`, those
  // `__name(...)` references would be undefined in the consumer and break the
  // injected runtime (issue #30). The build is unminified, so keepNames has no
  // benefit here anyway. buildSriRuntimeCode() also shims `__name` defensively.
  keepNames: false,
})
