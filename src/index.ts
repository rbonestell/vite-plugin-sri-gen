import type { Plugin, PluginOption, ResolvedConfig, Rollup } from "vite";

// Vite re-exports the Rollup bundle types under its `Rollup` namespace. Sourcing
// them from Vite (rather than directly from "rollup") keeps the plugin aligned
// with whichever bundler Vite uses — Rollup on Vite ≤7, Rolldown on Vite 8 — so
// the generateBundle signature stays compatible across the full peer range.
type NormalizedOutputOptions = Rollup.NormalizedOutputOptions;
type OutputBundle = Rollup.OutputBundle;
import type { BundleLogger } from "./internal";
import {
	collectModuleChunkFiles,
	createLogger,
	DynamicImportAnalyzer,
	escapeForScript,
	handleGenerateBundleError,
	HtmlProcessor,
	installSriRuntime,
	IntegrityProcessor,
	isImportMapCapableBase,
	loadVite,
	ManifestProcessor,
	minifyRuntimeSource,
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
	/**
	 * Deliver module-graph integrity via an inline `<script type="importmap">`.
	 * Default: true.
	 *
	 * Import maps must be inline — the HTML spec forbids `src` on
	 * `<script type="importmap">` — so a `script-src` without `'unsafe-inline'`,
	 * a matching hash, or a nonce will block the map. A blocked map delivers no
	 * integrity, silently.
	 *
	 * Set to false for strict-CSP deployments: no inline script is emitted, and
	 * the same hashes are delivered as `<link rel="modulepreload" integrity>`
	 * instead, which needs no CSP cooperation. Coverage is preserved — the
	 * preload set widens to the full module graph so chunks reached only by a
	 * static import inside a lazy chunk stay verified. Those chunks are then
	 * fetched eagerly rather than on demand.
	 *
	 * Requires `preloadDynamicChunks` (the default) to remain enabled — that is
	 * the channel the hashes move to. With both off, chunks reached only by a
	 * static import inside a lazy chunk have no channel at all and the build
	 * warns.
	 *
	 * The widened set is bundle-wide, not per page, so in a multi-page build
	 * every HTML file preloads every module-graph chunk, including chunks
	 * private to other pages.
	 */
	importMapIntegrity?: boolean;
	/**
	 * Inject a tiny runtime that sets integrity on dynamically inserted
	 * <script>/<link>. Default: true.
	 *
	 * The runtime is minified before injection, independently of how the rest of
	 * the bundle is built, because it is added after the minification stage runs.
	 * Setting Vite's `build.minify: false` opts it out along with everything else.
	 */
	runtimePatchDynamicLinks?: boolean;
	/** Skip SRI generation for resources matching these patterns. Supports exact matches and simple glob patterns with '*'. */
	skipResources?: string[];
	/** Enable verbose build logging. When false (default), only warnings, errors, and a completion summary are shown. */
	verboseLogging?: boolean;
}

let logger: BundleLogger;

/**
 * Pattern matching JavaScript dynamic `import(` call sites while excluding:
 *   - the static `import` declaration form (no following `(`),
 *   - `import.meta` accesses (no following `(`),
 *   - method or property accesses such as `foo.import(` (preceded by `.`),
 *   - identifiers like `myimport(` or `$import(` (preceded by word char or `$`).
 *
 * The negative lookbehind keeps the rewrite surgical: only the call-expression
 * form of `import` is replaced.
 */
