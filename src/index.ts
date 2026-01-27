import type { NormalizedOutputOptions, OutputBundle } from "rollup";
import type { Plugin, PluginOption, ResolvedConfig } from "vite";
import type { BundleLogger } from "./internal";
import {
	createLogger,
	DynamicImportAnalyzer,
	handleGenerateBundleError,
	HtmlProcessor,
	installSriRuntime,
	IntegrityProcessor,
	validateGenerateBundleInputs,
} from "./internal";

/**
 * Configuration options for the SRI plugin.
 * Defines all available settings for customizing SRI generation behavior.
 */
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
	/** Skip SRI generation for resources matching these patterns. Supports exact matches and simple glob patterns with '*'. */
	skipResources?: string[];
	/** Enable verbose build logging. When false (default), only warnings, errors, and a completion summary are shown. */
	verboseLogging?: boolean;
}

let logger: BundleLogger;

/**
 * Vite plugin to add Subresource Integrity (SRI) attributes to external assets in index.html
 * ESM-only, requires Node 18+ (uses global fetch)
 *
 * @param options - Configuration options for the plugin
 * @returns Vite plugin with SRI processing capabilities
 */
export default function sri(options: SriPluginOptions = {}): PluginOption {
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
	const skipResources = options.skipResources ?? []; // default empty array
	const verboseLogging = options.verboseLogging === true; // default false

	// Build-time state
	let base = "/";
	let sriByPathname: Record<string, string> = {};
	let dynamicChunkFiles: Set<string> = new Set();

	const plugin: Plugin = {
		name: "vite-plugin-sri-gen",
		enforce: "post",
		// Only run during `vite build`
		apply: "build",

		configResolved(config: ResolvedConfig): void {
			// Fallback SSR detection from resolved config (may be a string or boolean)
			isSSR = isSSR || !!config.build?.ssr;
			base = config.base ?? "/";

			// Validate algorithm at runtime and fallback safely
			if (
				algorithm !== "sha256" &&
				algorithm !== "sha384" &&
				algorithm !== "sha512"
			) {
				logger.warn(
					`Unsupported algorithm "${String(
						algorithm
					)}". Falling back to "sha384". Supported: sha256 | sha384 | sha512.`
				);
				algorithm = "sha384";
			}
		},
		generateBundle: {
			order: "post",
			handler: async function (
				this: any,
				_options: NormalizedOutputOptions,
				bundle: OutputBundle,
				_isWrite: boolean
			) {
				/**
				 * Main entry point for SRI processing after bundle write completion.
				 * This function orchestrates the entire SRI generation workflow:
				 * 1. Validates input parameters and initializes logging
				 * 2. Builds integrity mappings for all processable assets
				 * 3. Discovers and maps dynamic import relationships
				 * 4. Processes HTML files to inject SRI attributes and preload links
				 *
				 * @param options - Rollup generation options (unused but required by interface)
				 * @param bundle - Output bundle containing all generated assets and chunks
				 * @returns Promise<void> - Completes when all SRI processing is finished
				 */

				// Initialize robust logging system with fallback chain
				logger = createLogger(this, verboseLogging);

				try {
					// Step 1: Validate inputs and early return conditions
					const validationResult = validateGenerateBundleInputs(
						bundle,
						isSSR
					);
					if (!validationResult.isValid) {
						if (
							validationResult.shouldWarn &&
							validationResult.message
						) {
							logger.warn(validationResult.message);
						}
						return;
					}

					const integrityProcessor = new IntegrityProcessor(
						algorithm,
						logger
					);

					// Two-pass vs single-pass hashing:
					// - When runtimePatchDynamicLinks is enabled, we need two passes:
					//   1) Hash non-entry chunks first (their hashes go into the runtime)
					//   2) Inject runtime into entry chunks
					//   3) Hash entry chunks (now includes the injected runtime)
					// - When disabled, we can hash everything in a single pass for efficiency
					if (runtimePatchDynamicLinks) {
						// Step 2a: Compute hashes for NON-ENTRY chunks first
						// These hashes will be embedded in the runtime injected into entry chunks
						logger.info(
							"Building SRI integrity mappings for non-entry chunks"
						);
						const nonEntryHashes =
							await integrityProcessor.buildIntegrityMappings(bundle, { excludeEntryChunks: true });

						// Step 2b: Inject runtime into entry chunks (BEFORE hashing entry chunks)
						// The runtime contains hashes for dynamic chunks so they can be verified at load time
						logger.info("Injecting SRI runtime into entry chunks");
						const serializedMap = JSON.stringify(nonEntryHashes);
						const cors = crossorigin ? JSON.stringify(crossorigin) : "false";
						const serializedSkipPatterns = JSON.stringify(skipResources);
						const runtimeCode = `\n(${installSriRuntime.toString()})(${serializedMap}, { crossorigin: ${cors}, skipResources: ${serializedSkipPatterns} });\n`;

						for (const [fileName, bundleItem] of Object.entries(bundle)) {
							if (bundleItem.type === "chunk" && bundleItem.isEntry) {
								bundleItem.code = runtimeCode + bundleItem.code;
								logger.info(`Injected SRI runtime into entry chunk: ${fileName}`);
							}
						}

						// Step 2c: NOW compute hashes for entry chunks (after runtime injection)
						// This ensures the entry chunk hash includes the injected runtime code
						logger.info(
							"Building SRI integrity mappings for entry chunks (post-injection)"
						);
						const entryHashes =
							await integrityProcessor.buildIntegrityMappings(bundle, { onlyEntryChunks: true });

						// Merge all hashes into the final map
						sriByPathname = { ...nonEntryHashes, ...entryHashes };
					} else {
						// Step 2 (single-pass): No runtime injection, hash all chunks at once
						logger.info(
							"Building SRI integrity mappings for all chunks (no runtime injection)"
						);
						sriByPathname = await integrityProcessor.buildIntegrityMappings(bundle);
					}

					// Step 6: Discover and map dynamic import relationships
					logger.info("Analyzing dynamic import relationships");
					const dynamicImportAnalyzer = new DynamicImportAnalyzer(
						logger
					);
					dynamicChunkFiles =
						dynamicImportAnalyzer.analyzeDynamicImports(bundle);

					// Step 7: Process HTML files with comprehensive error handling
					logger.info("Processing HTML files for SRI injection");
					const htmlProcessor = new HtmlProcessor({
						algorithm,
						crossorigin,
						base,
						preloadDynamicChunks,
						enableCache,
						remoteCache,
						pending,
						fetchTimeoutMs,
						logger,
						skipResources,
					});

					await htmlProcessor.processHtmlFiles(
						bundle,
						sriByPathname,
						dynamicChunkFiles
					);

					const assetCount = Object.keys(sriByPathname).length;
					const htmlCount = Object.values(bundle).filter(
						(item) =>
							item.type === "asset" &&
						typeof item.fileName === "string" &&
						item.fileName.endsWith(".html")
					).length;
					logger.summary(
						`SRI generation completed: ${assetCount} asset(s) processed, ${htmlCount} HTML file(s) updated`
					);
				} catch (error) {
					handleGenerateBundleError(error, logger);
					throw error; // Re-throw to maintain error propagation
				}
			},
		}
	};

	return plugin;
}
