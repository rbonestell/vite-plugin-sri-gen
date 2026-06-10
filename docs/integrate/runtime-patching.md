# Runtime Patching

With `runtimePatchDynamicLinks` enabled (the default), the plugin prepends a small runtime to every entry chunk. The runtime patches DOM mutation methods so that `<script>` and `<link>` elements created dynamically at runtime receive `integrity` (and `crossorigin`, if configured) before the browser makes the request.

Because the runtime is bundled code injected directly into your entry chunk — not an inline `<script>` tag — it is CSP-safe without `'unsafe-inline'`.

## Patched DOM Methods

The runtime installs patches on four DOM methods:

| Method | Prototype |
| --- | --- |
| `setAttribute` | `Element.prototype` |
| `appendChild` | `Node.prototype` |
| `insertBefore` | `Node.prototype` |
| `append` | `Element.prototype` |
| `prepend` | `Element.prototype` |

`setAttribute` is patched to intercept `src`, `href`, `rel`, and `as` attribute assignments — any of which can make a previously ineligible element eligible, or change the URL being loaded. The insertion methods (`appendChild`, `insertBefore`, `append`, `prepend`) are patched to process elements at the point they are added to the document.

## Eligible Elements

The runtime applies integrity only to elements that are eligible for SRI:

| Element | Condition |
| --- | --- |
| `<script>` | Has a `src` attribute |
| `<link>` | `rel="stylesheet"` |
| `<link>` | `rel="modulepreload"` |
| `<link>` | `rel="preload"` with `as="script"`, `as="style"`, or `as="font"` |

Elements that don't match these conditions — `<link rel="icon">`, `<link rel="manifest">`, bare `<script>` without `src`, and so on — are ignored.

## Existing Attributes

If a dynamically created element already has an `integrity` attribute set before the runtime processes it, the runtime does not overwrite it. The same applies to `crossorigin`. Both checks use `hasAttribute` before calling `setAttribute`, so hand-authored integrity values are always respected.

## Skip Patterns

The runtime respects `skipResources` patterns at runtime, consistent with build-time behavior. A URL that matches a skip pattern will not receive an `integrity` attribute even when inserted dynamically. See [Skipping Resources](/configure/skipping-resources) for pattern syntax and use cases.

## Disabling

Set `runtimePatchDynamicLinks: false` to omit the runtime from entry chunks entirely:

```ts
// vite.config.ts
import sri from 'vite-plugin-sri-gen'

export default {
  plugins: [
    sri({
      runtimePatchDynamicLinks: false,
    }),
  ],
}
```

Disabling the runtime means dynamically created `<script>` and `<link>` elements are not covered. It also disables the JS-level `import()` rewriting fallback, which relies on the runtime to install the `__sriImport` verifier. See [Coverage Strategies](/learn/coverage-strategies) for the full picture of what remains covered and what doesn't.
