import { load } from "cheerio";
import { createHash } from "node:crypto";
import path from "node:path";
import type { OutputAsset, OutputBundle, OutputChunk } from "rollup";
// =======================================================
// #region INTERFACES AND TYPES
// =======================================================

/**
 * Enhanced logger interface for consistent logging across all bundle processing operations.
 * Provides structured logging with appropriate fallbacks and context-aware messages.
 *
 * The logger follows a hierarchy: plugin context → console fallback → no-op
 * Info messages are only logged in development mode to reduce noise in production.
 */
export interface BundleLogger {
	/** Log informational messages (development mode only) */
	info(message: string): void;
	/** Log warning messages with plugin context fallback */
	warn(message: string): void;
	/** Log error messages with optional Error object for detailed stack traces */
	error(message: string, error?: Error): void;
}

/**
 * Structured validation result for input parameter checking.
 * Provides clear feedback about validation success and any warning messages.
 *
 * Used primarily by validateGenerateBundleInputs to communicate validation state
 * and determine whether warnings should be displayed to users.
 */
export interface ValidationResult {
	/** Whether the validation passed successfully */
	isValid: boolean;
	/** Whether a warning message should be displayed to the user */
	shouldWarn: boolean;
	/** Optional warning message text (null if no warning needed) */
	message: string | null;
}

/**
 * Comprehensive configuration interface for HTML processor operations.
 * Centralizes all HTML processing configuration to reduce parameter passing
 * and provide a single source of truth for processing behavior.
 *
 * This configuration drives both SRI injection and dynamic chunk preloading.
 */
export interface HtmlProcessorConfig {
	/** Hash algorithm for integrity computation */
	algorithm: "sha256" | "sha384" | "sha512";
	/** CORS setting for integrity-enabled resources */
	crossorigin?: "anonymous" | "use-credentials";
	/** Base path for generating absolute URLs */
	base: string;
	/** Whether to inject modulepreload links for dynamic chunks */
	preloadDynamicChunks: boolean;
	/** Whether to enable HTTP caching for remote resources */
	enableCache: boolean;
	/** HTTP cache storage for remote resource bytes */
	remoteCache?: Map<string, Uint8Array>;
	/** In-flight request deduplication map */
	pending?: Map<string, Promise<Uint8Array>>;
	/** HTTP request timeout in milliseconds (0 = disabled) */
	fetchTimeoutMs: number;
	/** Logger instance for consistent error reporting */
	logger: BundleLogger;
}

// #endregion

// =======================================================
// #region UTILITY FUNCTIONS
// =======================================================

/**
 * Determines whether a URL string represents an HTTP/HTTPS resource.
 * Supports both absolute URLs (http://, https://) and protocol-relative URLs (//).
 *
 * @param url - URL string to test (can be any type for safety)
 * @returns true if the URL represents an HTTP resource, false otherwise
 *
 * @example
 * isHttpUrl("https://example.com/script.js") // true
 * isHttpUrl("//cdn.example.com/style.css")   // true
 * isHttpUrl("/local/path.js")                // false
 * isHttpUrl("relative.js")                   // false
 */
export function isHttpUrl(url: unknown): boolean {
	return typeof url === "string" && /^(https?:)?\/\//i.test(url);
}

/**
 * Normalizes bundle paths by removing protocol-relative and leading slash prefixes.
 * Vite bundle keys are typically relative paths, but sometimes contain leading slashes
 * or protocol-relative prefixes that need to be normalized.
 *
 * @param p - Path to normalize (can be any type for safety)
 * @returns normalized path string or original value if not a string
 *
 * @example
 * normalizeBundlePath("/assets/main.js")     // "assets/main.js"
 * normalizeBundlePath("//assets/style.css")  // "assets/style.css"
 * normalizeBundlePath("assets/script.js")    // "assets/script.js"
 */
export function normalizeBundlePath(p: unknown): unknown {
	if (typeof p !== "string") return p;
	// Remove any protocol-relative prefix that might slip through
	if (p.startsWith("//")) return p.slice(2);
	// Strip leading slash (Vite bundle keys are relative)
	if (p.startsWith("/")) return p.slice(1);
	return p;
}

/**
 * Generic bundle item type representing either chunks or assets.
 * Used for bundle traversal and resource loading operations.
 */
type BundleItem = { code?: any; source?: any; type?: string };

/**
 * Bundle-like structure that may be undefined (for error handling).
 * Used throughout resource loading functions for safe bundle access.
 */
export type BundleLike = Record<string, BundleItem> | undefined;

/**
 * Finds a bundle item by relative path using multiple lookup strategies.
 * Implements fallback logic to handle various path formats and bundle key variations.
 *
 * Strategy 1: Exact match
 * Strategy 2: Suffix match (key ends with relative path)
 * Strategy 3: Basename match (last resort)
 *
 * @param bundle - Bundle to search in
 * @param relPath - Relative path to find
 * @returns Bundle item if found, null otherwise
 */
function findBundleItem(
	bundle: BundleLike,
	relPath: string
): BundleItem | null {
	if (!bundle) return null;
	const keys = Object.keys(bundle);

	// Strategy 1: Exact match
	if ((bundle as Record<string, BundleItem>)[relPath])
		return (bundle as Record<string, BundleItem>)[relPath];

	// Strategy 2: If the HTML path contains a base prefix or extra leading segments,
	// try to find a key that ends with the relative path
	let match = keys.find((k) => k === relPath || k.endsWith("/" + relPath));
	if (match) return (bundle as Record<string, BundleItem>)[match];

	// Strategy 3: Fallback to basename match as a last resort
	const last = relPath.split("/").pop();
	if (!last) return null;
	match = keys.find((k) => k === last || k.endsWith("/" + last));
	return match ? (bundle as Record<string, BundleItem>)[match] : null;
}

/**
 * Configuration options for resource loading operations.
 * Controls caching, timeouts, and request deduplication behavior.
 */
export type LoadResourceOptions = {
	/** HTTP response cache for storing fetched bytes */
	cache?: Map<string, Uint8Array>;
	/** Whether caching is enabled (default: true) */
	enableCache?: boolean;
	/** HTTP request timeout in milliseconds (0 = disabled) */
	fetchTimeoutMs?: number;
	/** In-flight request deduplication map */
	pending?: Map<string, Promise<Uint8Array>>;
};

