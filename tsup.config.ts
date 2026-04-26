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
  keepNames: true,
})
