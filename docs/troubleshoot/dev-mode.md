# Dev Mode

SRI is intentionally disabled during `vite dev`. The plugin does nothing during development — no integrity attributes, no import map injection, no runtime patching. This is by design, not a bug.

## Why

### HMR Bypasses SRI

Hot Module Replacement delivers code updates over a WebSocket connection. Updated modules are inlined into the running page through HMR runtime machinery, not fetched via `<script src>` or `<link href>` tags. Those tags are the only mechanism browsers use to enforce `integrity` checks. HMR updates simply never pass through the integrity gate, making any SRI attributes on the original tags irrelevant the moment an update is applied.

### Unstable Module URLs

The dev server rewrites ESM imports and appends timestamps and query parameters to module URLs to break caches during development. The content of a module also changes on every save. An integrity hash computed at startup is stale after the first edit — the hash of the file's bytes no longer matches the bytes the browser receives. Any `integrity` value would immediately cause a browser rejection on the next file change, making development unusable.

### The Dev Module Graph Can't Be Pre-Hashed

Browsers do not enforce SRI on modules imported _by_ a script that carries an `integrity` attribute. Only the tagged resource itself is verified. In a module graph, that means every `import` and `import()` inside the verified script — and everything those modules import — would need their own `integrity` attributes to be checked. The dev server serves dozens or hundreds of individual module files, and there is no practical way to pre-compute and maintain accurate hashes across the entire live-reloading graph.

### Partial Coverage Misleads

Adding `integrity` to only the top-level entry script while the rest of the module graph and all HMR updates remain unverified creates a false impression of security. An attacker who can tamper with a transitive dependency or inject a payload via HMR channels is not blocked by an integrity check on the entry tag. Incomplete coverage is worse than no coverage because it implies protection that isn't there.

## When SRI Actually Protects You

Build outputs are content-addressed and stable: Vite hashes filenames by content, assets don't change after the build, and the complete module graph is known. That's the environment where SRI gives you real protection — every hash is accurate, every module is covered, and browsers can reliably validate each fetch.

Run `vite build` to produce integrity-annotated output. See [How It Works](/learn/how-it-works) for a walkthrough of what the plugin does at build time.
