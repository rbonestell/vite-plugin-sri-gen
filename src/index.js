import { addSriToHtml } from "./internal.js";

// Vite plugin to add Subresource Integrity (SRI) attributes to external assets in index.html
// ESM-only, requires Node 18+ (uses global fetch)
export default function sri(options = {}) {
	let algorithm = options.algorithm ?? "sha384";
	const crossorigin = options.crossorigin;
	const enableCache = options.fetchCache !== false; // default true
	const fetchTimeoutMs = options.fetchTimeoutMs ?? 5000; // 0 = disabled
	const remoteCache = enableCache ? new Map() : undefined;
	const pending = enableCache ? new Map() : undefined;
	let isSSR = false;
	return {
		name: "vite-plugin-sri-gen",
		enforce: "post",
		// Only run during `vite build`
		apply: "build",
		configResolved(config) {
			// Fallback SSR detection from resolved config (may be a string or boolean)
			isSSR = isSSR || !!config.build?.ssr;

			// Validate algorithm at runtime and fallback safely
			if (algorithm !== "sha256" && algorithm !== "sha384" && algorithm !== "sha512") {
				this.warn(
					`[vite-plugin-sri-gen] Unsupported algorithm \"${String(
						algorithm
					)}\". Falling back to \"sha384\". Supported: sha256 | sha384 | sha512.`
				);
				algorithm = "sha384";
			}
		},

		async transformIndexHtml(html, context) {
			return addSriToHtml(html, context?.bundle, {
				algorithm,
				crossorigin,
				resourceOpts: { cache: remoteCache, pending, enableCache, fetchTimeoutMs },
			});
		},

		async generateBundle(_options, bundle) {
			// Use Vite/Rollup logger when available, fallback to console.warn otherwise
			const warn = this && typeof this.warn === "function" ? this.warn.bind(this) : console.warn;
			// Add SRI to any emitted HTML files (useful for MPA and SSR prerendered outputs)
			// This runs for both client and SSR builds; we only modify .html assets if present.
			const htmlFiles = Object.entries(bundle).filter(([fileName, out]) => {
				return fileName.toLowerCase().endsWith(".html") && out && out.type === "asset";
			});
			if (htmlFiles.length === 0) {
				if (isSSR) {
					warn(
						"[vite-plugin-sri-gen] No emitted HTML detected during SSR build. SRI can only be added to HTML files; pure SSR server output will be skipped."
					);
				}
				return;
			}
			for (const [fileName, asset] of htmlFiles) {
				try {
					const html = typeof asset.source === "string" ? asset.source : String(asset.source || "");
					const updated = await addSriToHtml(html, bundle, {
						algorithm,
						crossorigin,
						resourceOpts: { cache: remoteCache, pending, enableCache, fetchTimeoutMs },
					});
					asset.source = updated;
				} catch (err) {
					// Non-fatal: skip file on error
					warn(`[vite-plugin-sri-gen] Failed to add SRI to ${fileName}: ${err?.message || err}`);
				}
			}
		},
	};
}