/**
 * Loads a resource from either HTTP URL or local bundle.
 * Supports caching, timeout handling, and request deduplication for HTTP resources.
 * For local resources, performs bundle key lookup with path normalization.
 *
 * HTTP Resource Handling:
 * - Supports protocol-relative URLs (converts // to https://)
 * - Implements caching with configurable enable/disable
 * - Provides request timeout with AbortController
 * - Deduplicates concurrent requests to same URL
 *
 * Local Resource Handling:
 * - Normalizes bundle paths
 * - Uses multiple lookup strategies via findBundleItem
 * - Returns code or source property from bundle items
 *
 * @param resourcePath - URL or relative path to load
 * @param bundle - Bundle for local resource lookup
 * @param opts - Configuration options for loading behavior
 * @returns Resource content as string/Uint8Array, or null if not found
 */
export async function loadResource(
	resourcePath: string | undefined,
	bundle: BundleLike,
	opts?: LoadResourceOptions
): Promise<string | Uint8Array | null> {
	if (!resourcePath) return null;

	const enableCache = opts?.enableCache !== false; // default true
	const cache = opts?.cache;
	const fetchTimeoutMs = opts?.fetchTimeoutMs ?? 0; // 0 = disabled
	const pending = opts?.pending; // Map<string, Promise<Uint8Array>> for in-flight dedupe

	// ============================================================================
	// HTTP RESOURCE HANDLING
	// ============================================================================

	if (isHttpUrl(resourcePath)) {
		// Convert protocol-relative URLs to HTTPS
		const url = resourcePath.startsWith("//")
			? `https:${resourcePath}`
			: resourcePath;

		// Check cache first if caching is enabled
		if (enableCache && cache && cache.has(url)) {
			return cache.get(url) ?? null;
		}

		// Setup timeout handling with AbortController
		let controller: AbortController | undefined;
		let signal: AbortSignal | undefined;
		let timeoutId: any;

		if (
			fetchTimeoutMs &&
			fetchTimeoutMs > 0 &&
			typeof AbortController !== "undefined"
		) {
			controller = new AbortController();
			signal = controller.signal;
			timeoutId = setTimeout(() => controller!.abort(), fetchTimeoutMs);
		}

		// Fetch function with timeout cleanup
		const doFetch = async (): Promise<Uint8Array> => {
			let res: Response;
			try {
				res = await fetch(
					url,
					signal ? { signal } : (undefined as any)
				);
			} finally {
				// Always clear timeout to prevent memory leaks
				if (timeoutId) clearTimeout(timeoutId);
			}

			if (!res.ok) {
				throw new Error(
					`Failed to fetch ${url}: ${res.status} ${res.statusText}`
				);
			}

			return new Uint8Array(await res.arrayBuffer());
		};

		// Handle request deduplication if enabled
		if (enableCache && pending) {
			let p = pending.get(url);
			if (!p) {
				p = doFetch();
				pending.set(url, p);
			}
			const bytes = await p;
			if (enableCache && cache) cache.set(url, bytes);
			return bytes;
		}

		// Direct fetch without deduplication
		const bytes = await doFetch();
		if (enableCache && cache) cache.set(url, bytes);
		return bytes;
	}

	// ============================================================================
	// LOCAL BUNDLE RESOURCE HANDLING
	// ============================================================================

	if (!bundle) return null;

	const relPath = normalizeBundlePath(resourcePath);
	if (typeof relPath !== "string" || !relPath) return null;

	const bundleItem = findBundleItem(bundle, relPath);
	if (!bundleItem) return null;

	// Return code (for chunks) or source (for assets)
	return (bundleItem as any).code ?? (bundleItem as any).source ?? null;
}

/**
 * Computes subresource integrity (SRI) hash for given content.
 * Supports SHA-256, SHA-384, and SHA-512 algorithms as per Web Cryptography API standards.
 *
 * @param source - Content to hash (string or binary data)
 * @param algorithm - Hash algorithm to use
 * @returns SRI string in format "algorithm-base64hash"
 *
 * @example
 * computeIntegrity("console.log('hello')", "sha256")
 * // "sha256-xyz123..."
 */
export function computeIntegrity(
	source: string | Uint8Array,
	algorithm: "sha256" | "sha384" | "sha512"
): string {
	const buf =
		typeof source === "string" ? Buffer.from(source) : Buffer.from(source);
	const digest = createHash(algorithm).update(buf).digest("base64");
	return `${algorithm}-${digest}`;
}

/**
 * Determines the appropriate URL attribute name for a DOM element.
 * Script elements use "src", all other elements use "href" by default.
 *
 * @param el - DOM element-like object with name property
 * @returns "src" for script elements, "href" for others, null if invalid
 */
export function getUrlAttrName(el: any): "src" | "href" | null {
	if (!el || !el.name) return null;
	return el.name.toLowerCase() === "script" ? "src" : "href";
}

/**
 * Processes a single DOM element to add SRI attributes.
 * Loads the resource content, computes integrity, and updates element attributes.
 * Skips elements that already have integrity attributes to avoid conflicts.
 *
 * @param $el - Cheerio-wrapped element
 * @param bundle - Bundle for resource lookup
 * @param algorithm - Hash algorithm for integrity computation
 * @param crossorigin - CORS setting to apply
 * @param resourceOpts - Resource loading configuration
 */
export async function processElement(
	$el: any,
	bundle: BundleLike,
	algorithm: "sha256" | "sha384" | "sha512",
	crossorigin?: "anonymous" | "use-credentials",
	resourceOpts?: LoadResourceOptions
): Promise<void> {
	const el = $el.get(0);
	if (!el || !el.attribs) return;

	// Skip elements that already have integrity
	if (el.attribs.integrity) return;

	// Determine the URL attribute name (src or href)
	const attrName = getUrlAttrName(el);
	if (!attrName) return;

	const resourcePath = el.attribs[attrName];
	if (!resourcePath) return;

	// Load and process the resource
	const source = await loadResource(resourcePath, bundle, resourceOpts);
	if (!source) return;

	// Compute and apply integrity
	const integrity = computeIntegrity(source as any, algorithm);
	$el.attr("integrity", integrity);

	// Apply crossorigin if specified
	if (crossorigin) $el.attr("crossorigin", crossorigin);
}

/**
 * Adds SRI attributes to all eligible elements in an HTML document.
 * Processes scripts, stylesheets, module preloads, and preload links.
 *
 * Supported Elements:
 * - script[src] - Script elements with src attributes
 * - link[rel="stylesheet"][href] - Stylesheet links
 * - link[rel="modulepreload"][href] - Module preload links
 * - link[rel="preload"][as="script"][href] - Script preload links
 * - link[rel="preload"][as="style"][href] - Style preload links
 *
 * @param html - HTML content to process
 * @param bundle - Bundle for resource resolution
 * @param options - Processing configuration options
 * @returns Promise resolving to HTML with SRI attributes added
 */
