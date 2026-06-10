<p align="center">
 	<img src="https://repository-images.githubusercontent.com/1034544632/2b674281-ff9c-4510-a0ef-91c33e395f0b" width=60% height=60% alt="vite-plugin-sri-gen" />
</p>
<p align="center">
	Add <a href="https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity">Subresource Integrity (SRI)</a> hashes to your Vite build HTML output automatically.
</p>
<p align="center">
	<a href="https://www.npmjs.com/package/vite-plugin-sri-gen"><img src="https://img.shields.io/npm/v/vite-plugin-sri-gen.svg" alt="NPM Version"></a>
<a href="https://github.com/rbonestell/vite-plugin-sri-gen/actions/workflows/build.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/rbonestell/vite-plugin-sri-gen/build.yml?logo=typescript&logoColor=white" alt="Build Status"></a>
<a href="https://github.com/rbonestell/vite-plugin-sri-gen/actions/workflows/test.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/rbonestell/vite-plugin-sri-gen/test.yml?branch=main&logo=vite&logoColor=white&label=tests" alt="Test Results"></a>
<a href="https://app.codecov.io/gh/rbonestell/vite-plugin-sri-gen/"><img src="https://img.shields.io/codecov/c/github/rbonestell/vite-plugin-sri-gen?logo=codecov&logoColor=white" alt="Code Coverage"></a>
<a href="https://snyk.io/test/github/rbonestell/vite-plugin-sri-gen"><img src="https://img.shields.io/badge/security-monitored-8A2BE2?logo=snyk" alt="Known Vulnerabilities"></a>
<a href="https://socket.dev/npm/package/vite-plugin-sri-gen"><img src="https://badge.socket.dev/npm/package/vite-plugin-sri-gen" alt="Known Vulnerabilities"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3DA639?logo=opensourceinitiative&logoColor=white" alt="License"></a>
</p>

# vite-plugin-sri-gen

Add [Subresource Integrity (SRI)](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity) hashes to your Vite build automatically.

- Adds `integrity` to scripts, stylesheets, and modulepreload links in emitted HTML — plus import map integrity, modulepreload injection for lazy chunks, a CSP-safe runtime for dynamic tags, and Vite manifest augmentation for backend-rendered HTML
- Build-only by design — works out of the box for SPA, MPA, and prerendered SSG output
- ESM-only, Node 18+, Vite 4+

## Documentation

**[📚 Full documentation →](https://rbonestell.com/vite-plugin-sri-gen/)**

- [Getting Started](https://rbonestell.com/vite-plugin-sri-gen/getting-started)
- [Configuration Options](https://rbonestell.com/vite-plugin-sri-gen/configure/options)
- [What is SRI?](https://rbonestell.com/vite-plugin-sri-gen/learn/what-is-sri)
- [Troubleshooting & Limitations](https://rbonestell.com/vite-plugin-sri-gen/troubleshoot/limitations)

## Install

```sh
npm i -D vite-plugin-sri-gen
```

## Quick start

```ts
// vite.config.ts
import sri from "vite-plugin-sri-gen";

export default {
  plugins: [sri()],
};
```

That's it — every build gets SRI with sensible defaults. See the
[configuration reference](https://rbonestell.com/vite-plugin-sri-gen/configure/options)
for `algorithm`, `crossorigin`, skip patterns, and more.

> [!IMPORTANT]
> Pure SSR output (HTML rendered at request time) cannot be modified at build time. Prerendered
> HTML works normally, and backends that render their own HTML can consume SRI hashes from the
> [augmented Vite manifest](https://rbonestell.com/vite-plugin-sri-gen/integrate/backend-manifest).
> Details: [SSR, SSG & Prerendering](https://rbonestell.com/vite-plugin-sri-gen/integrate/ssr-ssg).

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for the fork/branch/PR workflow and the testing/linting expectations.

## Security

See [SECURITY.md](./SECURITY.md) for supported versions and how to report vulnerabilities.

## License

MIT — see [LICENSE](./LICENSE).
