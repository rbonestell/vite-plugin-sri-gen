import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DefaultTreeAdapterTypes, Token } from "parse5";
import { parse, serialize } from "parse5";
import type { Rollup } from "vite";
import type { IRuntimeDependencies } from "./dom-abstraction";

// Rollup bundle types, sourced via Vite's `Rollup` namespace so they track the
// active bundler (Rollup on Vite ≤7, Rolldown on Vite 8). See src/index.ts.
type OutputAsset = Rollup.OutputAsset;
type OutputBundle = Rollup.OutputBundle;
type OutputChunk = Rollup.OutputChunk;
import { defaultDependencies } from "./dom-abstraction";

// Use public parse5 types instead of deep import
type Document = DefaultTreeAdapterTypes.Document;
type Element = DefaultTreeAdapterTypes.Element;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type TextNode = DefaultTreeAdapterTypes.TextNode;

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
	/** Log informational messages */
	info(message: string): void;
	/** Log warning messages with plugin context fallback */
	warn(message: string): void;
	/** Log error messages with optional Error object for detailed stack traces */
	error(message: string, error?: Error): void;
	/** Always prints regardless of verboseLogging setting — used for the final completion summary */
	summary(message: string): void;
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
	/**
	 * Whether to deliver module-graph integrity via an inline
	 * `<script type="importmap">`. When false, no inline script is emitted and
	 * the same hashes are delivered as `<link rel="modulepreload" integrity>`
	 * instead. Defaults to true when omitted.
	 */
	importMapIntegrity?: boolean;
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
	/** Skip patterns for excluding resources from SRI processing */
	skipResources: string[];
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
 * Escapes characters that could terminate the surrounding <script> context
 * or break JS parsing when JSON is inlined into HTML or prepended to a
 * chunk: `JSON.stringify` does not escape `<` or the U+2028/U+2029 line
 * separators. The replacements are valid JSON escapes, so JSON.parse on the
 * result is unaffected. Canonical copy \u2014 also used by buildSriRuntimeCode in
 * index.ts.
 */