export async function addSriToHtml(
	html: string,
	bundle: BundleLike,
	{
		algorithm = "sha384",
		crossorigin,
		resourceOpts,
	}: {
		algorithm?: "sha256" | "sha384" | "sha512";
		crossorigin?: "anonymous" | "use-credentials";
		resourceOpts?: LoadResourceOptions;
	} = {}
): Promise<string> {
	const $ = load(html);

	// Select all eligible elements for SRI processing
	const $elements = $(
		'script[src], link[rel="stylesheet"][href], link[rel="modulepreload"][href], link[rel="preload"][as="script" i][href], link[rel="preload"][as="style" i][href]'
	);

	// Process all elements in parallel with error handling
	await Promise.all(
		$elements
			.toArray()
			.map((node) => $(node))
			.map(($node) =>
				processElement(
					$node,
					bundle,
					algorithm,
					crossorigin,
					resourceOpts
				).catch((err: any) => {
					// Log processing errors but continue with other elements
					const src = $node.attr("src") || $node.attr("href");
					console.warn(
						`Failed to compute integrity for ${src}:`,
						err?.message || err
					);
				})
			)
	);

	return $.html();
}

// #endregion

// =======================================================
// #region HELPER FUNCTIONS
// =======================================================

/**
 * Creates a robust logger instance with comprehensive fallback hierarchy.
 * Implements the following priority order:
 * 1. Vite/Rollup plugin context logger (preferred)
 * 2. Console methods (fallback)
 * 3. No-op (if all else fails)
 *
 * Development vs Production Behavior:
 * - Info messages: Only logged in development mode
 * - Warn/Error messages: Always logged
 * - Stack traces: Only shown in development mode
 *
 * @param pluginContext - The plugin context (this) from the plugin function
 * @returns Logger interface with info, warn, and error methods
 */
export function createLogger(pluginContext: any): BundleLogger {
	// Extract plugin logger if available and valid
	const pluginLogger =
		pluginContext && typeof pluginContext.warn === "function"
			? pluginContext.warn.bind(pluginContext)
			: null;

	return {
		/**
		 * Logs informational messages in development mode only.
		 * Production builds suppress info logs to reduce noise.
		 */
		info: (msg: string) => {
			if (process.env.NODE_ENV === "development") {
				console.info(`[vite-plugin-sri-gen] ${msg}`);
			}
		},

		/**
		 * Logs warning messages with plugin context fallback.
		 * Uses plugin logger if available, otherwise falls back to console.
		 */
		warn: (msg: string) => {
			if (pluginLogger) {
				pluginLogger(msg);
			} else {
				console.warn(`[vite-plugin-sri-gen] ${msg}`);
			}
		},

		/**
		 * Logs error messages with optional stack trace support.
		 * Shows stack traces in development mode for detailed debugging.
		 */
		error: (msg: string, error?: Error) => {
			const fullMessage = `[vite-plugin-sri-gen] ${msg}`;

			if (pluginLogger) {
				pluginLogger(fullMessage);
			} else {
				console.error(fullMessage);
			}

			// Show stack traces in development for debugging
			if (error && process.env.NODE_ENV === "development") {
				console.error("Stack trace:", error.stack);
			}
		},
	};
}

/**
 * Validates inputs for generateBundle function with comprehensive checks.
 * Performs early validation to prevent unnecessary processing and provide
 * clear feedback about configuration issues.
 *
 * Validation Checks:
 * 1. Bundle existence and type validation
 * 2. Bundle content validation (non-empty)
 * 3. HTML file presence validation
 * 4. SSR-specific validation and messaging
 *
 * @param bundle - Output bundle to validate
 * @param isSSR - Whether running in SSR mode
 * @returns Validation result with isValid flag and optional warning message
 */
export function validateGenerateBundleInputs(
	bundle: OutputBundle,
	isSSR: boolean
): ValidationResult {
	// ============================================================================
	// BUNDLE EXISTENCE AND TYPE VALIDATION
	// ============================================================================

	if (!bundle || typeof bundle !== "object") {
		return {
			isValid: false,
			shouldWarn: true,
			message:
				"Invalid bundle provided to generateBundle. Bundle must be a valid object.",
		};
	}

	// ============================================================================
	// BUNDLE CONTENT VALIDATION
	// ============================================================================

	const bundleEntries = Object.entries(bundle);
	if (bundleEntries.length === 0) {
		return {
			isValid: false,
			shouldWarn: true,
			message:
				"Empty bundle detected. No assets to process for SRI generation.",
		};
	}

	// ============================================================================
	// HTML FILE PRESENCE VALIDATION
	// ============================================================================

	// Check for HTML files that can be processed
	const hasHtmlFiles = bundleEntries.some(
		([fileName, asset]) =>
			fileName.toLowerCase().endsWith(".html") &&
			asset &&
			(asset as any).type === "asset"
	);

	if (!hasHtmlFiles) {
		if (isSSR) {
			// SSR builds may not emit HTML files (server-only output)
			return {
				isValid: false,
				shouldWarn: true,
				message:
					"No emitted HTML detected during SSR build. SRI can only be added to HTML files; pure SSR server output will be skipped.",
			};
		}

		// Non-SSR builds without HTML are silently skipped (not an error)
		return {
			isValid: false,
			shouldWarn: false,
			message: null,
		};
	}

	// ============================================================================
	// VALIDATION SUCCESS
	// ============================================================================

	return { isValid: true, shouldWarn: false, message: null };
}

/**
 * Centralized error handling for generateBundle function.
 * Provides consistent error reporting and recovery strategies with
 * context-specific advice for common error scenarios.
 *
 * Error Categories with Specific Advice:
 * - Cheerio errors: HTML parsing and dependency issues
 * - Fetch errors: Network connectivity and resource availability
 * - Integrity errors: File content and hashing problems
 * - Generic errors: Basic error information
 *
 * @param error - The error that occurred during processing
 * @param logger - Logger instance for consistent error reporting
 */
