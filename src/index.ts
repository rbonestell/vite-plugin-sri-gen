import type { OutputBundle } from "rollup";
import type { IndexHtmlTransformContext, Plugin, ResolvedConfig } from "vite";
import type { BundleLogger } from "./internal";
import {
	addSriToHtml,
	createLogger,
	DynamicImportAnalyzer,
	handleGenerateBundleError,
	HtmlProcessor,
	installSriRuntime,
	IntegrityProcessor,
	validateGenerateBundleInputs,
	type LoadResourceOptions,
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
}

let logger: BundleLogger;

/**
 * Vite plugin to add Subresource Integrity (SRI) attributes to external assets in index.html
 * ESM-only, requires Node 18+ (uses global fetch)
 *
 * @param options - Configuration options for the plugin
 * @returns Vite plugin with SRI processing capabilities
 */
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

	const plugin = {
		name: "vite-plugin-sri-gen",
		enforce: "post",
		// Only run during `vite build`
		apply: "build",
		order: "post",
		sequential: true,

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
			return addSriToHtml(html, context?.bundle as any, logger, {
				algorithm,
				crossorigin,
				resourceOpts,
			});
		},

		async writeBundle(_options: unknown, bundle: OutputBundle) {
			/**
			 * Main entry point for SRI processing after bundle write completion.
			 * This function orchestrates the entire SRI generation workflow:
			 * 1. Validates input parameters and initializes logging
			 * 2. Builds integrity mappings for all processable assets
			 * 3. Discovers and maps dynamic import relationships
			 * 4. Processes HTML files to inject SRI attributes and preload links
			 *
			 * @param _options - Rollup generation options (unused but required by interface)
			 * @param bundle - Output bundle containing all generated assets and chunks
			 * @returns Promise<void> - Completes when all SRI processing is finished
			 */

			// Initialize robust logging system with fallback chain
			logger = createLogger(this);

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

				// Step 2: Build comprehensive integrity mappings for all assets
				logger.info(
					"Building SRI integrity mappings for bundle assets"
				);
				const integrityProcessor = new IntegrityProcessor(
					algorithm,
					logger
				);
				sriByPathname = await integrityProcessor.buildIntegrityMappings(
					bundle
				);

				// Step 3: Discover and map dynamic import relationships
				logger.info("Analyzing dynamic import relationships");
				const dynamicImportAnalyzer = new DynamicImportAnalyzer(logger);
				dynamicChunkFiles =
					dynamicImportAnalyzer.analyzeDynamicImports(bundle);

				// Step 4: Process HTML files with comprehensive error handling
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
				});

				await htmlProcessor.processHtmlFiles(
					bundle,
					sriByPathname,
					dynamicChunkFiles
				);

				logger.info("SRI generation completed successfully");
			} catch (error) {
				handleGenerateBundleError(error, logger);
				throw error; // Re-throw to maintain error propagation
			}
		},

		// Prepend a tiny runtime to entry chunks to set integrity on dynamic <link>/<script>
		renderChunk(
			code: string,
			chunk: any
		): { code: string; map: null } | null {
			if (!runtimePatchDynamicLinks) return null;
			if (!(chunk as any).isEntry) return null;

			const serializedMap = JSON.stringify(sriByPathname);
			const cors = crossorigin ? JSON.stringify(crossorigin) : "false";
			const injected = `\n(${installSriRuntime.toString()})(${serializedMap}, { crossorigin: ${cors} });\n`;
			return { code: injected + code, map: null };
		},
	} as any;

	return plugin;
}