export function escapeForScript(json: string): string {
	return json
		.replace(/</g, "\\u003c")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
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
 * normalizeBundlePath("./assets/script.js")    // "assets/script.js"
 * normalizeBundlePath("assets/script.js")    // "assets/script.js"
 */
export function normalizeBundlePath(p: unknown): unknown {
	if (typeof p !== "string") return p;
	// Remove any protocol-relative prefix that might slip through
	if (p.startsWith("//")) return p.slice(2);
	// Strip leading slash (Vite bundle keys are relative)
	if (p.startsWith("/")) return p.slice(1);
	// Strip leading ./ (relative path prefix)
	if (p.startsWith("./")) return p.slice(2);
	return p;
}

/**
 * Joins a Vite base path with a chunk filename to produce a correct href.
 * Uses string concatenation for absolute URL bases (http://, https://, //)
 * to avoid path.posix.join collapsing the protocol's double slash.
 * Falls through to path.posix.join for relative/root paths.
 *
 * @param base - Vite base config value (URL or path)
 * @param chunkFile - Relative chunk filename
 * @returns Properly joined href string
 *
 * @example
 * joinBaseHref("https://cdn.myapp.com/", "assets/chunk.js")
 * // "https://cdn.myapp.com/assets/chunk.js"
 *
 * joinBaseHref("/", "assets/chunk.js")
 * // "/assets/chunk.js"
 */
export function joinBaseHref(base: string, chunkFile: string): string {
	if (isHttpUrl(base)) {
		const normalizedBase = base.endsWith("/") ? base : base + "/";
		const normalizedChunk = chunkFile.startsWith("/")
			? chunkFile.slice(1)
			: chunkFile;
		return normalizedBase + normalizedChunk;
	}
	return path.posix.join(base, chunkFile);
}

/**
 * The href to use for an injected `<link rel="modulepreload">` in a specific
 * HTML document.
 *
 * Absolute and root-relative bases are document-independent, so joinBaseHref
 * is exact. A RELATIVE base is not: the browser resolves the href against the
 * document's own URL, so an HTML file emitted into a subdirectory needs a
 * different string than one at the output root. joinBaseHref is a pure
 * function of (base, chunkFile) and would emit an identical href for every
 * page — correct only at the root, and silently wrong everywhere else. A
 * mismatched preload URL never matches the loader's real fetch, so SRI is not
 * enforced and a bogus request is issued.
 *
 * Both `chunkFile` and `htmlFileName` are bundle-relative, so for a relative
 * base the answer is simply the path from the document's directory to the
 * chunk — which is what Vite itself emits for its own tags.
 *
 * @example
 * preloadHref("./", "assets/dep.js", "admin/index.html")
 * // "../assets/dep.js"
 *
 * preloadHref("./", "assets/dep.js", "index.html")
 * // "./assets/dep.js"
 */
export function preloadHref(
	base: string,
	chunkFile: string,
	htmlFileName: string
): string {
	if (isHttpUrl(base) || base.startsWith("/")) {
		return joinBaseHref(base, chunkFile);
	}
	const dir = path.posix.dirname(htmlFileName);
	const rel = path.posix.relative(dir === "" ? "." : dir, chunkFile);
	// Match Vite's own "./"-prefixed style so duplicate detection against the
	// links Vite already emitted compares equal.
	return rel.startsWith("..") ? rel : `./${rel}`;
}

/**
 * Whether the resolved Vite `base` can produce valid import map `integrity`
 * keys. Import map keys must be URL-like — root-relative (`/...`),
 * `./`/`../`-relative, or absolute URLs. The plugin only emits root-relative
 * or absolute keys: a relative base (`./`, `../x/`, "") would require
 * document-relative keys, which break for HTML pages in subdirectories
 * (keys resolve against the DOCUMENT URL, not the deploy root).
 */
export function isImportMapCapableBase(base: string): boolean {
	return base.startsWith("/") || isHttpUrl(base);
}

/**
 * Builds the import map `integrity` object: emitted JS/MJS module URL → SRI
 * metadata. Keys are joined with the configured Vite `base` exactly like
 * injected modulepreload hrefs (see joinBaseHref), so they match the URLs the
 * browser actually requests. Files matching a `skipResources` pattern are
 * excluded — the user opted those out of SRI enforcement entirely. Returns
 * null when `base` is relative (no valid keys can be produced — see
 * isImportMapCapableBase). Chunks whose slash-free filename appears in
 * excludeFileNames are omitted (they're protected by an integrity-bearing
 * <script>/<link> tag — see issue #41).
 */
export function buildImportIntegrityObject(
	sriByPathname: Record<string, string>,
	base: string,
	skipResources: string[] = [],
	excludeFileNames: Set<string> = new Set()
): Record<string, string> | null {
	if (!isImportMapCapableBase(base)) return null;
	const result: Record<string, string> = {};
	for (const { pathname, fileName } of collectModuleChunkFiles(
		sriByPathname,
		skipResources,
		excludeFileNames
	)) {
		result[joinBaseHref(base, fileName)] = sriByPathname[pathname];
	}
	return result;
}

/**
 * The set of emitted JS module chunks that need integrity delivered through a
 * module-graph channel — i.e. every hashed .js/.mjs asset except those the user
 * opted out of via `skipResources` and those already protected by an
 * integrity-bearing <script>/<link> tag (excludeFileNames).
 *
 * This is the single source of truth for module-graph coverage. Both delivery
 * channels consume it: the inline import map (buildImportIntegrityObject) and
 * modulepreload injection when the import map is disabled. Keeping one
 * definition is what makes the channels interchangeable without leaving gaps.
 *
 * Unlike buildImportIntegrityObject this does not require an import-map-capable
 * base: modulepreload hrefs resolve against the document URL, so a relative
 * `base` that cannot produce valid import map keys still produces valid links.
 */
export function collectModuleChunkFiles(
	sriByPathname: Record<string, string>,
	skipResources: string[] = [],
	excludeFileNames: Set<string> = new Set()
): Array<{ pathname: string; fileName: string }> {
	const files: Array<{ pathname: string; fileName: string }> = [];
	for (const pathname of Object.keys(sriByPathname)) {
		// Match PROCESSABLE_EXTENSIONS semantics: allow a query suffix.
		if (!/\.m?js(\?|$)/i.test(pathname)) continue;
		const fileName = pathname.startsWith("/") ? pathname.slice(1) : pathname;
		if (isSkippedResource(fileName, skipResources)) continue;
		if (excludeFileNames.has(fileName)) continue;
		files.push({ pathname, fileName });
	}
	return files;
}

/**
 * Whether a bundle file matches any `skipResources` pattern. Patterns are
 * tested against both the bare file name and its '/'-rooted form so patterns
 * written either way match (same contract as manifest augmentation).
 */
export function isSkippedResource(
	file: string,
	skipResources: string[]
): boolean {
	if (!skipResources || skipResources.length === 0) return false;
	for (const pattern of skipResources) {
		if (matchesPattern(pattern, file)) return true;
		if (matchesPattern(pattern, `/${file}`)) return true;
	}
	return false;
}

/**
 * Extracts the pathname from a resource URL, handling absolute CDN URLs.
 * When the resource URL is an absolute HTTP/HTTPS URL, extracts just the pathname
 * portion for hash lookup. For relative or root-relative URLs, normalizes them
 * to have a leading slash.
 *
 * @param resourceUrl - The resource URL from HTML element (src/href attribute)
 * @returns The pathname suitable for hash lookup (e.g., "/assets/main.js")
 *
 * @example
 * extractPathnameFromResourceUrl("https://cdn.example.com/assets/main.js")
 * // returns "/assets/main.js"
 *
 * extractPathnameFromResourceUrl("/assets/main.js")
 * // returns "/assets/main.js"
 *
 * extractPathnameFromResourceUrl("assets/main.js")
 * // returns "/assets/main.js"
 */
export function extractPathnameFromResourceUrl(
	resourceUrl: string
): string {
	// Handle absolute HTTP/HTTPS and protocol-relative URLs
	if (isHttpUrl(resourceUrl)) {
		try {
			// For protocol-relative URLs, prepend https: for URL parsing
			const urlToParse = resourceUrl.startsWith("//")
				? `https:${resourceUrl}`
				: resourceUrl;
			const url = new URL(urlToParse);
			return url.pathname;
		} catch {
			// If URL parsing fails, fall through to normalization
		}
	}

	// For relative or root-relative URLs, normalize and ensure leading slash
	const normalized = normalizeBundlePath(resourceUrl) as string;
	return normalized.startsWith("/") ? normalized : `/${normalized}`;
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
 * Checks if a glob pattern matches a given string.
 * Supports simple glob patterns with '*' wildcards.
 *
 * Pattern matching rules:
 * - '*' matches any sequence of characters (including empty)
 * - Exact matches are supported
 * - Case-sensitive matching
 *
 * @param pattern - Glob pattern to match against
 * @param str - String to test
 * @returns true if pattern matches string
 *
 * @example
 * matchesPattern("*.js", "script.js") // true
 * matchesPattern("vendor-*", "vendor-react") // true
 * matchesPattern("exact.css", "exact.css") // true
 */
export function matchesPattern(pattern: string, str: string): boolean {
	if (!pattern || !str) return false;

	// Handle exact matches first for efficiency
	if (pattern === str) return true;

	// Convert glob pattern to regex
	// Escape special regex characters except for *
	const escaped = pattern
		.replace(/[.+?^${}()|[\]\\]/g, "\\$&") // Escape special regex chars
		.replace(/\*/g, ".*"); // Convert * to .*

	// Create regex with anchors to match entire string
	const regex = new RegExp(`^${escaped}$`);
	return regex.test(str);
}

/**
 * Determines if an element should be skipped based on skip patterns.
 * Checks both element ID and URL (src/href) attributes against patterns.
 *
 * Skip conditions:
 * - Element has an 'id' attribute matching any pattern
 * - Element has 'src' or 'href' attribute matching any pattern
 *
 * @param element - parse5 Element to check
 * @param skipPatterns - Array of glob patterns to match against
 * @returns true if element should be skipped
 *
 * @example
 * shouldSkipElement(scriptEl, ["analytics-*"]) // checks id and src
 * shouldSkipElement(linkEl, ["*.googleapis.com/*"]) // checks id and href
 */
export function shouldSkipElement(
	element: Element,
	skipPatterns: string[]
): boolean {
	if (!skipPatterns || skipPatterns.length === 0) return false;

	// Get element attributes for checking
	const id = getAttrValue(element, "id");
	const src = getAttrValue(element, "src");
	const href = getAttrValue(element, "href");

	// Check each skip pattern against available attributes
	for (const pattern of skipPatterns) {
		// Check ID attribute
		if (id && matchesPattern(pattern, id)) {
			return true;
		}

		// Check src attribute (for scripts)
		if (src && matchesPattern(pattern, src)) {
			return true;
		}

		// Check href attribute (for links)
		if (href && matchesPattern(pattern, href)) {
			return true;
		}
	}

	return false;
}

/**
 * Determines the appropriate URL attribute name for a parse5 Element.
 * Script elements use "src", all other elements use "href" by default.
 *
 * @param element - parse5 Element node
 * @returns "src" for script elements, "href" for others, null if invalid
 */
export function getUrlAttrName(element: Element): "src" | "href" | null {
	if (!element || !element.nodeName) return null;
	return element.nodeName.toLowerCase() === "script" ? "src" : "href";
}

/**
 * Helper function to find elements in parse5 document tree
 * @param node - Current node to search
 * @param predicate - Function to test each element
 * @returns Array of matching elements
 */
function findElements(
	node: Document | Element | ChildNode,
	predicate: (element: Element) => boolean
): Element[] {
	const results: Element[] = [];

	function traverse(current: Document | Element | ChildNode): void {
		// Type guard to check if current node is an Element
		if (
			"nodeName" in current &&
			"attrs" in current &&
			predicate(current as Element)
		) {
			results.push(current as Element);
		}
		if ("childNodes" in current && current.childNodes) {
			for (const child of current.childNodes) {
				traverse(child);
			}
		}
	}

	traverse(node);
	return results;
}

/**
 * Helper function to get attribute value from parse5 element
 * @param element - parse5 Element
 * @param name - Attribute name
 * @returns Attribute value or undefined
 */
function getAttrValue(element: Element, name: string): string | undefined {
	const attr = element.attrs.find((a: Token.Attribute) => a.name === name);
	return attr?.value;
}

/**
 * Index in head.childNodes at which plugin-injected elements (import map,
 * modulepreload links) should be inserted. The HTML spec wants the charset
 * declaration within the first 1024 bytes of the document, and the injected
 * content grows with chunk count — so insertion goes AFTER a
 * charset-declaring <meta>, provided it appears before any script or link
 * element (the import map must precede those). Falls back to the start of
 * head otherwise.
 */
function headInjectionIndex(head: Element): number {
	if (!head.childNodes) return 0;
	for (let i = 0; i < head.childNodes.length; i++) {
		const node = head.childNodes[i];
		if (!("tagName" in node)) continue; // text/comment nodes
		const el = node as Element;
		const tag = el.tagName?.toLowerCase();
		if (tag === "meta") {
			const httpEquiv = getAttrValue(el, "http-equiv")?.toLowerCase();
			if (
				getAttrValue(el, "charset") !== undefined ||
				httpEquiv === "content-type"
			) {
				return i + 1;
			}
			continue;
		}
		// A script or link already precedes any charset meta — injected
		// content must come before it, so insert at the head start.
		if (tag === "script" || tag === "link") return 0;
	}
	return 0;
}

/**
 * Helper function to set attribute value on parse5 element
 * @param element - parse5 Element
 * @param name - Attribute name
 * @param value - Attribute value
 */
function setAttrValue(element: Element, name: string, value: string): void {
	const existingAttr = element.attrs.find(
		(a: Token.Attribute) => a.name === name
	);
	if (existingAttr) {
		existingAttr.value = value;
	} else {
		element.attrs.push({ name, value });
	}
}

/**
 * Processes a single DOM element to add SRI attributes.
 * Loads the resource content, computes integrity, and updates element attributes.
 * Skips elements that already have integrity attributes to avoid conflicts.
 *
 * @param element - parse5 Element node
 * @param bundle - Bundle for resource lookup
 * @param algorithm - Hash algorithm for integrity computation
 * @param crossorigin - CORS setting to apply
 * @param resourceOpts - Resource loading configuration
 * @param preComputedHashes - Optional pre-computed integrity hashes by pathname
 * @param base - Resolved Vite base; stripped from resource URLs so
 * base-prefixed (e.g. absolute CDN) URLs match bundle-relative hash keys
 */
export async function processElement(
	element: Element,
	bundle: BundleLike,
	algorithm: "sha256" | "sha384" | "sha512",
	crossorigin?: "anonymous" | "use-credentials",
	resourceOpts?: LoadResourceOptions,
	preComputedHashes?: Record<string, string>,
	base?: string
): Promise<void> {
	if (!element || !element.attrs) return;

	// Preserve hand-written integrity: leave the element untouched
	if (getAttrValue(element, "integrity")) return;

	// Determine the URL attribute name (src or href)
	const attrName = getUrlAttrName(element);
	if (!attrName) return;

	const resourcePath = getAttrValue(element, attrName);
	if (!resourcePath) return;

	// Check for pre-computed integrity hash first
	let integrity: string | undefined;
	if (preComputedHashes && resourcePath) {
		// Extract pathname from resource URL (handles absolute CDN URLs)
		const pathname = extractPathnameFromResourceUrl(resourcePath);

		// Try to find a matching pre-computed hash
		// Check exact pathname first, then try normalized versions
		integrity = preComputedHashes[pathname];
		if (!integrity && base) {
			// Retry with the configured base's pathname stripped, mirroring
			// the runtime's lookupIntegrityByPathname: hash keys are
			// bundle-relative while sub-path and CDN-base deployments prefix
			// URLs with the base (issue #50). Parsing the base to a
			// trailing-slash pathname keeps the strip segment-aligned (a
			// base of "/app" cannot truncate "/app-legacy/x.js") and matches
			// protocol-relative URL forms of an absolute base.
			let basePathname = "/";
			try {
				basePathname = new URL(base, "http://x/").pathname;
				if (!basePathname.endsWith("/")) basePathname += "/";
			} catch {
				// Unparseable base (e.g. relative "./") — no stripping
			}
			if (basePathname !== "/" && pathname.startsWith(basePathname)) {
				integrity =
					preComputedHashes[
						`/${pathname.slice(basePathname.length)}`
					];
			}
		}
		if (!integrity) {
			const normalizedPath = normalizeBundlePath(pathname) as string;
			integrity =
				preComputedHashes[normalizedPath] ||
				preComputedHashes[`/${normalizedPath}`];
		}
	}

	// If no pre-computed hash found, compute it the traditional way
	if (!integrity) {
		// Load and process the resource
		const source = await loadResource(resourcePath, bundle, resourceOpts);
		if (!source) return;

		// Compute integrity from source
		integrity = computeIntegrity(source as any, algorithm);
	}

	// Apply integrity attribute
	setAttrValue(element, "integrity", integrity);

	// Apply crossorigin if specified
	if (crossorigin) {
		setAttrValue(element, "crossorigin", crossorigin);
	}
}

/**
 * Checks if an element matches the SRI-eligible criteria
 * @param element - parse5 Element to check
 * @param skipPatterns - Optional skip patterns to exclude elements
 * @returns true if element should have SRI attributes added
 */
export function isEligibleForSri(
	element: Element,
	skipPatterns?: string[]
): boolean {
	if (!element.nodeName || !element.attrs) return false;

	// Check skip patterns first if provided
	if (skipPatterns && shouldSkipElement(element, skipPatterns)) {
		return false;
	}

	const tagName = element.nodeName.toLowerCase();
	const rel = getAttrValue(element, "rel")?.toLowerCase();
	const as = getAttrValue(element, "as")?.toLowerCase();

	// Script elements with src attribute
	if (tagName === "script" && getAttrValue(element, "src")) {
		return true;
	}

	// Link elements with href attribute
	if (tagName === "link" && getAttrValue(element, "href")) {
		// Stylesheet links
		if (rel === "stylesheet") return true;

		// Module preload links
		if (rel === "modulepreload") return true;

		// Preload links for scripts or styles
		if (rel === "preload" && (as === "script" || as === "style"))
			return true;
	}

	return false;
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
 * @param logger - Logger for error reporting
 * @param options - Processing configuration options
 * @returns Promise resolving to HTML with SRI attributes added
 */
export async function addSriToHtml(
	html: string,
	bundle: BundleLike,
	logger: BundleLogger,
	{
		algorithm = "sha384",
		crossorigin,
		resourceOpts,
		skipResources = [],
		preComputedHashes,
		base,
	}: {
		algorithm?: "sha256" | "sha384" | "sha512";
		crossorigin?: "anonymous" | "use-credentials";
		resourceOpts?: LoadResourceOptions;
		skipResources?: string[];
		preComputedHashes?: Record<string, string>;
		base?: string;
	} = {}
): Promise<string> {
	try {
		// Parse the HTML using parse5
		const document = parse(html, {
			sourceCodeLocationInfo: false,
		});

		// Find all eligible elements for SRI processing
		const eligibleElements = findElements(document, (element) =>
			isEligibleForSri(element, skipResources)
		);

		// Process all elements in parallel with error handling
		await Promise.all(
			eligibleElements.map((element) =>
				processElement(
					element,
					bundle,
					algorithm,
					crossorigin,
					resourceOpts,
					preComputedHashes,
					base
				).catch((err: any) => {
					// Log processing errors but continue with other elements
					const src =
						getAttrValue(element, "src") ||
						getAttrValue(element, "href") ||
						"unknown";
					logger.error(
						`Failed to compute integrity for ${src}:`,
						err?.message || err
					);
				})
			)
		);

		// Serialize the document back to HTML
		return serialize(document);
	} catch (error) {
		logger.error(
			"Failed to parse HTML with parse5",
			error instanceof Error ? error : undefined
		);
		// Fallback to returning original HTML
		return html;
	}
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
export function createLogger(pluginContext: any, verbose: boolean = false): BundleLogger {
	if (pluginContext && typeof pluginContext.warn === "function") {
		return {
			warn: pluginContext.warn.bind(pluginContext),
			info: verbose ? pluginContext.info.bind(pluginContext) : () => {},
			error: pluginContext.error.bind(pluginContext),
			summary: pluginContext.info.bind(pluginContext),
		} as BundleLogger;
	} else {
		const infoFn = (msg: string) => console.info(`[vite-plugin-sri-gen] ${msg}`);
		return {
			warn: (msg: string) => console.warn(`[vite-plugin-sri-gen] ${msg}`),
			info: verbose ? infoFn : () => {},
			error: (msg: string, error?: Error) => {
				console.error(`[vite-plugin-sri-gen] ${msg}`, error);
			},
			summary: infoFn,
		} as BundleLogger;
	}
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
	 * @param options - Optional filtering options for chunk processing
	 * @param options.excludeEntryChunks - If true, skip entry chunks (for first-pass hashing)
	 * @param options.onlyEntryChunks - If true, only process entry chunks (for post-injection hashing)
	 * @returns Promise<Record<string, string>> - Mapping of pathname to integrity hash
	 */
	async buildIntegrityMappings(
		bundle: OutputBundle,
		options?: { excludeEntryChunks?: boolean; onlyEntryChunks?: boolean }
	): Promise<Record<string, string>> {
		const integrityMap: Record<string, string> = {};
		const bundleEntries = Object.entries(bundle);
		let processedCount = 0;
		let skippedCount = 0;

		const excludeEntryChunks = options?.excludeEntryChunks ?? false;
		const onlyEntryChunks = options?.onlyEntryChunks ?? false;

		if (excludeEntryChunks && onlyEntryChunks) {
			throw new Error(
				"Invalid integrity mapping options: 'excludeEntryChunks' and 'onlyEntryChunks' cannot both be true."
			);
		}

		const filterDescription = excludeEntryChunks
			? "non-entry chunks and assets"
			: onlyEntryChunks
				? "entry chunks only"
				: "all bundle assets";

		this.logger.info(
			`Processing ${bundleEntries.length} bundle entries for integrity computation (${filterDescription})`
		);

		// ========================================================================
		// PARALLEL PROCESSING WITH ERROR BOUNDARIES
		// ========================================================================

		// Process all bundle entries with individual error handling
		const processingPromises = bundleEntries.map(
			async ([fileName, bundleItem]) => {
				try {
					// Apply entry chunk filtering based on options
					if (bundleItem.type === "chunk") {
						const isEntry = (bundleItem as OutputChunk).isEntry;
						if (excludeEntryChunks && isEntry) {
							skippedCount++;
							return; // Skip entry chunks in first pass
						}
						if (onlyEntryChunks && !isEntry) {
							skippedCount++;
							return; // Skip non-entry chunks in second pass
						}
					} else if (onlyEntryChunks) {
						// When only processing entry chunks, skip all assets
						skippedCount++;
						return;
					}

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
	 * Per-bundle memos: analyzeDynamicImports and redundantImportMapChunks
	 * both derive the same chunk list and module-id map from the same bundle
	 * in one generateBundle pass. WeakMap keys mean a new bundle object gets
	 * fresh results and old bundles are garbage-collected with their caches.
	 *
	 * CAUTION: the cache is keyed by bundle object identity, not contents.
	 * Adding or removing bundle chunks between calls on the same analyzer
	 * instance returns stale results — do all bundle-shape mutation (e.g.
	 * runtime injection) BEFORE constructing the analyzer, or construct a
	 * fresh analyzer after mutating.
	 */
	private readonly chunksCache = new WeakMap<OutputBundle, OutputChunk[]>();
	private readonly idMapCache = new WeakMap<
		OutputBundle,
		Map<string, string>
	>();

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
	 * Filenames of chunks that are REDUNDANT in the import map: chunks that
	 * (a) no other chunk imports (statically or dynamically) AND (b) are
	 * referenced by an emitted HTML file. Such a chunk is loaded only via a
	 * rendered <script>/<link> tag, whose `integrity` attribute already
	 * protects it — so an import-map entry for it adds nothing (issue #41).
	 * A chunk reached through another chunk's static `import` or dynamic
	 * `import()` — even if it is also a declared entry — is NOT redundant:
	 * its module-graph fetch carries no integrity attribute and needs the
	 * map. Likewise a chunk with no import edges that is NOT referenced by
	 * any emitted HTML (e.g. an extra input consumed by server-rendered
	 * templates, or loaded via a runtime-constructed import(url)) stays in
	 * the map — nothing else protects it.
	 *
	 * Import identifiers are resolved with the same multi-strategy resolver as
	 * analyzeDynamicImports, so identifiers arriving as module IDs, bundle
	 * keys, or chunk names (Rollup/Rolldown/Vite differ here) all resolve.
	 */
	redundantImportMapChunks(bundle: OutputBundle): Set<string> {
		const idToFileMap = this.buildModuleIdMappings(bundle);
		const chunks = this.extractChunksFromBundle(bundle);
		const imported = new Set<string>();
		for (const chunk of chunks) {
			const ids = [
				...(chunk.imports || []),
				...(chunk.dynamicImports || []),
			];
			for (const id of ids) {
				const resolved = this.resolveDynamicImport(
					id,
					idToFileMap,
					bundle
				);
				if (resolved) {
					imported.add(resolved);
				} else {
					// An unresolved identifier could mean a genuinely-imported
					// chunk goes unrecognized; surface it like
					// analyzeDynamicImports does rather than failing silently.
					this.logger.warn(
						`Could not resolve import "${id}" to a chunk file`
					);
				}
			}
		}
		// Positive tag evidence: a chunk only counts as tag-covered when an
		// emitted HTML file references it via a <script src> or <link href>
		// attribute — the element shapes the SRI pass stamps. Inline-script
		// text, comments, or embedded JSON mentioning a filename are NOT
		// evidence, and absence of import edges alone is NOT proof of
		// coverage.
		const tagUrls: string[] = [];
		for (const [fileName, item] of Object.entries(bundle)) {
			if (
				item.type !== "asset" ||
				!fileName.toLowerCase().endsWith(".html")
			) {
				continue;
			}
			const source = (item as OutputAsset).source;
			let html: string;
			if (typeof source === "string") {
				html = source;
			} else if (source instanceof Uint8Array) {
				html = Buffer.from(source).toString("utf8");
			} else {
				// Malformed source — no tag evidence, chunk stays in the map.
				continue;
			}
			const document = parse(html, { sourceCodeLocationInfo: false });
			for (const el of findElements(document, (node) => {
				const name = node.nodeName?.toLowerCase();
				return name === "script" || name === "link";
			})) {
				const url = getAttrValue(
					el,
					el.nodeName.toLowerCase() === "script" ? "src" : "href"
				);
				// Strip query/hash so hashed-URL variants still match.
				if (url) tagUrls.push(url.split(/[?#]/)[0]);
			}
		}
		const isTagReferenced = (chunkFileName: string): boolean =>
			tagUrls.some(
				(url) =>
					url === chunkFileName ||
					url.endsWith("/" + chunkFileName)
			);
		const redundant = new Set<string>();
		for (const chunk of chunks) {
			if (imported.has(chunk.fileName)) continue;
			if (isTagReferenced(chunk.fileName)) {
				redundant.add(chunk.fileName);
			}
		}
		return redundant;
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
		const cached = this.idMapCache.get(bundle);
		if (cached) return cached;
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
		this.idMapCache.set(bundle, idToFileMap);
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
		const cached = this.chunksCache.get(bundle);
		if (cached) return cached;
		const chunks = Object.values(bundle).filter(
			(item): item is OutputChunk => item.type === "chunk"
		);
		this.chunksCache.set(bundle, chunks);
		return chunks;
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
		dynamicChunkFiles: Set<string>,
		redundantImportMapChunks: Set<string> = new Set()
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
					dynamicChunkFiles,
					redundantImportMapChunks
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
		dynamicChunkFiles: Set<string>,
		redundantImportMapChunks: Set<string>
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
		let processedHtml = await this.addSriToHtmlContent(
			htmlContent,
			bundle,
			sriByPathname
		);

		// ========================================================================
		// DYNAMIC CHUNK PRELOAD INJECTION
		// ========================================================================

		// Step 2: Add preload links for dynamic chunks (if enabled).
		//
		// With the import map disabled there is no inline-script channel, so the
		// preload set widens from "dynamically imported chunks" to the whole
		// module graph. That closes the one gap the map used to cover alone:
		// chunks reached only by a static `import` inside a lazy chunk, which
		// have no HTML element of their own and cannot be annotated at the
		// import site (there is no syntax for it). Manufacturing a
		// <link rel="modulepreload" integrity> is the only build-time way to
		// attach a hash to that fetch. Cost: those chunks are fetched eagerly.
		const preloadFiles =
			this.config.importMapIntegrity === false
				? new Set([
					...dynamicChunkFiles,
					...collectModuleChunkFiles(
						sriByPathname,
						this.config.skipResources,
						redundantImportMapChunks
					).map((f) => f.fileName),
				])
				: dynamicChunkFiles;

		if (this.config.preloadDynamicChunks && preloadFiles.size > 0) {
			processedHtml = await this.addDynamicChunkPreloads(
				processedHtml,
				preloadFiles,
				sriByPathname,
				fileName
			);
		}

		// ========================================================================
		// IMPORT MAP INTEGRITY INJECTION
		// ========================================================================

		// Step 3: Inject import map integrity (runs after preload injection so
		// the unshift places the map BEFORE the modulepreload links). Skipped
		// entirely when the inline-script channel is disabled — a strict CSP
		// without 'unsafe-inline' blocks the map, and a blocked map silently
		// delivers no integrity at all.
		if (this.config.importMapIntegrity !== false) {
			processedHtml = this.injectImportMap(
				processedHtml,
				sriByPathname,
				fileName,
				redundantImportMapChunks
			);
		}

		// ========================================================================
		// BUNDLE UPDATE
		// ========================================================================

		// Step 4: Update asset source with processed HTML
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
	 * @param sriByPathname - Pre-computed integrity hashes by pathname
	 * @returns Promise<string> - HTML with SRI attributes added
	 */
	private async addSriToHtmlContent(
		htmlContent: string,
		bundle: OutputBundle,
		sriByPathname: Record<string, string>
	): Promise<string> {
		return addSriToHtml(htmlContent, bundle as any, this.config.logger, {
			algorithm: this.config.algorithm,
			crossorigin: this.config.crossorigin,
			resourceOpts: {
				cache: this.config.remoteCache,
				pending: this.config.pending,
				enableCache: this.config.enableCache,
				fetchTimeoutMs: this.config.fetchTimeoutMs,
			},
			skipResources: this.config.skipResources,
			preComputedHashes: sriByPathname,
			base: this.config.base,
		});
	}

	/**
	 * Adds modulepreload links for dynamic chunks with integrity attributes.
	 * Uses parse5 for safe DOM manipulation and duplicate prevention.
	 *
	 * Features:
	 * - Safe DOM manipulation with parse5
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
		sriByPathname: Record<string, string>,
		htmlFileName: string
	): Promise<string> {
		try {
			// ====================================================================
			// DOM SETUP AND INITIALIZATION
			// ====================================================================

			// Parse HTML content with parse5
			const document = parse(htmlContent, {
				sourceCodeLocationInfo: false,
			});
			let addedCount = 0;

			// Find the head element
			const headElements = findElements(
				document,
				(el) => !!el.nodeName && el.nodeName.toLowerCase() === "head"
			);
			const head = headElements[0];
			if (!head) {
				this.config.logger.warn(
					"No head element found, skipping dynamic chunk preloads"
				);
				return htmlContent;
			}

			// ====================================================================
			// PRELOAD LINK GENERATION
			// ====================================================================

			// Process each dynamic chunk file
			for (const chunkFile of dynamicChunkFiles) {
				if (
					this.addPreloadLinkForChunk(
						head,
						chunkFile,
						sriByPathname,
						htmlFileName
					)
				) {
					addedCount++;
				}
			}

			// ====================================================================
			// COMPLETION AND STATISTICS
			// ====================================================================

			this.config.logger.info(
				`Added ${addedCount} modulepreload links for dynamic chunks`
			);
			return serialize(document);
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
	 * @param head - Head element from parse5 document
	 * @param chunkFile - Chunk file name
	 * @param sriByPathname - Integrity mappings
	 * @returns boolean - Whether a link was added
	 */
	private addPreloadLinkForChunk(
		head: Element,
		chunkFile: string,
		sriByPathname: Record<string, string>,
		htmlFileName: string
	): boolean {
		// ========================================================================
		// HREF GENERATION AND DUPLICATE CHECKING
		// ========================================================================

		// Build the href for THIS document — a relative base resolves against
		// the document's own URL, so a page in a subdirectory needs a different
		// string than one at the output root.
		const href = preloadHref(this.config.base, chunkFile, htmlFileName);

		// Check if preload link already exists (duplicate prevention)
		const existingPreloads = findElements(head, (el) => {
			if (el.nodeName?.toLowerCase() !== "link") return false;
			const rel = getAttrValue(el, "rel");
			const elHref = getAttrValue(el, "href");
			return rel === "modulepreload" && elHref === href;
		});
		if (existingPreloads.length > 0) {
			return false; // Skip duplicate
		}

		// ========================================================================
		// INTEGRITY VALIDATION
		// ========================================================================

		// Honour the user's opt-out. collectModuleChunkFiles already filters the
		// widened set, but dynamicChunkFiles comes straight from the chunk graph
		// and has no skipResources awareness — without this check a skipped
		// chunk that happens to be a dynamic import target would still be
		// preloaded with an integrity attribute, silently overriding an explicit
		// exclusion that the import map channel honours.
		if (isSkippedResource(chunkFile, this.config.skipResources)) {
			return false;
		}

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

		// Create a new link element
		const linkElement: Element = {
			nodeName: "link",
			tagName: "link",
			attrs: [
				{ name: "rel", value: "modulepreload" },
				{ name: "href", value: href },
				{ name: "integrity", value: integrity },
			],
			namespaceURI: "http://www.w3.org/1999/xhtml" as any,
			childNodes: [],
			parentNode: head,
			sourceCodeLocation: undefined,
		};

		// Add crossorigin attribute if configured
		if (this.config.crossorigin) {
			linkElement.attrs.push({
				name: "crossorigin",
				value: this.config.crossorigin,
			});
		}

		// Insert at the head start, but after a leading charset meta — the
		// charset declaration must stay within the first 1024 bytes and the
		// number of injected links grows with chunk count.
		if (!head.childNodes) {
			head.childNodes = [];
		}
		head.childNodes.splice(headInjectionIndex(head), 0, linkElement);

		return true;
	}

	/**
	 * Injects (or merges into) a `<script type="importmap">` carrying an
	 * `integrity` object for every emitted JS module chunk. Browsers
	 * supporting import map integrity (Chrome 127+, Firefox 138+,
	 * Safari 18+) then enforce SRI natively on static AND dynamic module
	 * imports — single fetch, no TOCTOU. Older browsers ignore the
	 * `integrity` key (progressive enhancement, same model as SRI attributes
	 * generally).
	 *
	 * Must run AFTER addDynamicChunkPreloads: both insert at the same
	 * computed head position (see headInjectionIndex), so running last places
	 * the import map ahead of the injected links — the spec requires it
	 * before any module script or modulepreload link.
	 *
	 * No-ops (returning the input unchanged) when: base is relative (the
	 * resulting keys — bare or document-relative — cannot be used portably
	 * across pages in subdirectories), no JS chunks exist, <head> is missing,
	 * or an existing import map contains unparseable JSON (warned).
	 */
	private injectImportMap(
		htmlContent: string,
		sriByPathname: Record<string, string>,
		fileName: string,
		redundantImportMapChunks: Set<string>
	): string {
		const integrityObject = buildImportIntegrityObject(
			sriByPathname,
			this.config.base,
			this.config.skipResources,
			redundantImportMapChunks
		);
		// Relative base — no valid keys can be produced. The build-level log
		// in generateBundle reports this once instead of once per HTML file.
		if (integrityObject === null) {
			return htmlContent;
		}
		if (Object.keys(integrityObject).length === 0) {
			return htmlContent;
		}

		try {
			const document = parse(htmlContent, {
				sourceCodeLocationInfo: false,
			});
			const head = findElements(
				document,
				(el) => el.nodeName?.toLowerCase() === "head"
			)[0];
			if (!head) {
				this.config.logger.warn(
					`No <head> element found in ${fileName}, skipping import map injection`
				);
				return htmlContent;
			}

			// An absolute-URL <base href> changes the document base URL the
			// browser resolves import map keys against — root-relative keys
			// like "/assets/x.js" would resolve against the <base> origin and
			// may never match the URLs modules are actually served from.
			// Build-time is the only place this is detectable; warn.
			const baseEl = findElements(head, (el) => {
				return (
					el.nodeName?.toLowerCase() === "base" &&
					isHttpUrl(getAttrValue(el, "href"))
				);
			});
			if (baseEl.length > 0) {
				this.config.logger.warn(
					`${fileName} contains <base href="${getAttrValue(baseEl[0], "href")}">; import map integrity keys resolve against the document base URL and may not match the served module URLs`
				);
			}

			const existingMaps = findElements(head, (el) => {
				if (el.nodeName?.toLowerCase() !== "script") return false;
				return getAttrValue(el, "type")?.toLowerCase() === "importmap";
			});

			if (existingMaps.length > 0) {
				// Browsers process multiple import maps inconsistently across
				// versions — merge into the first map instead of adding
				// another.
				const existingEl = existingMaps[0];
				const textChild = existingEl.childNodes.find(
					(n): n is TextNode => n.nodeName === "#text"
				);
				let parsed: {
					integrity?: Record<string, string>;
					[k: string]: unknown;
				};
				try {
					parsed = JSON.parse(textChild?.value ?? "{}");
				} catch {
					this.config.logger.warn(
						`Existing <script type="importmap"> in ${fileName} contains invalid JSON; integrity entries not merged`
					);
					return htmlContent;
				}
				// User-authored integrity entries win on key collision — but a
				// divergence between a user-pinned hash and the build-computed
				// hash is almost always a mistake (stale template, or a
				// tampered build input), so surface it loudly.
				const userIntegrity = parsed.integrity ?? {};
				// Compare against the UNFILTERED hashes: a user-pinned entry
				// for a tag-covered chunk (excluded from the injected map) is
				// just as likely to be stale or tampered, so it still gets
				// flagged even though we no longer emit that key ourselves.
				const fullIntegrityObject =
					buildImportIntegrityObject(
						sriByPathname,
						this.config.base,
						this.config.skipResources
					) ?? {};
				for (const [key, value] of Object.entries(userIntegrity)) {
					if (
						key in fullIntegrityObject &&
						fullIntegrityObject[key] !== value
					) {
						this.config.logger.warn(
							`Existing import map in ${fileName} pins integrity for ${key} (${String(value)}) that differs from the build-computed hash (${fullIntegrityObject[key]}); keeping the existing entry`
						);
					}
				}
				parsed.integrity = {
					...integrityObject,
					...userIntegrity,
				};
				const json = escapeForScript(JSON.stringify(parsed));
				if (textChild) {
					textChild.value = json;
				} else {
					existingEl.childNodes.push({
						nodeName: "#text",
						value: json,
						parentNode: existingEl,
					} as TextNode);
				}
			} else {
				const json = escapeForScript(
					JSON.stringify({ integrity: integrityObject })
				);
				const textNode = {
					nodeName: "#text",
					value: json,
					parentNode: null,
				} as unknown as TextNode;
				const importMapEl: Element = {
					nodeName: "script",
					tagName: "script",
					attrs: [{ name: "type", value: "importmap" }],
					namespaceURI: "http://www.w3.org/1999/xhtml" as any,
					childNodes: [textNode],
					parentNode: head,
					sourceCodeLocation: undefined,
				};
				(textNode as any).parentNode = importMapEl;
				if (!head.childNodes) head.childNodes = [];
				// Same insertion point the preload links use: after a leading
				// charset meta (which must stay within the first 1024 bytes —
				// the map grows with chunk count), otherwise the head start.
				// Inserting at the same index AFTER the preload pass places
				// the map before every injected link.
				head.childNodes.splice(headInjectionIndex(head), 0, importMapEl);
			}

			return serialize(document);
		} catch (error) {
			this.config.logger.error(
				`Failed to inject import map into ${fileName}: ${
					error instanceof Error ? error.message : String(error)
				}`,
				error instanceof Error ? error : undefined
			);
			return htmlContent;
		}
	}
}

// #endregion

// =======================================================
// #region MANIFEST PROCESSING
// =======================================================

/**
 * Minimal recognized shape of a Vite manifest entry. Any unrecognized fields
 * are preserved untouched during augmentation.
 */
type ViteManifestEntry = {
	file: string;
	css?: string[];
	integrity?: string;
	cssIntegrity?: Array<string | null>;
	[key: string]: unknown;
};

type ViteManifest = Record<string, ViteManifestEntry>;

/**
 * Injects SRI integrity values into Vite-emitted manifest.json files.
 *
 * Behavior:
 * - Purely additive: augments entries with `integrity` (for `file`) and
 *   `cssIntegrity` (parallel array for `css`). Non-matching entries remain
 *   unchanged.
 * - Skips `.vite/ssr-manifest.json` (different schema).
 * - Honors skipResources patterns — files matching a pattern get no integrity.
 * - Never overwrites an existing `integrity`/`cssIntegrity` value.
 * - On JSON parse failure or unexpected shape, warns and leaves the asset alone.
 */
export class ManifestProcessor {
	private static readonly KNOWN_MANIFEST_NAMES: ReadonlySet<string> = new Set([
		".vite/manifest.json",
		"manifest.json",
	]);
	private static readonly SSR_MANIFEST_NAME = ".vite/ssr-manifest.json";

	constructor(private readonly logger: BundleLogger) {}

	/**
	 * Finds every Vite-style manifest asset in the bundle and augments each
	 * entry with an integrity value (for the primary `file`) and a parallel
	 * `cssIntegrity` array (for the `css` array, when present).
	 *
	 * @param bundle Rollup OutputBundle
	 * @param sriByPathname Map of pathnames (with leading `/`) to SRI hashes
	 * @param skipResources skipResources patterns — matching files get no integrity
	 * @returns counts of manifest files processed and entries augmented
	 */
	injectIntegrity(
		bundle: OutputBundle,
		sriByPathname: Record<string, string>,
		skipResources: string[]
	): { processedFiles: number; augmentedEntries: number } {
		let processedFiles = 0;
		let augmentedEntries = 0;

		for (const [fileName, bundleItem] of Object.entries(bundle)) {
			if (bundleItem.type !== "asset") continue;
			if (!this.isManifestCandidate(fileName)) continue;

			const asset = bundleItem as OutputAsset;
			const raw = this.assetSourceToString(asset.source);
			if (raw === null) continue;

			const isKnown = this.isKnownManifestName(fileName);

			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch (err) {
				// For known Vite manifest paths, a parse failure is worth warning about.
				// For custom *manifest.json assets, stay silent — they may be unrelated
				// (PWA manifests, plugin-emitted metadata, etc.).
				if (isKnown) {
					this.logger.warn(
						`Failed to parse Vite manifest at ${fileName}; leaving untouched. ${
							err instanceof Error ? err.message : String(err)
						}`
					);
				}
				continue;
			}

			if (!this.isManifestShape(parsed, fileName, isKnown)) continue;

			// For non-known names, require a shape that actually looks like a Vite
			// build manifest (at least one entry with a string `file`) before we
			// risk mutating or noisily warning on its contents.
			if (!isKnown && !this.looksLikeViteManifest(parsed)) continue;

			const count = this.augmentManifest(
				parsed,
				sriByPathname,
				skipResources,
				fileName
			);

			if (count > 0) {
				asset.source = JSON.stringify(parsed, null, 2);
				augmentedEntries += count;
				processedFiles++;
			}
		}

		return { processedFiles, augmentedEntries };
	}

	private isManifestCandidate(fileName: string): boolean {
		if (fileName === ManifestProcessor.SSR_MANIFEST_NAME) return false;
		if (ManifestProcessor.KNOWN_MANIFEST_NAMES.has(fileName)) return true;
		// Accept custom names ending in manifest.json (user-configured build.manifest string).
		// Strict shape validation in looksLikeViteManifest ensures non-Vite manifests
		// (PWA, Webpack, arbitrary plugin output) are silently ignored.
		return fileName.endsWith("manifest.json");
	}

	private isKnownManifestName(fileName: string): boolean {
		return ManifestProcessor.KNOWN_MANIFEST_NAMES.has(fileName);
	}

	private assetSourceToString(source: unknown): string | null {
		if (typeof source === "string") return source;
		if (source instanceof Uint8Array) {
			try {
				return new TextDecoder().decode(source);
			} catch {
				return null;
			}
		}
		return null;
	}

	private isManifestShape(
		manifest: unknown,
		fileName: string,
		isKnown: boolean
	): manifest is ViteManifest {
		if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
			if (isKnown) {
				this.logger.warn(
					`Vite manifest at ${fileName} is not a plain object; skipping integrity injection.`
				);
			}
			return false;
		}
		return true;
	}

	/**
	 * Duck-type check: true if the object looks like a Vite build manifest
	 * (at least one own-property value is an object with a string `file`).
	 * Used to filter out unrelated *manifest.json assets emitted by other plugins.
	 */
	private looksLikeViteManifest(manifest: ViteManifest): boolean {
		for (const value of Object.values(manifest)) {
			if (
				value &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				typeof (value as ViteManifestEntry).file === "string"
			) {
				return true;
			}
		}
		return false;
	}

	private augmentManifest(
		manifest: ViteManifest,
		sriByPathname: Record<string, string>,
		skipResources: string[],
		fileName: string
	): number {
		let augmented = 0;
		for (const [key, entry] of Object.entries(manifest)) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				this.logger.warn(
					`Skipping manifest entry "${key}" in ${fileName}: not an object.`
				);
				continue;
			}
			if (typeof (entry as ViteManifestEntry).file !== "string") {
				this.logger.warn(
					`Skipping manifest entry "${key}" in ${fileName}: missing string "file".`
				);
				continue;
			}

			let touched = false;

			// Primary file integrity (never overwrite existing)
			if (typeof entry.integrity !== "string") {
				const hash = this.lookupHash(
					entry.file,
					sriByPathname,
					skipResources
				);
				if (hash) {
					entry.integrity = hash;
					touched = true;
				}
			}

			// Parallel cssIntegrity array (never overwrite existing)
			if (
				Array.isArray(entry.css) &&
				entry.css.length > 0 &&
				!Array.isArray(entry.cssIntegrity)
			) {
				const cssIntegrity: Array<string | null> = [];
				let haveAny = false;
				for (const cssFile of entry.css) {
					if (typeof cssFile !== "string") {
						cssIntegrity.push(null);
						continue;
					}
					const hash = this.lookupHash(
						cssFile,
						sriByPathname,
						skipResources
					);
					cssIntegrity.push(hash ?? null);
					if (hash) haveAny = true;
				}
				if (haveAny) {
					entry.cssIntegrity = cssIntegrity;
					touched = true;
				}
			}

			if (touched) augmented++;
		}
		return augmented;
	}

	private lookupHash(
		file: string,
		sriByPathname: Record<string, string>,
		skipResources: string[]
	): string | undefined {
		if (this.isSkipped(file, skipResources)) return undefined;
		const key = file.startsWith("/") ? file : `/${file}`;
		return sriByPathname[key];
	}

	private isSkipped(file: string, skipResources: string[]): boolean {
		return isSkippedResource(file, skipResources);
	}
}

// #endregion

// =======================================================
// #region RUNTIME SRI INJECTION
// =======================================================

/** Synthetic filename reported to the minifier for diagnostics only. */
const RUNTIME_FILENAME = "sri-runtime.js";

/**
 * The minifier surface this module needs from Vite. Both members are optional:
 * which one exists depends on the consumer's Vite major.
 */
export interface ViteMinifiers {
	/** Vite 8+: rolldown's (OXC) minifier, re-exported as first-class Vite API. */
	minifySync?: (
		filename: string,
		source: string
	) => { code: string; errors?: unknown[] } | undefined;
	/** Vite 4-7: esbuild, which those versions depend on directly. */
	transformWithEsbuild?: (
		source: string,
		filename: string,
		options: Record<string, unknown>
	) => Promise<{ code: string }>;
}

/**
 * Loads Vite so its minifier can be borrowed for the injected runtime.
 *
 * A bare `import("vite")` covers npm, pnpm and Yarn PnP: `vite` is this
 * plugin's declared peer dependency, so every linker is obliged to expose it to
 * us. It does NOT cover a symlinked plugin (`npm link`, or a `file:` dependency
 * pointing outside the consumer's tree): Node resolves this module to its
 * realpath before walking `node_modules` ancestry, and that realpath has no
 * Vite above it. The consumer's project root always does, so resolving from
 * there recovers the symlinked case.
 *
 * Ordering matters. The bare import is the broadly-verified path and stays
 * primary; the root anchor runs only once it has failed.
 *
 * The fallback resolves `vite/package.json` and targets the ESM entry by path
 * rather than resolving the `vite` specifier itself. `createRequire().resolve`
 * applies CJS conditions, and Vite 4-6 map those to an `index.cjs` shim that
 * prints a CJS-deprecation warning into the consumer's build the moment it is
 * loaded. Every major from 4 to 8 places the ESM entry at the same path, and
 * `vite/package.json` is an exported subpath in all of them. If either
 * assumption ever breaks, the import throws and the caller keeps the
 * unminified source — the same outcome as having no fallback at all.
 *
 * @param root - The consumer's resolved `config.root`
 * @param primary - Injected primary importer (defaults to `import("vite")`)
 */
export async function loadVite(
	root: string,
	primary: () => Promise<unknown> = () => import("vite")
): Promise<ViteMinifiers> {
	try {
		return (await primary()) as ViteMinifiers;
	} catch {
		const req = createRequire(
			pathToFileURL(path.join(root, "package.json")).href
		);
		const viteDir = path.dirname(req.resolve("vite/package.json"));
		return (await import(
			pathToFileURL(path.join(viteDir, "dist", "node", "index.js")).href
		)) as ViteMinifiers;
	}
}

/**
 * Minifies the serialized SRI runtime at the CONSUMER's build time.
 *
 * `installSriRuntime` is not build-time-only code: it is serialized with
 * `.toString()` and prepended to every entry chunk, so its source bytes are
 * shipped to browsers. This plugin publishes its own `dist` unminified on
 * purpose (see tsup.config.ts), and the consumer's minifier cannot reclaim
 * those bytes either, because the runtime is injected in `generateBundle`,
 * which runs after the `renderChunk` hooks where minification happens. Left
 * alone that costs ~8.8 KB per entry chunk at default settings against ~4.3 KB
 * minified, a little under half (issue #45).
 *
 * When measuring this, note that importing the plugin by absolute/relative path
 * in a scratch `vite.config` understates the unminified figure by ~15%: Vite's
 * config loader bundles path imports and reprints this module before
 * `.toString()` reads it. Bare specifiers stay external, so a real install sees
 * the full size.
 *
 * The minifier is reached through `vite` rather than by importing `esbuild` or
 * `rolldown` directly. That is deliberate: `vite` is this plugin's declared
 * peer dependency, so it resolves from the plugin's own scope under every
 * package manager, whereas a bare `import("esbuild")` is a phantom dependency
 * that fails under pnpm and Yarn PnP — silently disabling this optimisation
 * for a large share of consumers. Vite re-exports whichever minifier its major
 * ships with, so going through it also covers both eras with one import.
 *
 * `minifySync` is tried first because `transformWithEsbuild` is deprecated on
 * Vite 8: it warns when esbuild happens to be installed, and throws outright
 * when it is not — which is the common case there, since Vite 8 demoted esbuild
 * to an optional peer. Capability detection keeps that branch unreachable on
 * Vite 8, and the surrounding catch makes the failure harmless if it is ever
 * reached anyway.
 *
 * `target: "esnext"` is load-bearing, not cosmetic. Downlevelling makes esbuild
 * hoist helpers (`__async`, `__spreadValues`, ...) ABOVE the function and
 * therefore outside the serialized text, reproducing the undefined-helper
 * failure of issue #30. `keepNames: false` is pinned for the same reason — that
 * transform is what caused #30 in the first place. The `startsWith("function")`
 * guard is the backstop: any output that grew a prologue is discarded in favour
 * of the original source, which is always self-contained.
 *
 * Every failure path returns `source` unchanged, which is exactly the behaviour
 * that shipped before minification existed.
 *
 * @param source - `installSriRuntime.toString()`
 * @param logger - Optional logger; failures are reported at info level
 * @param load - Injected Vite loader (defaults to the real `vite` import)
 */
export async function minifyRuntimeSource(
	source: string,
	logger?: BundleLogger,
	load: () => Promise<ViteMinifiers> = () => import("vite")
): Promise<string> {
	try {
		const vite = await load();
		let minified: string | undefined;

		if (typeof vite.minifySync === "function") {
			// minifySync reports failures in an `errors` array rather than
			// throwing, and still returns a `code` field alongside it. Treating
			// that as success would ship whatever partial output it produced.
			const result = vite.minifySync(RUNTIME_FILENAME, source);
			if (result?.errors?.length) {
				logger?.info(
					`SRI runtime minification skipped: ${String(
						result.errors[0]
					)}`
				);
				return source;
			}
			minified = result?.code;
		} else if (typeof vite.transformWithEsbuild === "function") {
			minified = (
				await vite.transformWithEsbuild(source, RUNTIME_FILENAME, {
					minify: true,
					target: "esnext",
					keepNames: false,
				})
			)?.code;
		} else {
			logger?.info(
				"SRI runtime minification skipped: this Vite version exposes no minifier"
			);
			return source;
		}

		const trimmed = typeof minified === "string" ? minified.trim() : "";
		if (!trimmed.startsWith("function")) {
			logger?.info(
				"SRI runtime minification skipped: minifier output was not a bare function declaration"
			);
			return source;
		}
		return trimmed;
	} catch (err) {
		logger?.info(
			`SRI runtime minification skipped: ${
				err instanceof Error ? err.message : String(err)
			}`
		);
		return source;
	}
}

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
 * @param opts - Configuration options for CORS settings and skip patterns
 */
export function installSriRuntime(
	sriByPathname: Record<string, string>,
	opts?: {
		crossorigin?: false | "anonymous" | "use-credentials";
		skipResources?: string[];
		enforceDynamicImports?: boolean;
		base?: string;
	}
) {
	// Sentinel that escapes the outer best-effort catch. Enforcement-install
	// failures (foreign global takeover, environment missing crypto.subtle)
	// MUST surface to the caller — they indicate a security-relevant problem,
	// not the kind of advisory failure the outer catch is designed to absorb.
	let enforcementError: Error | undefined;
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

		// Extract skip patterns with default fallback
		const skipPatterns = (opts && (opts as any).skipResources) || [];

		// Pathname of the configured Vite `base` ("/" when unset). Map keys
		// are '/'-rooted bundle file names WITHOUT the base prefix, while
		// URLs observed at runtime include it under sub-path (or CDN-base)
		// deployments — the lookup helper strips it before retrying.
		let basePathname = "/";
		try {
			const rawBase = opts && (opts as any).base;
			if (rawBase && typeof rawBase === "string") {
				basePathname = new URL(rawBase, "http://x/").pathname;
				if (!basePathname.endsWith("/")) basePathname += "/";
			}
		} catch {
			// Unparseable base (e.g. relative "./") — keep "/" (no stripping)
		}

		/**
		 * Looks up an integrity value by URL pathname. Tries the pathname as
		 * given, then retries with the configured base prefix stripped so a
		 * key of "/assets/x.js" matches "/app/assets/x.js" when base="/app/".
		 */
		const lookupIntegrityByPathname = (
			pathname: string
		): string | undefined => {
			let value = map.get(pathname);
			if (
				value === undefined &&
				basePathname !== "/" &&
				pathname.indexOf(basePathname) === 0
			) {
				value = map.get(
					"/" + pathname.slice(basePathname.length)
				);
			}
			return value;
		};

		/**
		 * Runtime version of pattern matching for skip logic
		 */
		const matchesPatternRuntime = (
			pattern: string,
			str: string
		): boolean => {
			if (!pattern || !str) return false;
			if (pattern === str) return true;

			// Convert glob pattern to regex
			const escaped = pattern
				.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
				.replace(/\*/g, ".*");

			const regex = new RegExp(`^${escaped}$`);
			return regex.test(str);
		};

		/**
		 * Runtime check if element should be skipped
		 */
		const shouldSkipElementRuntime = (el: any): boolean => {
			if (!skipPatterns || skipPatterns.length === 0) return false;

			const id = el.getAttribute && el.getAttribute("id");
			const src = el.getAttribute && el.getAttribute("src");
			const href = el.getAttribute && el.getAttribute("href");

			for (const pattern of skipPatterns) {
				if (
					(id && matchesPatternRuntime(pattern, id)) ||
					(src && matchesPatternRuntime(pattern, src)) ||
					(href && matchesPatternRuntime(pattern, href))
				) {
					return true;
				}
			}

			return false;
		};

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
				value = lookupIntegrityByPathname(u.pathname);
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

			// Check skip patterns first
			if (shouldSkipElementRuntime(el)) return;

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
		// JAVASCRIPT-LEVEL DYNAMIC IMPORT VERIFICATION
		// ========================================================================
		// Install before DOM patching so the helper is available even in
		// environments without DOM globals (Workers, SSR runtimes), where the
		// subsequent DOM patch block would otherwise short-circuit via the
		// outer catch.
		if (opts && (opts as any).enforceDynamicImports) try {
			const g: any = globalThis as any;
			const subtleAlgoFor = (integrity: string): string | null => {
				const dash = integrity.indexOf("-");
				if (dash <= 0) return null;
				const prefix = integrity.slice(0, dash);
				if (prefix === "sha256") return "SHA-256";
				if (prefix === "sha384") return "SHA-384";
				if (prefix === "sha512") return "SHA-512";
				return null;
			};
			const bytesToBase64 = (bytes: Uint8Array): string => {
				let binary = "";
				const chunkSize = 0x8000;
				for (let i = 0; i < bytes.length; i += chunkSize) {
					binary += String.fromCharCode.apply(
						null,
						bytes.subarray(i, i + chunkSize) as any
					);
				}
				return btoa(binary);
			};
			// `importerUrl` is the importing module's `import.meta.url`,
			// threaded through by the build-time rewrite
			// (`import(x)` -> `__sriImport(import.meta.url, x)`). Native
			// `import()` resolves relative specifiers against the importing
			// module's URL, so the runtime must resolve the same way —
			// resolving against `location.href` yields the wrong pathname
			// for Rollup's module-relative inter-chunk specifiers like
			// "./asset.js" (issue #32).
			//
			// Residual limitation: verification (`fetch`) and execution
			// (native `import()`) are two separate requests for the same
			// resolved URL. The HTTP cache normally makes them coherent, but
			// a service worker (or a cache-busting intermediary) could in
			// principle serve different bytes to each. Browsers do not
			// expose integrity metadata on `import()`, so this TOCTOU window
			// cannot be fully closed at the JS level — resolving both
			// requests from one URL (this fix) is the strongest available
			// guarantee.
			const sriImport = async function (
				importerUrl: string | undefined,
				url: string
			): Promise<any> {
				// Fail closed if the crypto primitive is unavailable. Browsers
				// only expose crypto.subtle in secure contexts (HTTPS or
				// localhost). A clear error beats a confusing TypeError.
				if (
					typeof crypto === "undefined" ||
					!(crypto as any).subtle ||
					typeof btoa === "undefined"
				) {
					throw new Error(
						"[vite-plugin-sri-gen] Cannot verify dynamic import for " +
							url +
							": crypto.subtle is unavailable (requires a secure context, e.g. HTTPS or localhost)"
					);
				}
				// Resolve the specifier ONCE; the same resolved URL is used
				// for lookup, fetch, and the native import so the verified
				// bytes are exactly the executed bytes.
				let resolved: URL;
				try {
					resolved = new URL(
						url,
						importerUrl ||
							(globalThis as any).location?.href ||
							undefined
					);
				} catch (e) {
					// `cause` is ignored by engines that predate ES2022 Error
					// options; the message alone still identifies the failure.
					throw new Error(
						"[vite-plugin-sri-gen] Cannot resolve dynamic import specifier " +
							url +
							(importerUrl ? " against " + importerUrl : ""),
						{ cause: e }
					);
				}
				const expected = lookupIntegrityByPathname(resolved.pathname);
				if (!expected) {
					throw new Error(
						"[vite-plugin-sri-gen] Refusing dynamic import: no integrity registered for " +
							url +
							" (resolved to " +
							resolved.href +
							")"
					);
				}
				const subtleAlgo = subtleAlgoFor(expected);
				if (!subtleAlgo) {
					throw new Error(
						"[vite-plugin-sri-gen] Unsupported integrity algorithm: " +
							expected
					);
				}
				// Match the credentials semantics of <script crossorigin=...>
				// per HTML §2.6.10: "anonymous" => mode cors + credentials
				// "same-origin"; "use-credentials" => credentials "include".
				// When crossorigin is unset, fall through to "same-origin" as
				// the conservative default — this matches browser behavior for
				// modulepreload links without an explicit crossorigin attr.
				const init: any = {};
				if (cors === "use-credentials") init.credentials = "include";
				else init.credentials = "same-origin";
				const response = await fetch(resolved.href, init);
				if (!response.ok) {
					throw new Error(
						"[vite-plugin-sri-gen] Failed to fetch " +
							resolved.href +
							" for integrity verification (HTTP " +
							response.status +
							")"
					);
				}
				const buffer = await response.arrayBuffer();
				const digest = await crypto.subtle.digest(subtleAlgo, buffer);
				const actual =
					expected.slice(0, expected.indexOf("-") + 1) +
					bytesToBase64(new Uint8Array(digest));
				if (actual !== expected) {
					throw new Error(
						"[vite-plugin-sri-gen] Integrity verification failed for " +
							resolved.href +
							" (expected " +
							expected +
							", got " +
							actual +
							")"
					);
				}
				// __sriNativeImport is installed below before sriImport is
				// invoked for the first time, so we can call it directly.
				// Pass the RESOLVED absolute URL: the native import executes
				// inside the entry chunk, where a relative specifier would
				// re-resolve against the entry chunk's URL instead of the
				// original importer's.
				return g.__sriNativeImport(resolved.href);
			};
			// Detect pre-installation tampering: if either global is already
			// set and was NOT installed by this plugin, refuse to proceed.
			// This closes the obvious bypass where an inline <script> tag (or
			// an earlier-loaded third-party script such as a tag manager)
			// pre-defines `__sriImport` with a passthrough function, knowing
			// our former `if (!g.__sriImport)` guard would skip installation.
			//
			// We do NOT defend against post-install replacement of these
			// globals: code that runs after the entry chunk has already won
			// — it can call the platform's native `import()` directly, since
			// only build-time bundle bytes were rewritten. The realistic
			// threat we defend against is pre-installation, which this check
			// addresses by failing closed.
			const TAG = "__vitePluginSriGen";
			const isOurs = (fn: any): boolean =>
				!!fn && (fn as any)[TAG] === true;
			if (g.__sriImport && !isOurs(g.__sriImport)) {
				throw new Error(
					"[vite-plugin-sri-gen] Refusing to install: globalThis.__sriImport is already defined by another script. This indicates a pre-installation tampering attempt; dynamic import enforcement cannot proceed."
				);
			}
			if (
				g.__sriNativeImport &&
				!isOurs(g.__sriNativeImport)
			) {
				throw new Error(
					"[vite-plugin-sri-gen] Refusing to install: globalThis.__sriNativeImport is already defined by another script."
				);
			}
			const nativeImport: any = (u: string) =>
				import(/* @vite-ignore */ u);
			(nativeImport as any)[TAG] = true;
			(sriImport as any)[TAG] = true;
			g.__sriNativeImport = nativeImport;
			g.__sriImport = sriImport;
		} catch (e) {
			// Capture and re-throw after the outer best-effort catch so
			// foreign-takeover / unsupported-environment errors surface
			// instead of being silenced. DOM patches still run below.
			// All throws inside the enforcement-install block are Error
			// instances we construct, so no wrapping is needed.
			enforcementError = e as Error;
		}

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
	if (enforcementError) throw enforcementError;
}

/**
 * Testable version of installSriRuntime with dependency injection.
 * This version accepts dependencies to enable proper testing without global overrides.
 *
 * @param sriByPathname - Map of pathnames to their SRI integrity values
 * @param opts - Configuration options for CORS settings and skip patterns
 * @param dependencies - Injected dependencies for DOM/URL operations (defaults to production)
 */
export function installSriRuntimeWithDeps(
	sriByPathname: Record<string, string>,
	opts?: {
		crossorigin?: false | "anonymous" | "use-credentials";
		skipResources?: string[];
		base?: string;
	},
	dependencies: IRuntimeDependencies = defaultDependencies
) {
	try {
		const { domAdapter, nodeAdapter, urlAdapter } = dependencies;

		// Convert pathname mapping to Map for efficient lookup
		const map = new Map<string, string>(
			Object.entries(sriByPathname || {})
		);

		// Extract CORS configuration with default fallback
		const cors =
			opts && Object.prototype.hasOwnProperty.call(opts, "crossorigin")
				? (opts as any).crossorigin
				: "anonymous";

		// Extract skip patterns with default fallback
		const skipPatterns = (opts && (opts as any).skipResources) || [];

		/**
		 * Runtime version of pattern matching for skip logic
		 */
		const matchesPatternRuntime = (
			pattern: string,
			str: string
		): boolean => {
			if (!pattern || !str) return false;
			if (pattern === str) return true;

			// Convert glob pattern to regex
			const escaped = pattern
				.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
				.replace(/\*/g, ".*");

			const regex = new RegExp(`^${escaped}$`);
			return regex.test(str);
		};

		/**
		 * Runtime check if element should be skipped using DOM adapter
		 */
		const shouldSkipElementRuntime = (el: any): boolean => {
			if (!skipPatterns || skipPatterns.length === 0) return false;

			// Use element's getAttribute method directly as DOM adapter doesn't expose it
			const id = el.getAttribute && el.getAttribute("id");
			const src = el.getAttribute && el.getAttribute("src");
			const href = el.getAttribute && el.getAttribute("href");

			for (const pattern of skipPatterns) {
				if (
					(id && matchesPatternRuntime(pattern, id)) ||
					(src && matchesPatternRuntime(pattern, src)) ||
					(href && matchesPatternRuntime(pattern, href))
				) {
					return true;
				}
			}

			return false;
		};

		// Pathname of the configured Vite `base` ("/" when unset) — mirrors
		// the production `installSriRuntime` so base-stripped lookups behave
		// identically in both variants.
		let basePathname = "/";
		try {
			const rawBase = opts && (opts as any).base;
			if (rawBase && typeof rawBase === "string") {
				basePathname = new URL(rawBase, "http://x/").pathname;
				if (!basePathname.endsWith("/")) basePathname += "/";
			}
		} catch {
			// Unparseable base (e.g. relative "./") — keep "/" (no stripping)
		}

		/**
		 * Looks up an integrity value by URL pathname, retrying with the
		 * configured base prefix stripped (parity with installSriRuntime).
		 */
		const lookupIntegrityByPathname = (
			pathname: string
		): string | undefined => {
			let value = map.get(pathname);
			if (
				value === undefined &&
				basePathname !== "/" &&
				pathname.indexOf(basePathname) === 0
			) {
				value = map.get("/" + pathname.slice(basePathname.length));
			}
			return value;
		};

		/**
		 * Gets integrity value for a given URL using the URL adapter
		 */
		const getIntegrityForUrl = (
			url: string | null | undefined
		): string | undefined => {
			if (!url) return undefined;

			try {
				const resolvedURL = urlAdapter.resolveURL(url);
				const u = new URL(resolvedURL);
				return lookupIntegrityByPathname(u.pathname);
			} catch {
				// URL parsing failed - ignore and return undefined
				return undefined;
			}
		};

		/**
		 * Processes an element to potentially add SRI attributes using the DOM adapter
		 */
		const maybeSetIntegrity = (el: any) => {
			if (!el) return;

			// Check skip patterns first
			if (shouldSkipElementRuntime(el)) return;

			// Use DOM adapter for element type checking
			const isLink = domAdapter.isHTMLLinkElement(el);
			const isScript = domAdapter.isHTMLScriptElement(el);

			if (!isLink && !isScript) return;

			// Check if element is eligible for SRI using DOM adapter
			if (!domAdapter.isEligibleForSRI(el)) return;

			// Get URL using DOM adapter
			const url = domAdapter.getElementURL(el);
			if (!url) return;

			// Look up integrity for this URL
			const integrity = getIntegrityForUrl(url);
			if (!integrity) return;

			// Apply integrity using DOM adapter (handles errors internally)
			domAdapter.setIntegrityAttributes(el, integrity, cors || undefined);
		};

		// Use node adapter to wrap setAttribute method
		const elementProto = (Element as any)?.prototype;
		if (elementProto) {
			nodeAdapter.wrapSetAttribute(elementProto, maybeSetIntegrity);
		}

		// Use node adapter to wrap DOM insertion methods
		const nodeProto = (Node as any)?.prototype;

		if (nodeProto) {
			nodeAdapter.wrapNodeInsertion(
				nodeProto,
				"appendChild",
				maybeSetIntegrity
			);
			nodeAdapter.wrapNodeInsertion(
				nodeProto,
				"insertBefore",
				maybeSetIntegrity
			);
		}

		if (elementProto) {
			nodeAdapter.wrapNodeInsertion(
				elementProto,
				"append",
				maybeSetIntegrity
			);
			nodeAdapter.wrapNodeInsertion(
				elementProto,
				"prepend",
				maybeSetIntegrity
			);
		}
	} catch {
		// Ignore all errors at the top level to prevent runtime failures
		// The runtime SRI injection is an enhancement, not a requirement
	}
}

// #endregion