export function handleGenerateBundleError(
	error: unknown,
	logger: BundleLogger
): void {
	// Extract error message safely
	const errorMessage = error instanceof Error ? error.message : String(error);

	// Log the primary error with stack trace if available
	logger.error(
		`Critical error during SRI generation: ${errorMessage}`,
		error instanceof Error ? error : undefined
	);

	// ============================================================================
	// CONTEXT-SPECIFIC ERROR ADVICE
	// ============================================================================

	// Cheerio/HTML parsing errors
	if (errorMessage.includes("cheerio")) {
		logger.warn(
			"HTML parsing failed. Ensure cheerio dependency is properly installed and HTML is valid."
		);
	}
	// Network/fetch errors
	else if (errorMessage.includes("fetch")) {
		logger.warn(
			"Remote resource fetching failed. Check network connectivity and resource availability."
		);
	}
	// Integrity computation errors
	else if (errorMessage.includes("integrity")) {
		logger.warn(
			"Integrity computation failed. Verify file contents and hashing algorithm support."
		);
	}

	// Note: Generic errors receive no additional advice to avoid noise
}

// #endregion

// =======================================================
// #region PROCESSING CLASSES
// =======================================================

/**
 * Specialized processor for building integrity mappings from bundle assets.
 * Handles both chunk and asset types with comprehensive error handling and validation.
 *
 * Key Features:
 * - Processes chunks (JS code) and assets (CSS, static files)
 * - Filters by processable file extensions (.css, .js, .mjs)
 * - Parallel processing with individual error boundaries
 * - Comprehensive logging and statistics
 * - Graceful handling of missing or invalid content
 */
export class IntegrityProcessor {
	private readonly algorithm: "sha256" | "sha384" | "sha512";
	private readonly logger: BundleLogger;

	/**
	 * File extension patterns for assets that should have integrity computed.
	 * Includes common JavaScript and CSS variations with query parameter support.
	 *
	 * Supported Extensions:
	 * - .css - Stylesheets
	 * - .js - JavaScript modules
	 * - .mjs - ECMAScript modules
	 * - Query parameters are preserved (e.g., .js?version=123)
	 */
	private readonly PROCESSABLE_EXTENSIONS = /\.(css|js|mjs)($|\?)/i;

	/**
	 * Constructs a new IntegrityProcessor with specified algorithm and logger.
	 *
	 * @param algorithm - Hash algorithm for integrity computation
	 * @param logger - Logger instance for consistent reporting
	 */
	constructor(
		algorithm: "sha256" | "sha384" | "sha512",
		logger: BundleLogger
	) {
		this.algorithm = algorithm;
		this.logger = logger;
	}

	/**
	 * Builds comprehensive integrity mappings for all processable assets in the bundle.
	 * Processes both chunks (with code) and assets (with source) while maintaining
	 * proper error boundaries for individual asset failures.
	 *
	 * Processing Flow:
	 * 1. Extract all bundle entries for processing
	 * 2. Process entries in parallel with individual error handling
	 * 3. Collect results and statistics
	 * 4. Log processing summary
	 *
	 * @param bundle - Output bundle containing assets and chunks
	 * @returns Promise<Record<string, string>> - Mapping of pathname to integrity hash
	 */
	async buildIntegrityMappings(
		bundle: OutputBundle
	): Promise<Record<string, string>> {
		const integrityMap: Record<string, string> = {};
		const bundleEntries = Object.entries(bundle);
		let processedCount = 0;
		let skippedCount = 0;

		this.logger.info(
			`Processing ${bundleEntries.length} bundle entries for integrity computation`
		);

		// ========================================================================
		// PARALLEL PROCESSING WITH ERROR BOUNDARIES
		// ========================================================================

		// Process all bundle entries with individual error handling
		const processingPromises = bundleEntries.map(
			async ([fileName, bundleItem]) => {
				try {
					const result = await this.processBundleItem(
						fileName,
						bundleItem
					);
					if (result) {
						integrityMap[result.pathname] = result.integrity;
						processedCount++;
					} else {
						skippedCount++;
					}
				} catch (error) {
					// Log error but continue processing other items
					this.logger.error(
						`Failed to process bundle item ${fileName}: ${
							error instanceof Error
								? error.message
								: String(error)
						}`,
						error instanceof Error ? error : undefined
					);
					skippedCount++;
				}
			}
		);

		// Wait for all processing to complete (errors are handled individually)
		await Promise.allSettled(processingPromises);

		// ========================================================================
		// PROCESSING SUMMARY AND STATISTICS
		// ========================================================================

		this.logger.info(
			`Integrity mapping completed: ${processedCount} processed, ${skippedCount} skipped`
		);

		return integrityMap;
	}

	/**
	 * Processes an individual bundle item (asset or chunk) for integrity computation.
	 * Handles type discrimination and source extraction with proper validation.
	 *
	 * Processing Steps:
	 * 1. Check file extension against processable patterns
	 * 2. Extract source content based on item type (asset vs chunk)
	 * 3. Compute integrity hash
	 * 4. Generate pathname for mapping
	 *
	 * @param fileName - Name of the file in the bundle
	 * @param bundleItem - The bundle item (asset or chunk)
	 * @returns Promise<{pathname: string, integrity: string} | null> - Result or null if skipped
	 */
	private async processBundleItem(
		fileName: string,
		bundleItem: OutputChunk | OutputAsset
	): Promise<{ pathname: string; integrity: string } | null> {
		// ========================================================================
		// FILE EXTENSION FILTERING
		// ========================================================================

		// Skip non-processable file extensions
		if (!this.PROCESSABLE_EXTENSIONS.test(fileName)) {
			return null;
		}

		// ========================================================================
		// SOURCE CONTENT EXTRACTION
		// ========================================================================

		let source: string | Uint8Array;

		// Handle asset type (CSS, static JS files)
		if (bundleItem.type === "asset") {
			const asset = bundleItem as OutputAsset;
			if (!asset.source) {
				this.logger.warn(
					`Asset ${fileName} has no source content, skipping`
				);
				return null;
			}

			// Handle both string and Uint8Array sources
			source =
				typeof asset.source === "string"
					? asset.source
					: new Uint8Array(asset.source);
		}
		// Handle chunk type (JS modules)
		else if (bundleItem.type === "chunk") {
			const chunk = bundleItem as OutputChunk;
			if (!chunk.code) {
				this.logger.warn(
					`Chunk ${fileName} has no code content, skipping`
				);
				return null;
			}
			source = chunk.code;
		}
		// Unknown bundle item type
		else {
			this.logger.warn(
				`Unknown bundle item type for ${fileName}, skipping`
			);
			return null;
		}

		// ========================================================================
		// INTEGRITY COMPUTATION
		// ========================================================================

		// Compute integrity with error handling
		try {
			const integrity = computeIntegrity(source, this.algorithm);
			const pathname = path.posix.join("/", fileName);

			return { pathname, integrity };
		} catch (error) {
			this.logger.error(
				`Failed to compute integrity for ${fileName}: ${
					error instanceof Error ? error.message : String(error)
				}`,
				error instanceof Error ? error : undefined
			);
			return null;
		}
	}
}

