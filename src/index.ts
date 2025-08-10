import path from "node:path";
import type { OutputBundle, OutputChunk } from "rollup";
import type { IndexHtmlTransformContext, Plugin, ResolvedConfig } from "vite";
import {
	addSriToHtml,
	computeIntegrity,
	type LoadResourceOptions,
} from "./internal";
import { installSriRuntime } from "./runtime";

export interface SriPluginOptions {
	/** The hashing algorithm to use for generating SRI hashes. */
	algorithm?: "sha256" | "sha384" | "sha512";
	/** The CORS setting to use for fetched scripts and styles. */
	crossorigin?: "anonymous" | "use-credentials";
	/** Enable in-memory caching for remote fetches. Default: true */
	fetchCache?: boolean;
	/** Abort remote fetches after the given milliseconds. Default: 5000 (0 disables). */
	fetchTimeoutMs?: number;
	/** Add rel="modulepreload" with integrity for discovered dynamic chunks. Default: true */
	preloadDynamicChunks?: boolean;
	/** Inject a tiny runtime that sets integrity on dynamically inserted <script>/<link>. Default: true */
	runtimePatchDynamicLinks?: boolean;
}

let warn: (msg: string) => void = console.warn;

// Vite plugin to add Subresource Integrity (SRI) attributes to external assets in index.html
// ESM-only, requires Node 18+ (uses global fetch)
export default function sri(options: SriPluginOptions = {}): Plugin & {
	transformIndexHtml(
		html: string,
		context: IndexHtmlTransformContext
	): Promise<string>;
} {
	let algorithm: "sha256" | "sha384" | "sha512" =
		options.algorithm ?? "sha384";
	const crossorigin = options.crossorigin;
	const enableCache = options.fetchCache !== false; // default true
	const fetchTimeoutMs = options.fetchTimeoutMs ?? 5000; // 0 = disabled
	const remoteCache = enableCache ? new Map<string, Uint8Array>() : undefined;
	const pending = enableCache
		? new Map<string, Promise<Uint8Array>>()
		: undefined;
	let isSSR = false;
	const preloadDynamicChunks = options.preloadDynamicChunks !== false; // default true
	const runtimePatchDynamicLinks = options.runtimePatchDynamicLinks !== false; // default true

	// Build-time state
	let base = "/";
	let sriByPathname: Record<string, string> = {};
	let dynamicChunkFiles: Set<string> = new Set();

	return {
		name: "vite-plugin-sri-gen",
		enforce: "post",
		// Only run during `vite build`
		apply: "build",

		configResolved(config: ResolvedConfig): void {
			// Fallback SSR detection from resolved config (may be a string or boolean)
			isSSR = isSSR || !!config.build?.ssr;
			base = config.base ?? "/";

			// Use Vite logger if available
			warn = (this && (this as any).warn?.bind(this)) ?? console.warn;

			// Validate algorithm at runtime and fallback safely
			if (
				algorithm !== "sha256" &&
				algorithm !== "sha384" &&
				algorithm !== "sha512"
			) {
				warn(
					`Unsupported algorithm "${String(
						algorithm
					)}". Falling back to "sha384". Supported: sha256 | sha384 | sha512.`
				);
				algorithm = "sha384";
			}
		},

		async transformIndexHtml(
			html: string,
			context: IndexHtmlTransformContext
		) {
			const resourceOpts: LoadResourceOptions = {
				cache: remoteCache,
				pending,
				enableCache,
				fetchTimeoutMs,
			};
			return addSriToHtml(html, context?.bundle as any, {
				algorithm,
				crossorigin,
				resourceOpts,
			});
		},

		async generateBundle(_options: unknown, bundle: OutputBundle) {
			// Use Vite/Rollup logger when available, fallback to console.warn otherwise
			const warn: (msg: string) => void =
				this && typeof (this as any).warn === "function"
					? (this as any).warn.bind(this)
					: console.warn;

			// 1) Build a map of pathname -> integrity for emitted JS/CSS assets
			const map: Record<string, string> = {};
			for (const item of Object.values(bundle)) {
				if ((item as any).type === "asset") {
					const file = (item as any).fileName as string;
					if (!/\.(css|js|mjs)($|\?)/i.test(file)) continue;
					const src =
						typeof (item as any).source === "string"
							? (item as any).source
							: new Uint8Array((item as any).source as any);
					map[path.posix.join("/", file)] = computeIntegrity(
						src as any,
						algorithm
					);
				} else {
					const chunk = item as OutputChunk;
					const file = chunk.fileName;
					if (!/\.(js|mjs)($|\?)/i.test(file)) continue;
					map[path.posix.join("/", file)] = computeIntegrity(
						chunk.code || "",
						algorithm
					);
				}
			}
			sriByPathname = map;

			// 2) Discover dynamic import chunk fileNames
			const idToFile = new Map<string, string>();
			for (const v of Object.values(bundle)) {
				if ((v as any).type === "chunk") {
					const ch = v as OutputChunk;
					idToFile.set(ch.facadeModuleId ?? ch.name, ch.fileName);
					for (const modId of Object.keys(ch.modules))
						idToFile.set(modId, ch.fileName);
				}
			}
			const dyn = new Set<string>();
			for (const v of Object.values(bundle)) {
				if ((v as any).type !== "chunk") continue;
				const ch = v as OutputChunk;
				for (const di of ch.dynamicImports) {
					// Try resolving dynamic import to a chunk file:
					// 1) by module id/facadeModuleId/name mapping
					// 2) by direct bundle lookup (when di is a key)
					// 3) by matching a chunk's name (fallback when facadeModuleId is missing)
					let f = idToFile.get(di) || (bundle as any)[di]?.fileName;
					if (!f) {
						for (const candidate of Object.values(bundle)) {
							if ((candidate as any).type === "chunk") {
								const c = candidate as OutputChunk;
								if (c.name === di) {
									f = c.fileName;
									break;
								}
							}
						}
					}
					if (f) dyn.add(f);
				}
			}
			dynamicChunkFiles = dyn;

			// Add SRI to any emitted HTML files (useful for MPA and SSR prerendered outputs)
			// This runs for both client and SSR builds; we only modify .html assets if present.
			const htmlFiles: Array<[string, any]> = [];
			for (const [fileName, out] of Object.entries(bundle)) {
				if (
					typeof fileName === "string" &&
					fileName.toLowerCase().endsWith(".html") &&
					out &&
					(out as any).type === "asset"
				) {
					htmlFiles.push([fileName, out as any]);
				}
			}
			if (htmlFiles.length === 0) {
				if (isSSR) {
					warn(
						"No emitted HTML detected during SSR build. SRI can only be added to HTML files; pure SSR server output will be skipped."
					);
				}
				return;
			}
			for (const [fileName, asset] of htmlFiles as any) {
				try {
					const html =
						typeof (asset as any).source === "string"
							? (asset as any).source
							: String((asset as any).source || "");
					let updated = await addSriToHtml(html, bundle as any, {
						algorithm,
						crossorigin,
						resourceOpts: {
							cache: remoteCache,
							pending,
							enableCache,
							fetchTimeoutMs,
						},
					});

					// Optionally add <link rel="modulepreload"> for discovered dynamic chunks
					if (preloadDynamicChunks && dynamicChunkFiles.size) {
						const { load } = await import("cheerio");
						const $ = load(updated);
						for (const f of dynamicChunkFiles) {
							const href = path.posix.join(base, f);
							const exists =
								$(`link[rel="modulepreload"][href="${href}"]`)
									.length > 0;
							if (exists) continue;
							const integrity =
								sriByPathname[path.posix.join("/", f)];
							if (!integrity) continue;
							const corsAttr = crossorigin
								? ` crossorigin="${crossorigin}"`
								: "";
							const linkHtml = `<link rel="modulepreload" href="${href}" integrity="${integrity}"${corsAttr}>`;
							$("head").prepend(linkHtml);
						}
						updated = $.html();
					}
					(asset as any).source = updated;
				} catch (err: any) {
					// Non-fatal: skip file on error
					warn(
						`Failed to add SRI to ${fileName}: ${
							err?.message || err
						}`
					);
				}
			}
		},

		// Prepend a tiny runtime to entry chunks to set integrity on dynamic <link>/<script>
		renderChunk(
			code: string,
			chunk: any
		): { code: string; map: null } | null {
			if (!runtimePatchDynamicLinks) return null;
			if (!(chunk as OutputChunk).isEntry) return null;

			const serializedMap = JSON.stringify(sriByPathname);
			const cors = crossorigin ? JSON.stringify(crossorigin) : "false";
			const injected = `\n(${installSriRuntime.toString()})(${serializedMap}, { crossorigin: ${cors} });\n`;
			return { code: injected + code, map: null };
		},
	} as any;
}