const DYNAMIC_IMPORT_CALL_RE = /(?<![.\w$])import\s*\(/g;

/**
 * Rewrites every dynamic `import(...)` call expression in a chunk to
 * `__sriImport(import.meta.url, ...)` so the runtime-injected JS-level
 * verifier can enforce integrity before executing the module. The original
 * `import(` syntax inside the runtime itself is preserved because the runtime
 * is concatenated AFTER this rewrite step.
 *
 * `import.meta.url` is threaded through as the first argument because native
 * `import()` resolves relative specifiers against the IMPORTING MODULE's URL,
 * not the document URL. Rollup emits inter-chunk dynamic imports as
 * module-relative specifiers (e.g. `import('./asset.js')` from a chunk in
 * `assets/js/`), so without the importer's URL the runtime would resolve the
 * specifier against `location.href` and look up the wrong pathname
 * (issue #32). The injected `import.meta.url` text is never re-matched by the
 * rewrite regex: `import` there is followed by `.`, not `(`.
 */
export function rewriteDynamicImports(code: string): string {
	if (!code || typeof code !== "string") return code;
	if (code.indexOf("import") === -1) return code;
	return code.replace(DYNAMIC_IMPORT_CALL_RE, "__sriImport(import.meta.url, ");
}

/**
 * Builds the self-contained runtime statement that is prepended to entry
 * chunks. The runtime is shipped by serializing `installSriRuntime` with
 * `.toString()` and embedding the source into the consumer's bundle.
 *
 * The plugin itself is bundled with esbuild (via tsup), whose `keepNames`
 * transform can wrap named function expressions in a module-scoped
 * `__name(fn, "name")` helper. That helper lives at the top of the plugin's
 * own output — NOT inside the serialized function — so the injected copy
 * references an `__name` that is undefined in the consumer bundle. Because the
 * runtime guards its setup in a best-effort `try/catch`, the resulting
 * `ReferenceError: __name is not defined` is swallowed and
 * `globalThis.__sriImport` is never installed; every rewritten dynamic import
 * then fails with "`__sriImport` is not defined" (issue #30).
 *
 * To keep the injected runtime correct regardless of how the plugin is
 * bundled, the serialized function is evaluated inside a wrapper that defines a
 * local `__name` shim in its lexical scope. `__name` only needs to return its
 * first argument; the function-name assignment it performs is cosmetic.
 *
 * `opts.base` is the resolved Vite `base` (defaults to "/"). It is forwarded
 * to the runtime so integrity lookups can strip the base prefix from URLs
 * observed at runtime — the integrity map keys are '/'-rooted bundle file
 * names that never include the base.
 *
 * @param runtime - Either the runtime function (serialized here via
 * `.toString()`) or already-serialized source. The plugin passes source that
 * has been through `minifyRuntimeSource` first, which is why this accepts a
 * string; passing the function directly yields the unminified form.
 * @returns The complete statement to prepend to an entry chunk.
 */
export function buildSriRuntimeCode(
	runtime:
		| ((
				sriByPathname: Record<string, string>,
				opts?: Record<string, unknown>
		  ) => void)
		| string,
	sriByPathname: Record<string, string>,
	opts: {
		crossorigin: "anonymous" | "use-credentials" | undefined;
		skipResources: string[];
		enforceDynamicImports: boolean;
		base?: string;
	}
): string {
	// The serialized data is embedded as a JS string literal inside code that
	// is prepended to a chunk; escapeForScript (shared with the import map
	// injection) keeps the injected statement well-formed and safe if a chunk
	// is ever inlined into HTML. This only changes the source representation;
	// the parsed runtime values are identical.
	const serializedMap = escapeForScript(JSON.stringify(sriByPathname));
	const cors = opts.crossorigin ? JSON.stringify(opts.crossorigin) : "false";
	const serializedSkipPatterns = escapeForScript(
		JSON.stringify(opts.skipResources)
	);
	const serializedBase = escapeForScript(JSON.stringify(opts.base ?? "/"));
	const args = `${serializedMap}, { crossorigin: ${cors}, skipResources: ${serializedSkipPatterns}, enforceDynamicImports: ${opts.enforceDynamicImports}, base: ${serializedBase} }`;
	// A pre-serialized string is accepted so the caller can run the source
	// through minifyRuntimeSource (async) while this stays a synchronous,
	// side-effect-free string assembler. `args` is deliberately never minified:
	// a minifier parses escapeForScript's `<` back to a plain `<` and re-emits
	// it in whatever form it prefers, which would leave script-breakout safety
	// to the minifier's heuristics instead of the explicit escaping above. The
	// arguments are single-line JSON anyway, so there is nothing to reclaim.
	const runtimeSource =
		typeof runtime === "string" ? runtime : runtime.toString();
	// Self-containment shim — see the doc comment above for why this is needed.
	const shim = "var __name=function(fn){return fn;};";
	return `\n(function(){${shim}return (${runtimeSource});})()(${args});\n`;
}

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
	const importMapIntegrity = options.importMapIntegrity !== false; // default true
	const runtimePatchDynamicLinks = options.runtimePatchDynamicLinks !== false; // default true
	const skipResources = options.skipResources ?? []; // default empty array
	const verboseLogging = options.verboseLogging === true; // default false

	// Build-time state
	let base = "/";
	// The consumer's project root; anchors Vite resolution when this plugin is
	// symlinked into the project (see loadVite).
	let viteRoot = process.cwd();
	// Mirrors the consumer's `build.minify`. Only an explicit `false` disables
	// minification of the injected runtime; every other value ("esbuild",
	// "terser", "oxc", true) leaves it enabled.
	let minifyRuntime = true;
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
			minifyRuntime = config.build?.minify !== false;
			viteRoot = config.root || process.cwd();

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
					// Step 1: Validate inputs. Emit any validation warning (e.g. the
					// SSR-no-HTML diagnostic) but only short-circuit the entire handler
					// when there is genuinely nothing to do — neither HTML nor a Vite
					// manifest to augment. Processing a manifest with no HTML is the
					// primary target of issue #23 (backend-owned HTML generation).
					const validationResult = validateGenerateBundleInputs(
						bundle,
						isSSR
					);
					if (
						validationResult.shouldWarn &&
						validationResult.message
					) {
						logger.warn(validationResult.message);
					}
					if (
						!bundle ||
						typeof bundle !== "object" ||
						Object.keys(bundle).length === 0
					) {
						return;
					}
					const hasHtmlFiles = Object.entries(bundle).some(
						([fn, item]) =>
							fn.toLowerCase().endsWith(".html") &&
							item &&
							(item as any).type === "asset"
					);
					const hasManifestFiles = Object.entries(bundle).some(
						([fn, item]) =>
							item &&
							(item as any).type === "asset" &&
							fn !== ".vite/ssr-manifest.json" &&
							fn.endsWith("manifest.json")
					);
					// Preserve existing no-op behavior when the bundle produces neither
					// HTML nor a manifest — nothing for this plugin to do.
					if (!hasHtmlFiles && !hasManifestFiles) {
						return;
					}
					// Logged once per build (not per HTML file): with a
					// relative base, import map integrity keys cannot be
					// expressed portably, so HTML processing skips injection.
					if (hasHtmlFiles && !isImportMapCapableBase(base)) {
						logger.info(
							`Import map SRI skipped: relative base "${base}" cannot produce valid import map keys`
						);
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

					// Whether the import map can cover every consumer of this
					// bundle. It cannot when there is no HTML in the bundle
					// (backend-owned HTML / manifest consumers), when a manifest
					// is emitted ALONGSIDE HTML (the manifest consumer's
					// server-rendered pages have no import map), when base is
					// relative (no valid import map keys), or when the user
					// disabled the inline-script channel outright (strict CSP),
					// in which case no map is emitted at all.
					const importMapCapable =
						importMapIntegrity &&
						hasHtmlFiles &&
						!hasManifestFiles &&
						isImportMapCapableBase(base);
					const enforceDynamicImports =
						!preloadDynamicChunks && !importMapCapable;

					if (runtimePatchDynamicLinks) {
						// Step 2a-pre: Rewrite dynamic import() call sites when
						// JS-level enforcement is active. This is performed BEFORE
						// any hashing so the served bytes match the hashed bytes.
						// Activation condition: the user has disabled the
						// build-time modulepreload injection (preloadDynamicChunks
						// is false) AND the import map cannot cover every consumer
						// of this bundle (see importMapCapable above). Wherever
						// the import map covers all consumers it subsumes this
						// path — the browser enforces SRI natively on module
						// fetches (single fetch, no rewrite, source maps kept).
						if (enforceDynamicImports) {
							// ORDERING INVARIANT: this rewrite MUST run before
							// any hashing AND before the runtime is injected
							// into entry chunks. The runtime contains its own
							// `import(/* @vite-ignore */ url)` calls (preserved
							// as the native-import escape hatch); rewriting it
							// would cause infinite recursion at runtime. The
							// hash-then-serve contract also requires that the
							// rewritten bytes are the bytes we hash.
							logger.info(
								"Rewriting dynamic import() calls to enforce SRI in JavaScript"
							);
							let rewrittenChunks = 0;
							for (const bundleItem of Object.values(bundle)) {
								if (bundleItem.type !== "chunk") continue;
								const rewritten = rewriteDynamicImports(
									bundleItem.code
								);
								if (rewritten !== bundleItem.code) {
									bundleItem.code = rewritten;
									// Invalidate the source map: byte offsets
									// have shifted by 5 characters per match
									// and the existing mappings are no longer
									// accurate. Downstream consumers will fall
									// back to no source map for these chunks.
									(bundleItem as any).map = null;
									rewrittenChunks++;
								}
							}
							if (rewrittenChunks > 0) {
								logger.info(
									`Rewrote dynamic import() calls in ${rewrittenChunks} chunk(s)`
								);
							}
						}

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
						// Minified separately from the assembly step below so the
						// escaped JSON arguments never pass through a minifier.
						// Honours the consumer's `build.minify: false`: someone
						// who asked for a readable bundle wants this readable
						// too, and 4 KB is irrelevant in a debug build.
						const runtimeSource = minifyRuntime
							? await minifyRuntimeSource(
								installSriRuntime.toString(),
								logger,
								() => loadVite(viteRoot)
							  )
							: installSriRuntime.toString();
						const runtimeCode = buildSriRuntimeCode(
							runtimeSource,
							nonEntryHashes,
							{
								crossorigin,
								skipResources,
								enforceDynamicImports,
								base,
							}
						);

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

					// Step 3: Discover and map dynamic import relationships
					logger.info("Analyzing dynamic import relationships");
					const dynamicImportAnalyzer = new DynamicImportAnalyzer(
						logger
					);
					dynamicChunkFiles =
						dynamicImportAnalyzer.analyzeDynamicImports(bundle);

					// Step 4: Process HTML files with comprehensive error handling.
					// Skipped when the bundle emits no HTML (e.g. backend-owned HTML generation).
					if (hasHtmlFiles) {
						logger.info("Processing HTML files for SRI injection");
						// Only consumed by the import-map injection below — no
						// point walking the graph for manifest-only builds.
						const redundantImportMapChunks =
							dynamicImportAnalyzer.redundantImportMapChunks(
								bundle,
								base,
								skipResources
							);

						// Never degrade coverage silently. Model every channel
						// explicitly and warn about whatever none of them reach,
						// rather than inferring it from one flag pair — the
						// earlier flag-based guard missed the case this exists to
						// catch (relative base at stock defaults: no map, narrow
						// preloads, no rewrite, and no warning).
						//
						// A module-graph chunk is covered when:
						//  - the import map is emitted (covers every chunk), or
						//  - modulepreload injection reaches it: the whole graph
						//    when widened, otherwise only dynamic import targets,
						//    or
						//  - the import() rewrite is active AND it is a dynamic
						//    import target. The rewrite hooks call sites, so it
						//    can never reach a chunk pulled by a STATIC import
						//    inside a lazy chunk.
						//
						// Gated on chunks actually existing, so a single-bundle
						// build with no module-graph fetches stays quiet.
						const moduleChunks = collectModuleChunkFiles(
							sriByPathname,
							skipResources,
							redundantImportMapChunks
						).map((f) => f.fileName);
						const covered = new Set<string>();
						// A chunk every reaching page references via a stamped
						// module tag (a <script type="module"> or Vite's own
						// <link rel="modulepreload">) is already protected by the
						// SRI attribute pass, regardless of base or channel.
						// Without this credit, statically-imported chunks that
						// Vite preloads were over-reported (issue #52).
						dynamicImportAnalyzer
							.htmlTagCoveredChunks(bundle, base, skipResources)
							.forEach((f) => covered.add(f));
						if (importMapCapable) {
							moduleChunks.forEach((f) => covered.add(f));
						}
						if (preloadDynamicChunks) {
							if (!importMapIntegrity) {
								moduleChunks.forEach((f) => covered.add(f));
							} else {
								dynamicChunkFiles.forEach((f) => covered.add(f));
							}
						}
						if (enforceDynamicImports && runtimePatchDynamicLinks) {
							dynamicChunkFiles.forEach((f) => covered.add(f));
						}
						const uncovered = moduleChunks.filter(
							(f) => !covered.has(f)
						);
						if (uncovered.length > 0) {
							logger.warn(
								`${uncovered.length} module-graph chunk(s) will load without SRI — no active mechanism covers them. ` +
									"Set importMapIntegrity: false to cover them with modulepreload links (requires preloadDynamicChunks). " +
									`Affected: ${uncovered.slice(0, 5).join(", ")}${uncovered.length > 5 ? `, +${uncovered.length - 5} more` : ""}`
							);
						}

						const htmlProcessor = new HtmlProcessor({
							algorithm,
							crossorigin,
							base,
							preloadDynamicChunks,
							importMapIntegrity,
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
							dynamicChunkFiles,
							redundantImportMapChunks
						);
					}

					// Step 5: Inject SRI integrity into Vite manifest(s), if emitted.
					// Purely additive — no-op when build.manifest is disabled.
					logger.info("Injecting SRI integrity into Vite manifest (if present)");
					const manifestProcessor = new ManifestProcessor(logger);
					const manifestResult = manifestProcessor.injectIntegrity(
						bundle,
						sriByPathname,
						skipResources
					);
					if (manifestResult.processedFiles > 0) {
						logger.info(
							`Manifest integrity: ${manifestResult.augmentedEntries} entr(ies) updated across ${manifestResult.processedFiles} manifest file(s)`
						);
					}

					const assetCount = Object.keys(sriByPathname).length;
					const htmlCount = Object.values(bundle).filter(
						(item) =>
							item.type === "asset" &&
						typeof item.fileName === "string" &&
						item.fileName.endsWith(".html")
					).length;
					const manifestSummary =
						manifestResult.processedFiles > 0
							? `, ${manifestResult.processedFiles} manifest file(s) updated`
							: "";
					logger.summary(
						`SRI generation completed: ${assetCount} asset(s) processed, ${htmlCount} HTML file(s) updated${manifestSummary}`
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