/**
 * Specialized analyzer for discovering and mapping dynamic import relationships.
 * Builds comprehensive mappings between module IDs and chunk file names to
 * enable proper preloading of dynamically imported modules.
 *
 * Key Features:
 * - Multiple resolution strategies for robust import mapping
 * - Comprehensive module ID to filename mapping
 * - Detailed logging and statistics
 * - Graceful handling of unresolvable imports
 */
export class DynamicImportAnalyzer {
	private readonly logger: BundleLogger;

	/**
	 * Constructs a new DynamicImportAnalyzer with the provided logger.
	 *
	 * @param logger - Logger instance for consistent reporting
	 */
	constructor(logger: BundleLogger) {
		this.logger = logger;
	}

	/**
	 * Analyzes bundle to discover dynamic import relationships and return chunk file names.
	 * Creates multiple mapping strategies to ensure dynamic imports are properly resolved.
	 *
	 * Analysis Flow:
	 * 1. Build comprehensive module ID to file name mappings
	 * 2. Extract all chunks from bundle
	 * 3. Process dynamic imports from each chunk
	 * 4. Resolve import identifiers to actual file names
	 * 5. Collect and deduplicate results
	 *
	 * @param bundle - Output bundle to analyze
	 * @returns Set<string> - Set of dynamic chunk file names
	 */
	analyzeDynamicImports(bundle: OutputBundle): Set<string> {
		const dynamicChunkFiles = new Set<string>();

		// ========================================================================
		// BUILD COMPREHENSIVE MODULE MAPPINGS
		// ========================================================================

		// Step 1: Build comprehensive module ID to file name mappings
		const idToFileMap = this.buildModuleIdMappings(bundle);

		// ========================================================================
		// PROCESS DYNAMIC IMPORTS FROM ALL CHUNKS
		// ========================================================================

		// Step 2: Discover dynamic imports from all chunks
		const chunks = this.extractChunksFromBundle(bundle);
		let totalDynamicImports = 0;

		for (const chunk of chunks) {
			const dynamicImports = chunk.dynamicImports || [];
			totalDynamicImports += dynamicImports.length;

			for (const dynamicImport of dynamicImports) {
				const resolvedFileName = this.resolveDynamicImport(
					dynamicImport,
					idToFileMap,
					bundle
				);

				if (resolvedFileName) {
					dynamicChunkFiles.add(resolvedFileName);
				} else {
					// Log unresolvable imports for debugging
					this.logger.warn(
						`Could not resolve dynamic import "${dynamicImport}" to a chunk file`
					);
				}
			}
		}

		// ========================================================================
		// ANALYSIS SUMMARY AND STATISTICS
		// ========================================================================

		this.logger.info(
			`Dynamic import analysis completed: ${totalDynamicImports} imports analyzed, ${dynamicChunkFiles.size} unique chunks discovered`
		);

		return dynamicChunkFiles;
	}

	/**
	 * Builds comprehensive mappings from module IDs to file names.
	 * Creates multiple mapping strategies for robust dynamic import resolution.
	 *
	 * Mapping Strategies:
	 * 1. Facade Module ID mapping (primary entry point)
	 * 2. Chunk name mapping (fallback identifier)
	 * 3. All module IDs within chunk (comprehensive coverage)
	 *
	 * @param bundle - Output bundle to analyze
	 * @returns Map<string, string> - Module ID to file name mappings
	 */
	private buildModuleIdMappings(bundle: OutputBundle): Map<string, string> {
		const idToFileMap = new Map<string, string>();
		const chunks = this.extractChunksFromBundle(bundle);

		for (const chunk of chunks) {
			// Strategy 1: Map facade module ID (primary entry point)
			if (chunk.facadeModuleId) {
				idToFileMap.set(chunk.facadeModuleId, chunk.fileName);
			}

			// Strategy 2: Map chunk name (fallback identifier)
			if (chunk.name) {
				idToFileMap.set(chunk.name, chunk.fileName);
			}

			// Strategy 3: Map all module IDs within this chunk (comprehensive coverage)
			if (chunk.modules) {
				for (const moduleId of Object.keys(chunk.modules)) {
					idToFileMap.set(moduleId, chunk.fileName);
				}
			}
		}

		this.logger.info(
			`Built module ID mappings for ${idToFileMap.size} entries`
		);
		return idToFileMap;
	}

	/**
	 * Extracts and validates chunks from bundle, filtering out non-chunk entries.
	 * Ensures type safety by filtering only chunk-type bundle items.
	 *
	 * @param bundle - Output bundle to process
	 * @returns OutputChunk[] - Array of valid chunks
	 */
	private extractChunksFromBundle(bundle: OutputBundle): OutputChunk[] {
		return Object.values(bundle).filter(
			(item): item is OutputChunk => item.type === "chunk"
		);
	}

	/**
	 * Resolves a dynamic import identifier to a concrete chunk file name.
	 * Uses multiple resolution strategies with fallback mechanisms.
	 *
	 * Resolution Strategies (in order):
	 * 1. Direct module ID/facade module ID lookup
	 * 2. Direct bundle key lookup (when dynamic import is a bundle key)
	 * 3. Chunk name matching (fallback when facade module ID is missing)
	 *
	 * @param dynamicImport - Dynamic import identifier
	 * @param idToFileMap - Module ID to file name mappings
	 * @param bundle - Output bundle for direct lookups
	 * @returns string | null - Resolved file name or null if not found
	 */
	private resolveDynamicImport(
		dynamicImport: string,
		idToFileMap: Map<string, string>,
		bundle: OutputBundle
	): string | null {
		// ========================================================================
		// STRATEGY 1: DIRECT MODULE ID LOOKUP
		// ========================================================================

		// Strategy 1: Direct module ID/facade module ID lookup
		const mappedFile = idToFileMap.get(dynamicImport);
		if (mappedFile) {
			return mappedFile;
		}

		// ========================================================================
		// STRATEGY 2: DIRECT BUNDLE KEY LOOKUP
		// ========================================================================

		// Strategy 2: Direct bundle key lookup (when dynamic import is a bundle key)
		const bundleItem = bundle[dynamicImport];
		if (bundleItem && bundleItem.type === "chunk") {
			return bundleItem.fileName;
		}

		// ========================================================================
		// STRATEGY 3: CHUNK NAME MATCHING
		// ========================================================================

		// Strategy 3: Chunk name matching (fallback when facade module ID is missing)
		const chunks = this.extractChunksFromBundle(bundle);
		const matchingChunk = chunks.find(
			(chunk) => chunk.name === dynamicImport
		);
		if (matchingChunk) {
			return matchingChunk.fileName;
		}

		// ========================================================================
		// NO RESOLUTION FOUND
		// ========================================================================

		return null;
	}
}

/**
 * Comprehensive HTML processor for SRI injection and preload link generation.
 * Handles HTML parsing, SRI injection, and dynamic chunk preloading with robust error handling.
 *
 * Key Features:
 * - Processes all HTML files in bundle with error boundaries
 * - Adds SRI attributes to existing elements
 * - Injects modulepreload links for dynamic chunks
 * - Handles duplicate link prevention
 * - Comprehensive error handling and logging
 */
export class HtmlProcessor {
	private readonly config: HtmlProcessorConfig;

	/**
	 * Constructs a new HtmlProcessor with the provided configuration.
	 *
	 * @param config - Comprehensive configuration for HTML processing behavior
	 */
	constructor(config: HtmlProcessorConfig) {
		this.config = config;
	}

	/**
	 * Processes all HTML files in the bundle to inject SRI attributes and preload links.
	 * Handles individual file failures gracefully while maintaining overall processing flow.
	 *
	 * Processing Flow:
	 * 1. Extract and validate HTML files from bundle
	 * 2. Process each HTML file with individual error boundaries
	 * 3. Apply SRI attributes to existing elements
	 * 4. Add preload links for dynamic chunks (if enabled)
	 * 5. Update bundle with processed HTML content
	 *
	 * @param bundle - Output bundle containing HTML assets
	 * @param sriByPathname - Mapping of pathnames to integrity hashes
	 * @param dynamicChunkFiles - Set of dynamic chunk file names for preloading
	 * @returns Promise<void> - Completes when all HTML files are processed
	 */
	async processHtmlFiles(
		bundle: OutputBundle,
		sriByPathname: Record<string, string>,
		dynamicChunkFiles: Set<string>
	): Promise<void> {
		// ========================================================================
		// HTML FILE EXTRACTION AND VALIDATION
		// ========================================================================

		// Extract and validate HTML files from bundle
		const htmlFiles = this.extractHtmlFiles(bundle);

		if (htmlFiles.length === 0) {
			this.config.logger.warn(
				"No HTML files found in bundle for processing"
			);
			return;
		}

		this.config.logger.info(`Processing ${htmlFiles.length} HTML files`);

		// ========================================================================
		// PARALLEL PROCESSING WITH ERROR BOUNDARIES
		// ========================================================================

		// Process HTML files with individual error boundaries
		const processingPromises = htmlFiles.map(async ([fileName, asset]) => {
			try {
				await this.processSingleHtmlFile(
					fileName,
					asset,
					bundle,
					sriByPathname,
					dynamicChunkFiles
				);
				this.config.logger.info(
					`Successfully processed HTML file: ${fileName}`
				);
			} catch (error) {
				// Non-fatal: continue processing other files
				this.config.logger.error(
					`Failed to process HTML file ${fileName}: ${
						error instanceof Error ? error.message : String(error)
					}`,
					error instanceof Error ? error : undefined
				);
			}
		});

		// Wait for all processing to complete (errors handled individually)
		const results = await Promise.allSettled(processingPromises);

		// ========================================================================
		// PROCESSING SUMMARY AND STATISTICS
		// ========================================================================

		const successCount = results.filter(
			(r) => r.status === "fulfilled"
		).length;
		const failureCount = results.filter(
			(r) => r.status === "rejected"
		).length;

		this.config.logger.info(
			`HTML processing completed: ${successCount} successful, ${failureCount} failed`
		);
	}

	/**
	 * Extracts HTML assets from bundle with proper type validation.
	 * Filters bundle entries to find only HTML assets with proper type checking.
	 *
	 * @param bundle - Output bundle to search
	 * @returns Array<[string, OutputAsset]> - Array of HTML file name and asset pairs
	 */
	private extractHtmlFiles(
		bundle: OutputBundle
	): Array<[string, OutputAsset]> {
		const htmlFiles: Array<[string, OutputAsset]> = [];

		for (const [fileName, bundleItem] of Object.entries(bundle)) {
			if (
				typeof fileName === "string" &&
				fileName.toLowerCase().endsWith(".html") &&
				bundleItem &&
				bundleItem.type === "asset"
			) {
				htmlFiles.push([fileName, bundleItem as OutputAsset]);
			}
		}

		return htmlFiles;
	}

	/**
	 * Processes a single HTML file with comprehensive SRI injection and preload generation.
	 *
	 * Processing Steps:
	 * 1. Extract and validate HTML content from asset
	 * 2. Add SRI attributes to existing elements
	 * 3. Add preload links for dynamic chunks (if enabled)
	 * 4. Update asset source with processed HTML
	 *
	 * @param fileName - Name of the HTML file
	 * @param asset - HTML asset from bundle
	 * @param bundle - Complete bundle for resource resolution
	 * @param sriByPathname - Integrity mappings
	 * @param dynamicChunkFiles - Dynamic chunks for preloading
	 * @returns Promise<void> - Completes when file is processed
	 */
	private async processSingleHtmlFile(
		fileName: string,
		asset: OutputAsset,
		bundle: OutputBundle,
		sriByPathname: Record<string, string>,
		dynamicChunkFiles: Set<string>
	): Promise<void> {
		// ========================================================================
		// HTML CONTENT EXTRACTION AND VALIDATION
		// ========================================================================

		// Extract and validate HTML content
		const htmlContent = this.extractHtmlContent(asset, fileName);
		if (!htmlContent) {
			return;
		}

		// ========================================================================
		// SRI ATTRIBUTE INJECTION
		// ========================================================================

		// Step 1: Add SRI attributes to existing elements
		let processedHtml = await this.addSriToHtmlContent(htmlContent, bundle);

		// ========================================================================
		// DYNAMIC CHUNK PRELOAD INJECTION
		// ========================================================================

		// Step 2: Add preload links for dynamic chunks (if enabled)
		if (this.config.preloadDynamicChunks && dynamicChunkFiles.size > 0) {
			processedHtml = await this.addDynamicChunkPreloads(
				processedHtml,
				dynamicChunkFiles,
				sriByPathname
			);
		}

		// ========================================================================
		// BUNDLE UPDATE
		// ========================================================================

		// Step 3: Update asset source with processed HTML
		asset.source = processedHtml;
	}

	/**
	 * Extracts HTML content from asset with proper validation and type handling.
	 * Handles both string and buffer sources with appropriate error reporting.
	 *
	 * @param asset - HTML asset to extract content from
	 * @param fileName - File name for error reporting
	 * @returns string | null - HTML content or null if invalid
	 */
	private extractHtmlContent(
		asset: OutputAsset,
		fileName: string
	): string | null {
		// Check for source content existence
		if (!asset.source) {
			this.config.logger.warn(
				`HTML file ${fileName} has no source content`
			);
			return null;
		}

		// Handle both string and buffer sources
		const htmlContent =
			typeof asset.source === "string"
				? asset.source
				: String(asset.source);

		// Check for empty content
		if (!htmlContent.trim()) {
			this.config.logger.warn(
				`HTML file ${fileName} appears to be empty`
			);
			return null;
		}

		return htmlContent;
	}

	/**
	 * Adds SRI attributes to existing HTML elements using the internal SRI processor.
	 * Delegates to the established addSriToHtml function with proper configuration.
	 *
	 * @param htmlContent - Original HTML content
	 * @param bundle - Bundle for resource resolution
	 * @returns Promise<string> - HTML with SRI attributes added
	 */
	private async addSriToHtmlContent(
		htmlContent: string,
		bundle: OutputBundle
	): Promise<string> {
		return addSriToHtml(htmlContent, bundle as any, {
			algorithm: this.config.algorithm,
			crossorigin: this.config.crossorigin,
			resourceOpts: {
				cache: this.config.remoteCache,
				pending: this.config.pending,
				enableCache: this.config.enableCache,
				fetchTimeoutMs: this.config.fetchTimeoutMs,
			},
		});
	}

	/**
	 * Adds modulepreload links for dynamic chunks with integrity attributes.
	 * Uses Cheerio for safe DOM manipulation and duplicate prevention.
	 *
	 * Features:
	 * - Safe DOM manipulation with Cheerio
	 * - Duplicate link prevention
	 * - Proper integrity and crossorigin attributes
	 * - Error handling with fallback to original HTML
	 *
	 * @param htmlContent - HTML content to modify
	 * @param dynamicChunkFiles - Set of dynamic chunk file names
	 * @param sriByPathname - Integrity mappings
	 * @returns Promise<string> - HTML with preload links added
	 */
	private async addDynamicChunkPreloads(
		htmlContent: string,
		dynamicChunkFiles: Set<string>,
		sriByPathname: Record<string, string>
	): Promise<string> {
		try {
			// ====================================================================
			// DOM SETUP AND INITIALIZATION
			// ====================================================================

			// Import Cheerio for DOM manipulation
			const { load } = await import("cheerio");
			const $ = load(htmlContent);
			let addedCount = 0;

			// ====================================================================
			// PRELOAD LINK GENERATION
			// ====================================================================

			// Process each dynamic chunk file
			for (const chunkFile of dynamicChunkFiles) {
				const added = this.addPreloadLinkForChunk(
					$,
					chunkFile,
					sriByPathname
				);
				if (added) {
					addedCount++;
				}
			}

			// ====================================================================
			// COMPLETION AND STATISTICS
			// ====================================================================

			this.config.logger.info(
				`Added ${addedCount} modulepreload links for dynamic chunks`
			);
			return $.html();
		} catch (error) {
			// ====================================================================
			// ERROR HANDLING WITH FALLBACK
			// ====================================================================

			this.config.logger.error(
				`Failed to add dynamic chunk preloads: ${
					error instanceof Error ? error.message : String(error)
				}`,
				error instanceof Error ? error : undefined
			);

			// Return original HTML on failure (non-fatal)
			return htmlContent;
		}
	}

	/**
	 * Adds a single preload link for a dynamic chunk with proper duplicate checking.
	 * Implements comprehensive validation and attribute generation.
	 *
	 * Validation Steps:
	 * 1. Build absolute href using base path
	 * 2. Check for existing preload links (duplicate prevention)
	 * 3. Verify integrity availability
	 * 4. Generate and inject preload link with proper attributes
	 *
	 * @param $ - Cheerio instance
	 * @param chunkFile - Chunk file name
	 * @param sriByPathname - Integrity mappings
	 * @returns boolean - Whether a link was added
	 */
	private addPreloadLinkForChunk(
		$: any,
		chunkFile: string,
		sriByPathname: Record<string, string>
	): boolean {
		// ========================================================================
		// HREF GENERATION AND DUPLICATE CHECKING
		// ========================================================================

		// Build absolute href using base path
		const href = path.posix.join(this.config.base, chunkFile);

		// Check if preload link already exists (duplicate prevention)
		const existingPreload = $(`link[rel="modulepreload"][href="${href}"]`);
		if (existingPreload.length > 0) {
			return false; // Skip duplicate
		}

		// ========================================================================
		// INTEGRITY VALIDATION
		// ========================================================================

		// Get integrity for this chunk
		const integrity = sriByPathname[path.posix.join("/", chunkFile)];
		if (!integrity) {
			this.config.logger.warn(
				`No integrity found for dynamic chunk: ${chunkFile}`
			);
			return false;
		}

		// ========================================================================
		// LINK GENERATION AND INJECTION
		// ========================================================================

		// Build crossorigin attribute if configured
		const crossoriginAttr = this.config.crossorigin
			? ` crossorigin="${this.config.crossorigin}"`
			: "";

		// Create and prepend preload link to head
		const linkHtml = `<link rel="modulepreload" href="${href}" integrity="${integrity}"${crossoriginAttr}>`;
		$("head").prepend(linkHtml);

		return true;
	}
}

// #endregion

// =======================================================
// #region RUNTIME SRI INJECTION
// =======================================================

/**
 * Runtime helper injected into entry chunks to add SRI to dynamically inserted elements.
 * This function is serialized and injected into the built JavaScript code to handle
 * dynamic script and link elements that are created after initial page load.
 *
 * Key Features:
 * - Patches DOM manipulation methods (appendChild, insertBefore, etc.)
 * - Patches setAttribute to catch dynamic attribute changes
 * - Supports both script and link elements
 * - Handles multiple rel types for link elements (stylesheet, modulepreload, preload)
 * - Graceful error handling to prevent runtime failures
 * - Configurable CORS settings
 *
 * Supported Elements:
 * - HTMLScriptElement with src attribute
 * - HTMLLinkElement with rel="stylesheet"
 * - HTMLLinkElement with rel="modulepreload"
 * - HTMLLinkElement with rel="preload" and as="script|style|font"
 *
 * @param sriByPathname - Map of pathnames to their SRI integrity values
 * @param opts - Configuration options for CORS settings
 */
export function installSriRuntime(
	sriByPathname: Record<string, string>,
	opts?: { crossorigin?: false | "anonymous" | "use-credentials" }
) {
	try {
		// ========================================================================
		// INITIALIZATION AND CONFIGURATION
		// ========================================================================

		// Convert pathname mapping to Map for efficient lookup
		const map = new Map<string, string>(
			Object.entries(sriByPathname || {})
		);

		// Extract CORS configuration with default fallback
		const cors =
			opts && Object.prototype.hasOwnProperty.call(opts, "crossorigin")
				? (opts as any).crossorigin
				: "anonymous";

		// ========================================================================
		// INTEGRITY LOOKUP HELPER
		// ========================================================================

		/**
		 * Extracts integrity value for a given URL using pathname matching.
		 * Handles URL parsing errors gracefully and supports relative URLs.
		 *
		 * @param url - URL to look up integrity for
		 * @returns SRI integrity string or undefined if not found
		 */
		const getIntegrityForUrl = (
			url: string | null | undefined
		): string | undefined => {
			if (!url) return undefined;

			let value: string | undefined;
			try {
				// Parse URL with fallback to current location
				const u = new URL(
					url,
					(globalThis as any).location?.href || ""
				);
				value = map.get(u.pathname);
			} catch {
				// URL parsing failed - ignore and return undefined
			}
			return value;
		};

		// ========================================================================
		// ELEMENT PROCESSING HELPER
		// ========================================================================

		/**
		 * Processes an element to potentially add SRI attributes.
		 * Handles both script and link elements with comprehensive validation.
		 *
		 * Element Support:
		 * - Script elements with src attributes
		 * - Link elements with eligible rel/as combinations
		 * - Proper integrity and crossorigin attribute handling
		 *
		 * @param el - DOM element to process
		 */
		const maybeSetIntegrity = (el: any) => {
			if (!el) return;

			// ====================================================================
			// ELEMENT TYPE DETECTION
			// ====================================================================

			const isLink =
				typeof HTMLLinkElement !== "undefined" &&
				el instanceof HTMLLinkElement;
			const isScript =
				typeof HTMLScriptElement !== "undefined" &&
				el instanceof HTMLScriptElement;

			if (!isLink && !isScript) return;

			// ====================================================================
			// URL EXTRACTION AND VALIDATION
			// ====================================================================

			let url: string | null = null;

			if (isLink) {
				// Process link elements with rel/as validation
				const rel = (el.rel || "").toLowerCase();
				const as = (
					(el.getAttribute && el.getAttribute("as")) ||
					""
				).toLowerCase();

				// Check if this link type is eligible for SRI
				const eligible =
					rel === "stylesheet" ||
					rel === "modulepreload" ||
					(rel === "preload" &&
						(as === "script" || as === "style" || as === "font"));

				if (!eligible) return;
				url = el.getAttribute && el.getAttribute("href");
			} else if (isScript) {
				// Process script elements
				url = el.getAttribute && el.getAttribute("src");
			}

			if (!url) return;

			// ====================================================================
			// INTEGRITY APPLICATION
			// ====================================================================

			// Look up integrity for this URL
			const integrity = getIntegrityForUrl(url);
			if (!integrity) return;

			// Verify element has required methods
			if (!el.hasAttribute || !el.setAttribute) return;

			// Apply integrity if not already present
			if (!el.hasAttribute("integrity"))
				el.setAttribute("integrity", integrity);

			// Apply crossorigin if configured and not already present
			if (cors && !el.hasAttribute("crossorigin"))
				el.setAttribute("crossorigin", cors);
		};

		// ========================================================================
		// SETATTRIBUTE PATCHING
		// ========================================================================

		// Patch Element.prototype.setAttribute to catch dynamic attribute changes
		const origSetAttribute = (Element as any)?.prototype?.setAttribute;
		if (origSetAttribute) {
			(Element as any).prototype.setAttribute = function (
				name: string,
				_value: string
			) {
				// Call original setAttribute first
				const r = origSetAttribute.apply(this, arguments as any);

				try {
					const n = String(name || "").toLowerCase();

					// Check if this attribute change should trigger SRI processing
					if (
						(this instanceof (globalThis as any).HTMLLinkElement &&
							(n === "href" || n === "rel" || n === "as")) ||
						(this instanceof
							(globalThis as any).HTMLScriptElement &&
							n === "src")
					) {
						maybeSetIntegrity(this);
					}
				} catch {
					// Ignore errors to prevent runtime failures
				}

				return r;
			};
		}

		// ========================================================================
		// DOM INSERTION METHOD PATCHING
		// ========================================================================

		/**
		 * Wraps a DOM insertion method to process elements for SRI.
		 * Handles both successful wrapping and fallback scenarios.
		 *
		 * @param proto - Prototype object to modify
		 * @param key - Method name to wrap
		 */
		const wrapInsert = (proto: any, key: string) => {
			const orig = proto && proto[key];
			if (!orig || typeof orig !== "function") return;

			// Create wrapper function that processes inserted nodes
			const wrapped = function (this: any) {
				try {
					const node = arguments[0];
					if (node) maybeSetIntegrity(node);
				} catch {
					// Ignore errors to prevent runtime failures
				}
				return orig.apply(this, arguments as any);
			};

			// Attempt to install wrapper with defineProperty (preferred)
			try {
				Object.defineProperty(proto, key, {
					value: wrapped,
					configurable: true,
					writable: true,
				});
			} catch {
				// Fallback to direct assignment if defineProperty fails
				try {
					proto[key] = wrapped;
				} catch {
					// Ignore if both methods fail
				}
			}
		};

		// ========================================================================
		// PATCH INSTALLATION
		// ========================================================================

		// Patch Node prototype methods (basic DOM insertion)
		wrapInsert((Node as any).prototype, "appendChild");
		wrapInsert((Node as any).prototype, "insertBefore");

		// Patch Element prototype methods (modern DOM insertion)
		wrapInsert((Element as any).prototype, "append");
		wrapInsert((Element as any).prototype, "prepend");
	} catch {
		// ========================================================================
		// GLOBAL ERROR HANDLING
		// ========================================================================
		// Ignore all errors at the top level to prevent runtime failures
		// The runtime SRI injection is an enhancement, not a requirement
	}
}

// #endregion
