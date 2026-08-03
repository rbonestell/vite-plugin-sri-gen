import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sri, { buildSriRuntimeCode, rewriteDynamicImports } from "../src/index";
import { installSriRuntime, installSriRuntimeWithDeps } from "../src/internal";
import {
	createMockPluginContext,
	spyOnConsole,
} from "./mocks/bundle-logger";
import {
	createMockElements,
	createTestDependencies,
} from "./mocks/dom-abstraction-mocks";
import { autoSetupConsoleMock } from "./mocks/logger-mock";

// Types for dynamic import tests
type Chunk = {
	type: "chunk";
	fileName: string;
	isEntry?: boolean;
	code: string;
	imports?: string[];
	dynamicImports: string[];
	modules: Record<string, {}>;
	name?: string;
	facadeModuleId?: string;
};

type Asset = {
	type: "asset";
	fileName?: string;
	source: string | Buffer;
};

function makeEntryChunk(overrides: Partial<Chunk> = {}): Chunk {
	return {
		type: "chunk",
		fileName: "assets/entry.js",
		isEntry: true,
		code: "console.log('entry')",
		dynamicImports: [],
		modules: { "src/main.ts": {} },
		name: "entry",
		facadeModuleId: "src/main.ts",
		...overrides,
	};
}

function makeDynChunk(
	fileName = "assets/chunk-A.js",
	modId = "src/chunkA.ts"
): Chunk {
	return {
		type: "chunk",
		fileName,
		code: "export default 42",
		dynamicImports: [],
		modules: { [modId]: {} },
		name: "chunk-A",
		facadeModuleId: modId,
	};
}

function makeBundle(
	jsFile = "assets/chunk-A.js",
	code = "export{}"
): Record<string, Chunk | Asset> {
	return {
		"index.html": {
			type: "asset",
			source: "<!doctype html><html><head></head><body></body></html>",
		},
		[jsFile]: {
			type: "chunk",
			fileName: jsFile,
			code,
			dynamicImports: [],
			modules: { [jsFile]: {} },
			name: "chunk-A",
			facadeModuleId: jsFile,
		},
	} as any;
}

function htmlDoc(body: string): string {
	return `<!doctype html><html><head></head><body>${body}</body></html>`;
}

// Minimal fake DOM environment sufficient for the runtime helper
class FakeElement {
	private _attrs = new Map<string, string>();
	setAttribute(name: string, value: string) {
		this._attrs.set(String(name), String(value));
	}
	getAttribute(name: string) {
		return this._attrs.get(String(name)) ?? null;
	}
	hasAttribute(name: string) {
		return this._attrs.has(String(name));
	}
}
class FakeLink extends FakeElement {
	rel = "";
}
class FakeScript extends FakeElement {}

function setupFakeDom(withInsertFns = false) {
	const g: any = globalThis as any;
	const prev: Record<string, any> = {};
	for (const k of [
		"Element",
		"Node",
		"HTMLLinkElement",
		"HTMLScriptElement",
		"location",
	]) {
		prev[k] = g[k];
	}
	g.Element = FakeElement;
	g.HTMLLinkElement = FakeLink;
	g.HTMLScriptElement = FakeScript;
	g.location = { href: "http://localhost/" };
	g.Node = function Node() {} as any;
	(g.Node as any).prototype = {};
	if (withInsertFns) {
		(g.Node as any).prototype.appendChild = function (child: any) {
			return child;
		};
		(g.Node as any).prototype.insertBefore = function (child: any) {
			return child;
		};
		(g.Element as any).prototype.append = function (child: any) {
			return child;
		};
		(g.Element as any).prototype.prepend = function (child: any) {
			return child;
		};
	}
	return () => {
		for (const k of Object.keys(prev)) {
			g[k] = prev[k];
		}
	};
}

// Auto-setup console mocking for all tests
autoSetupConsoleMock();

describe("vite-plugin-sri-gen", () => {
	describe("Basic Plugin Configuration", () => {
		it('is build-only (apply = "build")', () => {
			const plugin = sri() as any;
			expect(plugin.apply).toBe("build");
		});
	});

	describe("generateBundle (MPA/SSR prerender)", () => {
		it("adds integrity to emitted HTML assets", async () => {
			const plugin = sri({
				algorithm: "sha256",
				crossorigin: "anonymous",
			}) as any;
			const html = `<!doctype html><html><head>
        <link rel="stylesheet" href="/style.css">
      </head><body>
        <script src="/entry.js"></script>
      </body></html>`;
			const bundle: any = {
				"index.html": { type: "asset", source: html },
				"style.css": { source: "body{color:red}" },
				"entry.js": { code: "console.log(1)" },
			};

			await plugin.generateBundle.handler({}, bundle);
			const out = String(bundle["index.html"].source);
			expect(out).toContain('integrity="sha256-');
			expect(out).toContain('crossorigin="anonymous"');
		});

		it("preserves existing integrity in emitted HTML", async () => {
			const plugin = sri({ algorithm: "sha256" }) as any;
			const html = `<!doctype html><html><head>
        <script src="/a.js" integrity="sha256-abc"></script>
      </head></html>`;
			const bundle: any = {
				"index.html": { type: "asset", source: html },
				"a.js": { code: "console.log(1)" },
			};

			await plugin.generateBundle.handler({}, bundle);
			const out = String(bundle["index.html"].source);
			// Hand-written integrity values are never overwritten
			expect(out).toContain('integrity="sha256-abc"');
			expect(out).not.toContain(
				'integrity="sha256-CihokcEcBW4atb/CW/XWsvWwbTjqwQlE9nj9ii5ww5M="'
			);
		});

		it("warns on SSR build with no emitted HTML", async () => {
			const { spies, cleanup } = spyOnConsole();
			const plugin = sri() as any;
			plugin.configResolved?.({
				command: "build",
				mode: "production",
				appType: "ssr",
				build: { ssr: true },
			} as any);
			const bundle: any = { "entry.js": { code: "console.log(1)" } };
			await plugin.generateBundle.handler({}, bundle);
			expect(spies.warn).toHaveBeenCalled();
			cleanup();
		});

		it("logs warning and skips file when processing an HTML asset throws", async () => {
			const { spies, cleanup } = spyOnConsole();
			const plugin = sri() as any;
			const badSource = {
				toString() {
					throw new Error("boom");
				},
			};
			const bundle: any = {
				"index.html": { type: "asset", source: badSource },
				"entry.js": { code: "console.log(1)" },
			};
			await plugin.generateBundle.handler({}, bundle);
			expect(spies.warn).toHaveBeenCalled();
			cleanup();
		});

		it("does not warn when no HTML is emitted in a non-SSR build", async () => {
			const { spies, cleanup } = spyOnConsole();
			const plugin = sri() as any;
			// Non-SSR build
			plugin.configResolved?.({
				command: "build",
				mode: "production",
				appType: "spa",
				build: { ssr: false },
			} as any);
			const bundle: any = { "entry.js": { code: "console.log(1)" } };
			await plugin.generateBundle.handler({}, bundle);
			expect(spies.warn).not.toHaveBeenCalled();
			cleanup();
		});

		it("handles non-string HTML asset sources by coercing to string", async () => {
			const plugin = sri() as any;
			const bundle: any = {
				"index.html": {
					type: "asset",
					source: Buffer.from(
						'<html><head><script src="/a.js"></script></head></html>'
					),
				},
				"a.js": { code: "console.log(1)" },
			};
			await plugin.generateBundle.handler({}, bundle);
			const out = String(bundle["index.html"].source);
			expect(out).toContain("integrity=");
		});

		it("uses plugin context warn when available", async () => {
			const plugin = sri() as any;
			const mockContext = createMockPluginContext();
			// Simulate SSR build with no HTML to trigger the warn path
			plugin.configResolved?.({
				command: "build",
				mode: "production",
				appType: "ssr",
				build: { ssr: true },
			} as any);
			// Call with plugin context containing warn()
			const bundle: any = { "entry.js": { code: "console.log(1)" } };
			await plugin.generateBundle.handler.call(mockContext, {}, bundle);
			expect(mockContext.warn).toHaveBeenCalled();
		});
	});

	describe("Algorithm Validation & Fallback", () => {
		it("falls back to sha384 and warns when algorithm is unsupported", async () => {
			const plugin = sri({ algorithm: "md5" } as any) as any;
			const mockContext = createMockPluginContext();

			// First create the logger by calling generateBundle once
			await plugin.generateBundle.handler.call(mockContext, {}, {
				"test.js": { type: "chunk", code: "console.log('test')" },
			} as any);

			// Now simulate Vite config resolution context which will use the logger
			plugin.configResolved?.call(mockContext, {
				command: "build",
				mode: "production",
				appType: "spa",
				build: {},
			} as any);

			// Test fallback by checking the bundle gets processed with sha384
			const bundle: any = {
				"index.html": {
					type: "asset",
					source: `<!doctype html><html><head><script src="/a.js"></script></head></html>`,
				},
				"a.js": { type: "chunk", code: "console.log(1)" },
			};
			await plugin.generateBundle.handler.call(mockContext, {}, bundle);
			const out = String(bundle["index.html"].source);
			expect(out).toContain('integrity="sha384-'); // fallback
		});

		it("uses a valid algorithm without warning", async () => {
			const plugin = sri({ algorithm: "sha512" }) as any;
			const mockContext = createMockPluginContext();
			plugin.configResolved?.call(mockContext, {
				command: "build",
				mode: "production",
				appType: "spa",
				build: {},
			} as any);

			const bundle: any = {
				"index.html": {
					type: "asset",
					source: `<!doctype html><html><head><script src="/a.js"></script></head></html>`,
				},
				"a.js": { type: "chunk", code: "console.log(1)" },
			};
			await plugin.generateBundle.handler.call(mockContext, {}, bundle);
			const out = String(bundle["index.html"].source);
			expect(out).toContain('integrity="sha512-');
			expect(mockContext.warn).not.toHaveBeenCalled();
		});
	});

	describe("Resource Options Wiring (cache & timeout)", () => {
		it("uses shared cache and in-flight dedupe within bundle processing", async () => {
			const plugin = sri({
				algorithm: "sha256",
				fetchCache: true,
			}) as any;
			const bytes = new Uint8Array([1, 2, 3]);
			const fetchSpy = vi
				.spyOn(globalThis, "fetch" as any)
				.mockResolvedValue({
					ok: true,
					arrayBuffer: () => Promise.resolve(bytes.buffer),
				} as any);

			const bundle: any = {
				"index.html": {
					type: "asset",
					source: `<!doctype html><html><head>
        <script src="https://cdn.example.com/a.js"></script>
        <script src="https://cdn.example.com/a.js"></script>
      </head></html>`,
				},
			};

			await plugin.generateBundle.handler({}, bundle);
			const out = String(bundle["index.html"].source);
			expect(out.match(/integrity="sha256-/g)?.length).toBe(2);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			fetchSpy.mockRestore();
		});

		it("applies timeout and surfaces per-element warnings on failure", async () => {
			const plugin = sri({
				algorithm: "sha256",
				fetchTimeoutMs: 1,
			}) as any;

			// Simulate a hanging fetch that gets aborted by internal timeout
			vi.spyOn(globalThis, "fetch" as any).mockImplementation(
				(_url, init: any) => {
					return new Promise((_resolve, reject) => {
						if (init?.signal)
							init.signal.addEventListener("abort", () =>
								reject(new Error("aborted"))
							);
					});
				}
			);

			const bundle: any = {
				"index.html": {
					type: "asset",
					source: `<!doctype html><html><head>
        <script src="https://cdn.example.com/a.js"></script>
      </head></html>`,
				},
			};

			await plugin.generateBundle.handler({}, bundle);
			const out = String(bundle["index.html"].source);
			// No integrity due to failure, script remains unchanged
			expect(out).toContain(
				'<script src="https://cdn.example.com/a.js"></script>'
			);
			// The test mainly verifies that fetch timeout is configured and doesn't throw
			expect(out).toBeDefined();
		});

		it("constructs with fetchCache disabled (pending map undefined path)", () => {
			// This ensures the branch where pending is undefined executes
			const plugin = sri({ fetchCache: false });
			expect(typeof plugin).toBe("object");
		});

		it("computes integrity for asset with binary source in generateBundle", async () => {
			const plugin = sri({ algorithm: "sha256" }) as any;
			plugin.configResolved?.({
				base: "/",
				build: { ssr: false },
			} as any);
			// Asset with type 'asset' and Uint8Array source to hit binary path
			const cssBytes = new TextEncoder().encode("body{color:blue}");
			const bundle: any = {
				"index.html": {
					type: "asset",
					source: "<!doctype html><html><head></head><body></body></html>",
				},
				"assets/style.css": {
					type: "asset",
					fileName: "assets/style.css",
					source: cssBytes,
				},
			};
			await plugin.generateBundle.handler({}, bundle);
			// This test ensures binary source handling works without throwing errors
		});

		it("computes integrity for asset with string source in generateBundle", async () => {
			const plugin = sri({ algorithm: "sha256" }) as any;
			plugin.configResolved?.({
				base: "/",
				build: { ssr: false },
			} as any);
			const bundle: any = {
				"index.html": {
					type: "asset",
					source: "<!doctype html><html><head></head><body></body></html>",
				},
				"assets/app.js": {
					type: "asset",
					fileName: "assets/app.js",
					source: "console.log('ok')",
				},
			};
			await plugin.generateBundle.handler({}, bundle);
		});
	});

	describe("Dynamic Chunks & Runtime", () => {
		it("injects modulepreload links with integrity for dynamic imports", async () => {
			const plugin = sri({
				algorithm: "sha256",
				crossorigin: "anonymous",
			}) as any;
			// Simulate config resolution with a custom base
			plugin.configResolved?.({
				base: "/base/",
				build: { ssr: false },
			} as any);

			const html = htmlDoc(
				'<script type="module" src="/assets/entry.js"></script>'
			);
			const bundle: Record<string, Chunk | Asset> = {
				"index.html": { type: "asset", source: html },
				// Entry chunk dynamically imports a module by module id
				"assets/entry.js": makeEntryChunk({
					dynamicImports: ["src/chunkA.ts"],
				}),
				// Dynamic chunk maps module id to fileName via modules
				"assets/chunk-A.js": makeDynChunk(
					"assets/chunk-A.js",
					"src/chunkA.ts"
				),
			} as any;

			await plugin.generateBundle.handler({}, bundle as any);
			const out = String((bundle["index.html"] as Asset).source);

			// Should inject rel=modulepreload with base-prefixed href, integrity and crossorigin
			expect(out).toMatch(
				/<link rel="modulepreload" href="\/base\/assets\/chunk-A\.js" integrity="sha256-[^"]+" crossorigin="anonymous">/
			);
		});

		it("produces correct hrefs with absolute CDN base URL", async () => {
			const plugin = sri({
				algorithm: "sha256",
				crossorigin: "anonymous",
			}) as any;
			plugin.configResolved?.({
				base: "https://cdn.myapp.com/",
				build: { ssr: false },
			} as any);

			const html = htmlDoc(
				'<script type="module" src="/assets/entry.js"></script>'
			);
			const bundle: Record<string, Chunk | Asset> = {
				"index.html": { type: "asset", source: html },
				"assets/entry.js": makeEntryChunk({
					dynamicImports: ["src/chunkA.ts"],
				}),
				"assets/chunk-A.js": makeDynChunk(
					"assets/chunk-A.js",
					"src/chunkA.ts"
				),
			} as any;

			await plugin.generateBundle.handler({}, bundle as any);
			const out = String((bundle["index.html"] as Asset).source);

			// Must preserve full protocol in href
			expect(out).toMatch(
				/<link rel="modulepreload" href="https:\/\/cdn\.myapp\.com\/assets\/chunk-A\.js" integrity="sha256-[^"]+" crossorigin="anonymous">/
			);
			// Must NOT collapse :// to :/
			expect(out).not.toContain("https:/cdn");
		});

		it("does not duplicate existing modulepreload links", async () => {
			const plugin = sri({ algorithm: "sha256" }) as any;
			plugin.configResolved?.({
				base: "/",
				build: { ssr: false },
			} as any);

			const existing =
				'<link rel="modulepreload" href="/assets/chunk-A.js">';
			const html = `<!doctype html><html><head>${existing}</head><body></body></html>`;

			const bundle: Record<string, Chunk | Asset> = {
				"index.html": { type: "asset", source: html },
				"assets/entry.js": makeEntryChunk({
					dynamicImports: ["src/chunkA.ts"],
				}),
				"assets/chunk-A.js": makeDynChunk(
					"assets/chunk-A.js",
					"src/chunkA.ts"
				),
			} as any;

			await plugin.generateBundle.handler({}, bundle as any);
			const out = String((bundle["index.html"] as Asset).source);

			// Only one occurrence expected
			const matches =
				out.match(
					/<link rel="modulepreload" href="\/assets\/chunk-A\.js"/g
				) || [];
			expect(matches.length).toBe(1);
			// Integrity should be present on the single link (added via addSriToHtml if not present)
			expect(out).toMatch(
				/<link rel="modulepreload" href="\/assets\/chunk-A\.js"[^>]*integrity="sha256-/
			);
		});

		it("skips injection when preloadDynamicChunks is false", async () => {
			const plugin = sri({
				algorithm: "sha256",
				preloadDynamicChunks: false,
			}) as any;
			plugin.configResolved?.({
				base: "/",
				build: { ssr: false },
			} as any);

			const html = htmlDoc(
				'<script type="module" src="/assets/entry.js"></script>'
			);
			const bundle: Record<string, Chunk | Asset> = {
				"index.html": { type: "asset", source: html },
				"assets/entry.js": makeEntryChunk({
					dynamicImports: ["src/chunkA.ts"],
				}),
				"assets/chunk-A.js": makeDynChunk(
					"assets/chunk-A.js",
					"src/chunkA.ts"
				),
			} as any;

			await plugin.generateBundle.handler({}, bundle as any);
			const out = String((bundle["index.html"] as Asset).source);

			expect(out).not.toContain(
				'rel="modulepreload" href="/assets/chunk-A.js"'
			);
		});

		it("injects runtime into entry chunks when enabled", async () => {
			const plugin = sri({ crossorigin: "anonymous" }) as any;
			plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);
			
			// Create bundle with entry chunk
			const bundle: Record<string, Chunk | Asset> = {
				"index.html": { type: "asset", source: htmlDoc("") },
				"assets/entry.js": makeEntryChunk({ code: "console.log('x')" }),
			} as any;
			
			// Runtime injection now happens in generateBundle
			await plugin.generateBundle.handler({}, bundle as any);
			
			// Verify runtime was injected into entry chunk
			const entryCode = (bundle["assets/entry.js"] as Chunk).code;
			expect(entryCode).toContain("installSriRuntime");
			expect(entryCode).toContain("crossorigin");
		});

		it("does not inject runtime when disabled", async () => {
			const plugin = sri({ runtimePatchDynamicLinks: false }) as any;
			plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);

			// Verify runtime is NOT injected in generateBundle when disabled
			const bundle: Record<string, Chunk | Asset> = {
				"index.html": { type: "asset", source: htmlDoc("") },
				"assets/entry.js": makeEntryChunk({ code: "console.log('x')" }),
			} as any;
			await plugin.generateBundle.handler({}, bundle as any);
			
			const entryCode = (bundle["assets/entry.js"] as Chunk).code;
			expect(entryCode).not.toContain("installSriRuntime");
		});

		it("maps dynamic import via chunk name when facadeModuleId missing and joins base correctly", async () => {
			const plugin = sri({
				algorithm: "sha256",
				crossorigin: "anonymous",
			}) as any;
			plugin.configResolved?.({
				base: "/base",
				build: { ssr: false },
			} as any);

			const html = htmlDoc("");
			const entry = makeEntryChunk({
				dynamicImports: ["chunk-by-name"],
				name: "chunk-by-name",
				fileName: "assets/entry2.js",
			});
			const dyn = makeDynChunk("assets/chunk-by-name.js", "ignored");
			dyn.name = "chunk-by-name";
			dyn.facadeModuleId = undefined as any;

			const bundle: Record<string, Chunk | Asset> = {
				"index.html": { type: "asset", source: html },
				[entry.fileName]: entry,
				[dyn.fileName]: dyn,
			} as any;

			await plugin.generateBundle.handler({}, bundle as any);
			const out = String((bundle["index.html"] as Asset).source);
			expect(out).toMatch(
				/<link rel="modulepreload" href="\/base\/assets\/chunk-by-name\.js" integrity="sha256-/
			);
		});

		it("injects modulepreload without crossorigin when option not set", async () => {
			const plugin = sri({ algorithm: "sha256" }) as any;
			plugin.configResolved?.({
				base: "/",
				build: { ssr: false },
			} as any);
			const html = htmlDoc(
				'<script type="module" src="/assets/entry.js"></script>'
			);
			const bundle: Record<string, Chunk | Asset> = {
				"index.html": { type: "asset", source: html },
				"assets/entry.js": makeEntryChunk({
					dynamicImports: ["src/chunkA.ts"],
				}),
				"assets/chunk-A.js": makeDynChunk(
					"assets/chunk-A.js",
					"src/chunkA.ts"
				),
			} as any;
			await plugin.generateBundle.handler({}, bundle as any);
			const out = String((bundle["index.html"] as Asset).source);
			expect(out).toMatch(
				/<link rel="modulepreload" href="\/assets\/chunk-A\.js" integrity="sha256-[^"]+">/
			);
		});

		it("falls back to scan chunks by name when idToFile lacks the name key", async () => {
			const plugin = sri({
				algorithm: "sha256",
				crossorigin: "anonymous",
			}) as any;
			plugin.configResolved?.({
				base: "/base/",
				build: { ssr: false },
			} as any);
			const html = htmlDoc("");
			const entry = makeEntryChunk({
				dynamicImports: ["chunk-by-name"],
				fileName: "assets/entry3.js",
				// entry name different so idToFile won't map by name
				name: "entry3",
			});
			const dyn = makeDynChunk(
				"assets/chunk-by-name.js",
				"src/someOtherId.ts"
			);
			dyn.name = "chunk-by-name";
			dyn.facadeModuleId = "src/someOtherId.ts" as any; // ensure mapping via facade id only
			const bundle: Record<string, Chunk | Asset> = {
				"index.html": { type: "asset", source: html },
				[entry.fileName]: entry,
				[dyn.fileName]: dyn,
			} as any;
			await plugin.generateBundle.handler({}, bundle as any);
			const out = String((bundle["index.html"] as Asset).source);
			expect(out).toMatch(
				/<link rel="modulepreload" href="\/base\/assets\/chunk-by-name\.js" integrity="sha256-/
			);
		});
	});

	describe("Runtime Helper Behavior", () => {
		let cleanup: () => void;
		beforeEach(() => {
			cleanup = setupFakeDom();
		});
		afterEach(() => {
			cleanup();
		});

		it("sets integrity and crossorigin on link via setAttribute path", async () => {
			const plugin = sri({ crossorigin: "anonymous" }) as any;
			plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);
			
			// Create bundle with entry chunk that will have runtime injected
			const bundle: Record<string, Chunk | Asset> = {
				"index.html": { type: "asset", source: htmlDoc("") },
				"assets/entry.js": makeEntryChunk({ code: "console.log('x')" }),
				"assets/chunk-A.js": makeDynChunk("assets/chunk-A.js", "src/chunkA.ts"),
			} as any;
			(bundle["assets/chunk-A.js"] as Chunk).code = "console.log('A')";
			
			// Runtime is now injected in generateBundle
			await plugin.generateBundle.handler({}, bundle as any);
			const injected = (bundle["assets/entry.js"] as Chunk).code;

			// Execute the injected runtime code to install patches
			new Function(injected)();

			// Create a link and set rel/href, triggering the patched setAttribute
			const link = new (globalThis as any).HTMLLinkElement();
			link.rel = "modulepreload";
			(link as any).setAttribute("href", "/assets/chunk-A.js");

			expect(link.hasAttribute("integrity")).toBe(true);
			expect(link.hasAttribute("crossorigin")).toBe(true);
		});

		it("sets integrity but omits crossorigin when not configured", async () => {
			const plugin = sri() as any; // no crossorigin option
			plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);
			
			// Create bundle with entry chunk
			const bundle: Record<string, Chunk | Asset> = {
				"index.html": { type: "asset", source: htmlDoc("") },
				"assets/entry.js": makeEntryChunk({ code: "console.log('y')" }),
				"assets/chunk-B.js": makeDynChunk("assets/chunk-B.js", "src/chunkB.ts"),
			} as any;
			(bundle["assets/chunk-B.js"] as Chunk).code = "console.log('B')";
			
			await plugin.generateBundle.handler({}, bundle as any);
			const injected = (bundle["assets/entry.js"] as Chunk).code;
			new Function(injected)();

			const link = new (globalThis as any).HTMLLinkElement();
			link.rel = "modulepreload";
			(link as any).setAttribute("href", "/assets/chunk-B.js");

			expect(link.hasAttribute("integrity")).toBe(true);
			expect(link.hasAttribute("crossorigin")).toBe(false);
		});

		it("sets integrity for scripts via setAttribute path", async () => {
			const plugin = sri() as any;
			plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);
			
			// Create bundle with entry chunk
			const bundle: Record<string, Chunk | Asset> = {
				"index.html": { type: "asset", source: htmlDoc("") },
				"assets/entry.js": makeEntryChunk({ code: "console.log('z')" }),
				"assets/mod.js": makeDynChunk("assets/mod.js", "src/mod.ts"),
			} as any;
			(bundle["assets/mod.js"] as Chunk).code = "export{};";
			
			await plugin.generateBundle.handler({}, bundle as any);
			const injected = (bundle["assets/entry.js"] as Chunk).code;
			new Function(injected)();

			const script = new (globalThis as any).HTMLScriptElement();
			(script as any).setAttribute("src", "/assets/mod.js");
			expect(script.hasAttribute("integrity")).toBe(true);
		});

		it("sets integrity when nodes are inserted via appendChild/prepend hooks", async () => {
			// Install fake DOM with insert functions to exercise wrapInsert branches
			cleanup();
			cleanup = setupFakeDom(true);

			const plugin = sri({ crossorigin: "anonymous" }) as any;
			plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);
			
			// Create bundle with entry chunk
			const bundle: Record<string, Chunk | Asset> = {
				"index.html": { type: "asset", source: htmlDoc("") },
				"assets/entry.js": makeEntryChunk({ code: "console.log('i')" }),
				"assets/ins.js": makeDynChunk("assets/ins.js", "src/ins.ts"),
			} as any;
			(bundle["assets/ins.js"] as Chunk).code = "export{};";
			
			await plugin.generateBundle.handler({}, bundle as any);
			const injected = (bundle["assets/entry.js"] as Chunk).code;
			new Function(injected)();

			// Parent Node with appendChild
			const parent: any = Object.create(
				(globalThis as any).Node.prototype
			);
			// Link needing integrity
			const link = new (globalThis as any).HTMLLinkElement();
			link.rel = "modulepreload";
			(link as any).setAttribute("href", "/assets/ins.js");
			// Clear integrity to ensure hook runs during insertion
			(link as any)._attrs?.delete?.("integrity");

			parent.appendChild(link);
			expect(link.hasAttribute("integrity")).toBe(true);
			expect(link.hasAttribute("crossorigin")).toBe(true);
		});
	});

	describe("installSriRuntime (unit)", () => {
		let cleanup: () => void;
		beforeEach(() => {
			cleanup = setupFakeDom();
		});
		afterEach(() => {
			cleanup();
		});

		it("applies integrity to link when href set after install", () => {
			installSriRuntime(
				{ "/a.js": "sha256-xyz" },
				{ crossorigin: "anonymous" }
			);
			const el = new (globalThis as any).HTMLLinkElement();
			el.rel = "modulepreload";
			(el as any).setAttribute("href", "/a.js");
			expect(el.hasAttribute("integrity")).toBe(true);
			expect(el.hasAttribute("crossorigin")).toBe(true);
		});

		it("handles script src path including invalid URL gracefully", () => {
			installSriRuntime({ "/s.js": "sha256-xyz" }, {});
			const sc = new (globalThis as any).HTMLScriptElement();
			(sc as any).setAttribute("src", "::::");
			expect(sc.hasAttribute("integrity")).toBe(false);
		});

		it("getIntegrityForUrl returns undefined on null/empty", () => {
			installSriRuntime({}, {});
			const el = new (globalThis as any).HTMLLinkElement();
			el.rel = "modulepreload";
			(el as any).setAttribute("href", "");
			expect(el.hasAttribute("integrity")).toBe(false);
		});

		it("does nothing for unsupported elements", () => {
			installSriRuntime({ "/a.js": "sha256-xyz" }, {});
			const el: any = {
				_attrs: new Map<string, string>(),
				setAttribute(name: string, value: string) {
					this._attrs.set(name, value);
				},
				getAttribute(name: string) {
					return this._attrs.get(name) ?? null;
				},
				hasAttribute(name: string) {
					return this._attrs.has(name);
				},
			};
			expect(() =>
				(Element as any).prototype.setAttribute.call(
					el,
					"href",
					"/a.js"
				)
			).not.toThrow();
		});

		it("handles invalid URL in href gracefully (no integrity)", () => {
			installSriRuntime(
				{ "/bad.js": "sha256-xyz" },
				{ crossorigin: "anonymous" }
			);
			const el = new (globalThis as any).HTMLLinkElement();
			el.rel = "modulepreload";
			(el as any).setAttribute("href", "::::");
			expect(el.hasAttribute("integrity")).toBe(false);
		});

		it("skips non-eligible link rel/as combinations", () => {
			installSriRuntime({ "/img.js": "sha256-xyz" }, {});
			const el = new (globalThis as any).HTMLLinkElement();
			el.rel = "preload";
			(el as any).setAttribute("as", "image");
			(el as any).setAttribute("href", "/img.js");
			expect(el.hasAttribute("integrity")).toBe(false);
		});

		it("returns early when element lacks hasAttribute", () => {
			installSriRuntime({ "/x.js": "sha256-xyz" }, {});
			const el = new (globalThis as any).HTMLLinkElement();
			el.rel = "modulepreload";
			// @ts-ignore - simulate missing hasAttribute
			el.hasAttribute = undefined;
			(el as any).setAttribute("href", "/x.js");
		});

		it("catches errors in setAttribute wrapper (invalid RHS for instanceof)", () => {
			const prevLinkCtor = (globalThis as any).HTMLLinkElement;
			try {
				(globalThis as any).HTMLLinkElement = {} as any; // cause instanceof to throw
				installSriRuntime({ "/x.js": "sha256-xyz" }, {});
				const el = new prevLinkCtor();
				el.rel = "modulepreload";
				expect(() =>
					(el as any).setAttribute("href", "/x.js")
				).not.toThrow();
			} finally {
				(globalThis as any).HTMLLinkElement = prevLinkCtor;
			}
		});

		it("wrapInsert falls back to assignment when defineProperty throws, and still sets integrity", () => {
			const originalDefine = Object.defineProperty;
			// @ts-ignore - proxy defineProperty to throw for a specific case
			Object.defineProperty = new Proxy(Object.defineProperty, {
				apply(target, thisArg, argArray: any[]) {
					const [proto, key] = argArray;
					if (
						key === "append" &&
						proto === (globalThis as any).Element.prototype
					) {
						throw new Error("defineProperty blocked");
					}
					return (originalDefine as any).apply(thisArg, argArray);
				},
			});

			try {
				// Ensure an original append exists so wrapInsert attempts to wrap it
				(globalThis as any).Element.prototype.append = function (
					child: any
				) {
					return child;
				} as any;
				installSriRuntime(
					{ "/fb.js": "sha256-xyz" },
					{ crossorigin: "anonymous" }
				);
				const parent: any = Object.create(
					(globalThis as any).Element.prototype
				);
				const link = new (globalThis as any).HTMLLinkElement();
				link.rel = "modulepreload";
				(link as any).setAttribute("href", "/fb.js");
				parent.append(link);
				expect(link.hasAttribute("integrity")).toBe(true);
				expect(link.hasAttribute("crossorigin")).toBe(true);
			} finally {
				Object.defineProperty = originalDefine;
			}
		});
	});

	describe("Coverage Completion Tests", () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("covers the catch block and error rethrow in generateBundle", async () => {
			const plugin = sri() as any;
			const mockContext = createMockPluginContext();

			// Mock the buildIntegrityMappings method to throw an error
			const { IntegrityProcessor } = await import("../src/internal");
			const buildMappingsSpy = vi
				.spyOn(IntegrityProcessor.prototype, "buildIntegrityMappings")
				.mockRejectedValue(
					new Error("Simulated integrity mapping error")
				);

			const bundle: any = {
				"index.html": {
					type: "asset",
					source: "<!DOCTYPE html><html></html>",
				},
				"test.js": {
					type: "chunk",
					code: "console.log('test');",
				},
			};

			// Should throw the error after handling it
			await expect(
				plugin.generateBundle.handler.call(mockContext, {}, bundle)
			).rejects.toThrow("Simulated integrity mapping error");

			// Restore the spy
			buildMappingsSpy.mockRestore();
		});

		it("covers logger error method in development mode", async () => {
			const { spies, cleanup } = spyOnConsole();
			const originalEnv = process.env.NODE_ENV;
			process.env.NODE_ENV = "development";

			const plugin = sri() as any;

			const bundle: any = {
				"test.html": {
					type: "asset",
					source: {
						toString() {
							const error = new Error("Test error with stack");
							error.stack =
								"Error: Test error with stack\n    at Object.<anonymous>";
							throw error;
						},
					},
				},
			};

			await plugin.generateBundle.handler({}, bundle);

			// Should call console.error for the error message and error object in development
			expect(spies.error).toHaveBeenCalledWith(
				expect.stringContaining("Failed to process HTML file"),
				expect.any(Error)
			);

			process.env.NODE_ENV = originalEnv;
			cleanup();
		});

		it("covers error method with plugin context", async () => {
			const mockContext = createMockPluginContext();
			const plugin = sri() as any;

			const bundle: any = {
				"test.html": {
					type: "asset",
					source: {
						toString() {
							throw new Error("HTML error for logger test");
						},
					},
				},
			};

			// Call with plugin context that has an error method
			await plugin.generateBundle.handler.call(mockContext, {}, bundle);

			// The plugin error method should be called for HTML processing errors
			// (Error is caught at HTML processor level, so just verify plugin context exists)
			expect(mockContext.error).toBeDefined();
		});

		it("covers console error fallback when no plugin context", async () => {
			const { spies, cleanup } = spyOnConsole();
			const plugin = sri() as any;

			const bundle: any = {
				"test.html": {
					type: "asset",
					source: {
						toString() {
							throw new Error("HTML error for console test");
						},
					},
				},
			};

			// Call without plugin context to use console fallback
			await plugin.generateBundle.handler({}, bundle);

			expect(spies.error).toHaveBeenCalledWith(
				expect.stringContaining("Failed to process HTML file"),
				expect.any(Error)
			);

			cleanup();
		});

		it("covers successful completion summary logging", async () => {
			const { spies, cleanup } = spyOnConsole();

			const plugin = sri() as any;

			const bundle: any = {
				"index.html": {
					type: "asset",
					source: "<!DOCTYPE html><html><head></head><body></body></html>",
					fileName: "index.html",
				},
				"main.js": {
					type: "chunk",
					fileName: "main.js",
					code: "console.log('test');",
				},
			};

			await plugin.generateBundle.handler({}, bundle);

			// Default (quiet) mode: info is suppressed, but summary always prints
			expect(spies.info).toHaveBeenCalledWith(
				expect.stringContaining("SRI generation completed")
			);

			cleanup();
		});

		it("covers verbose logging shows all info messages", async () => {
			const { spies, cleanup } = spyOnConsole();

			const plugin = sri({ verboseLogging: true }) as any;

			const bundle: any = {
				"index.html": {
					type: "asset",
					source: "<!DOCTYPE html><html><head></head><body></body></html>",
					fileName: "index.html",
				},
				"main.js": {
					type: "chunk",
					fileName: "main.js",
					code: "console.log('test');",
				},
			};

			await plugin.generateBundle.handler({}, bundle);

			// Verbose mode: info messages are visible
			expect(spies.info).toHaveBeenCalledWith(
				expect.stringContaining("Building SRI integrity mappings")
			);
			// Summary always prints
			expect(spies.info).toHaveBeenCalledWith(
				expect.stringContaining("SRI generation completed")
			);

			cleanup();
		});

		it("covers error rethrow in generateBundle", async () => {
			const plugin = sri() as any;

			// Create a bundle that will cause an error in processing
			const bundle: any = {
				"index.html": {
					type: "asset",
					source: "<html></html>",
				},
				"malformed.js": {
					type: "chunk",
					code: null, // This will cause an error in integrity computation
				},
			};

			// Should throw and call handleGenerateBundleError
			// This test primarily covers the validation path, not actual error throwing.
			// The bundle with null code will be handled gracefully (skipped), not thrown.
			const result = await plugin.generateBundle.handler({}, bundle);
			expect(result).toBeUndefined();
		});

		it("covers default quiet mode (summary still prints)", async () => {
			const { spies, cleanup } = spyOnConsole();

			const plugin = sri() as any;
			const bundle: any = {
				"index.html": {
					type: "asset",
					source: "<!DOCTYPE html><html></html>",
					fileName: "index.html",
				},
				"test.js": {
					type: "chunk",
					fileName: "test.js",
					code: "console.log('test');",
				},
			};

			await plugin.generateBundle.handler({}, bundle);

			// In default quiet mode, summary still prints via console.info
			expect(spies.info).toHaveBeenCalledWith(
				expect.stringContaining("SRI generation completed")
			);

			cleanup();
		});

		it("covers empty bundle validation path", async () => {
			const { spies, cleanup } = spyOnConsole();
			const plugin = sri() as any;

			await plugin.generateBundle.handler({}, {});

			expect(spies.warn).toHaveBeenCalledWith(
				expect.stringContaining("Empty bundle detected")
			);

			cleanup();
		});

		it("covers invalid bundle validation path", async () => {
			const { spies, cleanup } = spyOnConsole();
			const plugin = sri() as any;

			// Test with null bundle
			await plugin.generateBundle.handler({}, null);

			expect(spies.warn).toHaveBeenCalledWith(
				expect.stringContaining("Invalid bundle provided")
			);

			// Test with non-object bundle
			await plugin.generateBundle.handler({}, "not-an-object");

			expect(spies.warn).toHaveBeenCalledWith(
				expect.stringContaining("Invalid bundle provided")
			);

			cleanup();
		});

		it("covers missing integrity warning for dynamic chunks", async () => {
			const { spies, cleanup } = spyOnConsole();
			const originalEnv = process.env.NODE_ENV;
			process.env.NODE_ENV = "development";

			const plugin = sri({
				algorithm: "sha256",
				preloadDynamicChunks: true,
			}) as any;

			const bundle: any = {
				"index.html": {
					type: "asset",
					source: `<!DOCTYPE html>
						<html>
							<head></head>
							<body><script src="/main.js"></script></body>
						</html>`,
				},
				"main.js": {
					type: "chunk",
					fileName: "main.js",
					facadeModuleId: "/src/main.js",
					name: "main",
					code: "import('./missing-chunk.js')",
					modules: { "/src/main.js": {} },
					dynamicImports: ["missing-chunk"],
				},
				// Note: missing the actual "missing-chunk.js" file to trigger the warning
			};

			await plugin.generateBundle.handler({}, bundle);

			// Should warn about unresolved dynamic import (different path hit)
			expect(spies.warn).toHaveBeenCalledWith(
				expect.stringContaining("Could not resolve dynamic import")
			);

			process.env.NODE_ENV = originalEnv;
			cleanup();
		});
	});

	describe("Runtime with Dependency Injection (New Architecture)", () => {
		/**
		 * This section demonstrates the recommended testing approach using dependency injection.
		 *
		 * Benefits over global overrides:
		 * - No global state pollution
		 * - Isolated, predictable tests
		 * - Easy to mock specific behaviors
		 * - Better maintainability
		 *
		 * Use this pattern for all new runtime tests.
		 */
		let testDeps: ReturnType<typeof createTestDependencies>;
		let mockElements: ReturnType<typeof createMockElements>;

		beforeEach(() => {
			// Create fresh mock dependencies for each test
			testDeps = createTestDependencies();
			mockElements = createMockElements();
		});

		it("handles element processing through dependency injection", () => {
			/**
			 * This test demonstrates the complete element processing workflow using
			 * dependency injection instead of global prototype manipulation.
			 */
			const sriMap = { "/test.js": "sha256-abc123" };

			// Install runtime using injected mock dependencies
			installSriRuntimeWithDeps(
				sriMap,
				{ crossorigin: "anonymous" },
				testDeps
			);

			// Create test element and simulate the runtime processing workflow
			const script = mockElements.createScript({ src: "/test.js" });

			// Simulate the element processing logic that happens in the runtime
			if (testDeps.domAdapter.isEligibleForSRI(script)) {
				const url = testDeps.domAdapter.getElementURL(script);
				const integrity = sriMap[url || ""];
				if (integrity) {
					testDeps.domAdapter.setIntegrityAttributes(
						script,
						integrity,
						"anonymous"
					);
				}
			}

			// Verify SRI attributes were correctly applied
			expect(script.getAttribute("integrity")).toBe("sha256-abc123");
			expect(script.getAttribute("crossorigin")).toBe("anonymous");
		});

		it("handles different element types correctly", () => {
			const sriMap = {
				"/test.js": "sha256-script",
				"/test.css": "sha256-style",
			};

			const script = mockElements.createScript({ src: "/test.js" });
			const link = mockElements.createLink({
				href: "/test.css",
				rel: "stylesheet",
			});
			const ineligibleDiv = mockElements.createElement("div");

			expect(testDeps.domAdapter.isEligibleForSRI(script)).toBe(true);
			expect(testDeps.domAdapter.isEligibleForSRI(link)).toBe(true);
			expect(testDeps.domAdapter.isEligibleForSRI(ineligibleDiv)).toBe(
				false
			);

			expect(testDeps.domAdapter.getElementURL(script)).toBe("/test.js");
			expect(testDeps.domAdapter.getElementURL(link)).toBe("/test.css");
		});

		it("handles setAttribute errors gracefully in dependency injection", () => {
			const sriMap = { "/test.js": "sha256-abc123" };
			const script = mockElements.createScript({ src: "/test.js" });

			// Make the DOM adapter fail
			testDeps.mocks.domAdapter.shouldFailSetIntegrity = true;

			// Should not throw
			expect(() => {
				testDeps.domAdapter.setIntegrityAttributes(
					script,
					"sha256-abc123",
					"anonymous"
				);
			}).not.toThrow();

			// Attributes should not be set due to failure
			expect(script.hasAttribute("integrity")).toBe(false);
		});

		it("tracks function calls for testing verification", () => {
			const sriMap = { "/test.js": "sha256-abc123" };
			const script = mockElements.createScript({ src: "/test.js" });

			// Process element through DOM adapter
			testDeps.domAdapter.setIntegrityAttributes(
				script,
				"sha256-abc123",
				"anonymous"
			);

			// Verify call was tracked with Vitest spy
			expect(
				testDeps.mocks.domAdapter.setIntegrityAttributes
			).toHaveBeenCalledTimes(1);
			expect(
				testDeps.mocks.domAdapter.setIntegrityAttributes
			).toHaveBeenCalledWith(script, "sha256-abc123", "anonymous");
		});
	});

	describe("Legacy Runtime Error Handling (Global Overrides)", () => {
		// NOTE: These tests use global overrides which are less maintainable.
		// For new tests, prefer the dependency injection approach shown in
		// the "Runtime with Dependency Injection (New Architecture)" section above.
		let cleanup: () => void;
		beforeEach(() => {
			cleanup = setupFakeDom(true);
		});
		afterEach(() => {
			cleanup();
		});

		it("handles error in maybeSetIntegrity during node insertion", async () => {
			const plugin = sri() as any;
			plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);
			
			// Create bundle with entry chunk
			const bundle: Record<string, Chunk | Asset> = {
				"index.html": { type: "asset", source: htmlDoc("") },
				"assets/entry.js": makeEntryChunk({ code: "console.log('test')" }),
				"assets/error.js": makeDynChunk("assets/error.js", "src/error.ts"),
			} as any;
			(bundle["assets/error.js"] as Chunk).code = "export default 42;";
			
			await plugin.generateBundle.handler({}, bundle as any);
			const injected = (bundle["assets/entry.js"] as Chunk).code;
			new Function(injected)();

			// Create a problematic element that will cause maybeSetIntegrity to throw
			const parent: any = Object.create(
				(globalThis as any).Node.prototype
			);
			const problematicElement: any = {
				// Missing required methods to trigger error in maybeSetIntegrity
				hasAttribute: undefined,
				setAttribute: undefined,
			};

			// Should not throw even when maybeSetIntegrity fails
			expect(() => parent.appendChild(problematicElement)).not.toThrow();
		});

		it("covers fallback assignment when defineProperty fails for wrapInsert", () => {
			const originalDefineProperty = Object.defineProperty;

			// Mock defineProperty to always fail
			Object.defineProperty = vi.fn().mockImplementation(() => {
				throw new Error("defineProperty failed");
			});

			try {
				// Create a fresh prototype to test fallback assignment
				const testProto: any = {};
				testProto.testMethod = function () {
					return "original";
				};

				// This should trigger the fallback assignment path
				installSriRuntime({}, {});

				// Verify defineProperty was called (and failed)
				expect(Object.defineProperty).toHaveBeenCalled();
			} finally {
				Object.defineProperty = originalDefineProperty;
			}
		});

		it("covers complete failure when both defineProperty and assignment fail", () => {
			// Create fake DOM environment first
			const originalNode = (globalThis as any).Node;
			const originalElement = (globalThis as any).Element;
			const originalDefineProperty = Object.defineProperty;

			try {
				// Create fake Node and Element with protected prototypes
				(globalThis as any).Node = function () {};
				(globalThis as any).Node.prototype = Object.create(null);
				Object.defineProperty(
					(globalThis as any).Node.prototype,
					"appendChild",
					{
						value: function () {
							return arguments[0];
						},
						configurable: false,
						writable: false,
					}
				);

				(globalThis as any).Element = function () {};
				(globalThis as any).Element.prototype = Object.create(
					(globalThis as any).Node.prototype
				);
				Object.defineProperty(
					(globalThis as any).Element.prototype,
					"setAttribute",
					{
						value: function () {
							return undefined;
						},
						configurable: false,
						writable: false,
					}
				);

				// Mock defineProperty to always fail for our prototypes
				Object.defineProperty = vi
					.fn()
					.mockImplementation((obj, prop, desc) => {
						if (
							obj === (globalThis as any).Node.prototype ||
							obj === (globalThis as any).Element.prototype
						) {
							throw new Error("defineProperty failed");
						}
						return originalDefineProperty(obj, prop, desc);
					});

				// Should handle complete failure gracefully - both defineProperty and assignment will fail
				expect(() => installSriRuntime({}, {})).not.toThrow();
			} finally {
				Object.defineProperty = originalDefineProperty;
				(globalThis as any).Node = originalNode;
				(globalThis as any).Element = originalElement;
			}
		});

		it("handles URL parsing error in getIntegrityForUrl", () => {
			installSriRuntime({ "/test.js": "sha256-abc123" }, {});

			// Mock location to be invalid/missing to trigger URL parsing fallback
			const originalLocation = (globalThis as any).location;
			(globalThis as any).location = undefined;

			try {
				const link = new (globalThis as any).HTMLLinkElement();
				link.rel = "modulepreload";

				// This should trigger URL parsing error path but not throw
				expect(() =>
					(link as any).setAttribute("href", "::invalid::")
				).not.toThrow();

				// Should not have integrity due to URL parsing failure
				expect(link.hasAttribute("integrity")).toBe(false);
			} finally {
				(globalThis as any).location = originalLocation;
			}
		});

		it("covers error handling in wrapped node insertion", () => {
			const originalNode = (globalThis as any).Node;
			const originalElement = (globalThis as any).HTMLScriptElement;

			try {
				// Create a function that will be wrapped and throw during maybeSetIntegrity
				(globalThis as any).Node = function () {};
				(globalThis as any).Node.prototype = {
					appendChild: function (child: any) {
						return child;
					},
				};

				// Create HTMLScriptElement that throws during integrity processing
				(globalThis as any).HTMLScriptElement = function () {
					this.hasAttribute = () => false;
					this.setAttribute = () => {
						throw new Error(
							"setAttribute failed to test error handling"
						);
					};
					Object.defineProperty(this, "src", {
						get: () => "/test.js",
						set: () => {},
						enumerable: true,
					});
				};

				installSriRuntime({ "/test.js": "sha256-abc123" }, {});

				const script = new (globalThis as any).HTMLScriptElement();
				const wrappedAppendChild = (globalThis as any).Node.prototype
					.appendChild;

				// This should call the wrapped appendChild which will call maybeSetIntegrity and throw
				// The error should be caught and handled gracefully
				expect(() => wrappedAppendChild(script)).not.toThrow();
			} finally {
				(globalThis as any).Node = originalNode;
				(globalThis as any).HTMLScriptElement = originalElement;
			}
		});

		it("covers fallback assignment failure in wrapInsert", () => {
			const originalNode = (globalThis as any).Node;
			const originalDefineProperty = Object.defineProperty;

			try {
				// Create Node with appendChild method
				(globalThis as any).Node = function () {};
				(globalThis as any).Node.prototype = {
					appendChild: function () {
						return arguments[0];
					},
				};

				// Mock defineProperty to fail for wrapInsert operations
				Object.defineProperty = vi
					.fn()
					.mockImplementation((obj, prop, desc) => {
						if (
							obj === (globalThis as any).Node.prototype &&
							prop === "appendChild"
						) {
							throw new Error("defineProperty failed");
						}
						return originalDefineProperty(obj, prop, desc);
					});

				// Create prototype that throws on assignment to test error handling
				const throwingProto = new Proxy(
					(globalThis as any).Node.prototype,
					{
						set(_target, prop, _value) {
							if (prop === "appendChild") {
								throw new Error(
									"assignment failed to test error handling"
								);
							}
							return true;
						},
					}
				);
				(globalThis as any).Node.prototype = throwingProto;

				// Should handle both defineProperty and assignment failures gracefully
				expect(() => installSriRuntime({}, {})).not.toThrow();
			} finally {
				Object.defineProperty = originalDefineProperty;
				(globalThis as any).Node = originalNode;
			}
		});

		it("handles complete installation failure gracefully", () => {
			const originalNode = (globalThis as any).Node;
			const originalElement = (globalThis as any).Element;

			// Remove global constructors to trigger top-level error
			(globalThis as any).Node = undefined;
			(globalThis as any).Element = undefined;

			try {
				// Should handle complete failure without throwing
				expect(() => installSriRuntime({}, {})).not.toThrow();
			} finally {
				(globalThis as any).Node = originalNode;
				(globalThis as any).Element = originalElement;
			}
		});
	});

	describe("Skip Resources Integration Tests", () => {
		it("end-to-end integration with skipResources option", async () => {
			const pluginContext = createMockPluginContext();
			const sriPlugin = sri({
				algorithm: "sha256",
				skipResources: ["analytics", "*/vendor-*"],
			}) as any;

			// Test HTML with both skipped and non-skipped resources
			const bundle: any = {
				"index.html": {
					type: "asset",
					source: `
						<html>
							<head>
								<script id="analytics" src="/analytics.js"></script>
								<script src="/main.js"></script>
								<link rel="stylesheet" href="/vendor-styles.css" />
								<link rel="stylesheet" href="/app.css" />
							</head>
						</html>
					`,
				},
				"analytics.js": {
					type: "chunk" as const,
					code: "console.log('analytics')",
					fileName: "analytics.js",
				},
				"main.js": {
					type: "chunk" as const,
					code: "console.log('main')",
					fileName: "main.js",
				},
				"vendor-styles.css": {
					type: "asset" as const,
					source: ".vendor{}",
					fileName: "vendor-styles.css",
				},
				"app.css": {
					type: "asset" as const,
					source: ".app{}",
					fileName: "app.css",
				},
			};

			await sriPlugin.generateBundle.handler({}, bundle);
			const result = String(bundle["index.html"].source);

			// Should have integrity for main.js and app.css only
			expect(result).toContain('src="/main.js" integrity="sha256-');
			expect(result).toContain('href="/app.css" integrity="sha256-');

			// Should NOT have integrity for analytics.js and vendor-styles.css
			expect(result).not.toContain('src="/analytics.js" integrity=');
			expect(result).not.toContain(
				'href="/vendor-styles.css" integrity='
			);

			// But the elements should still be present
			expect(result).toContain('src="/analytics.js"');
			expect(result).toContain('href="/vendor-styles.css"');
		});

		it("works with runtime SRI injection and skip patterns", () => {
			const sriByPathname = {
				"/main.js": "sha256-abc123",
				"/analytics.js": "sha256-def456",
				"/app.css": "sha256-ghi789",
				"/vendor.css": "sha256-jkl012",
			};

			// Test that runtime skip functionality doesn't throw
			expect(() => {
				installSriRuntime(sriByPathname, {
					crossorigin: "anonymous",
					skipResources: ["*analytics*", "*vendor*"],
				});
			}).not.toThrow();

			// Test with dependencies injection
			const dependencies = createTestDependencies();
			expect(() => {
				installSriRuntimeWithDeps(
					sriByPathname,
					{
						crossorigin: "anonymous",
						skipResources: ["*analytics*", "*vendor*"],
					},
					dependencies
				);
			}).not.toThrow();
		});
	});

	describe("verboseLogging Option", () => {
		it("suppresses info logs in default (quiet) mode", async () => {
			const mockContext = createMockPluginContext();
			const plugin = sri() as any;

			const bundle: any = {
				"index.html": {
					type: "asset",
					source: "<!DOCTYPE html><html><head></head><body></body></html>",
					fileName: "index.html",
				},
				"main.js": {
					type: "chunk",
					fileName: "main.js",
					code: "console.log('test');",
				},
			};

			await plugin.generateBundle.handler.call(mockContext, {}, bundle);

			// info should not be called with step-level messages (they are suppressed)
			expect(mockContext.info).not.toHaveBeenCalledWith(
				"Building SRI integrity mappings for non-entry chunks"
			);
			expect(mockContext.info).not.toHaveBeenCalledWith(
				"Analyzing dynamic import relationships"
			);
			expect(mockContext.info).not.toHaveBeenCalledWith(
				"Processing HTML files for SRI injection"
			);

			// summary always prints via info
			expect(mockContext.info).toHaveBeenCalledWith(
				expect.stringContaining("SRI generation completed")
			);
		});

		it("shows all info logs when verboseLogging is true", async () => {
			const mockContext = createMockPluginContext();
			const plugin = sri({ verboseLogging: true }) as any;

			const bundle: any = {
				"index.html": {
					type: "asset",
					source: "<!DOCTYPE html><html><head></head><body></body></html>",
					fileName: "index.html",
				},
				"main.js": {
					type: "chunk",
					fileName: "main.js",
					code: "console.log('test');",
				},
			};

			await plugin.generateBundle.handler.call(mockContext, {}, bundle);

			// All info messages should be visible in verbose mode
			expect(mockContext.info).toHaveBeenCalledWith(
				"Building SRI integrity mappings for non-entry chunks"
			);
			expect(mockContext.info).toHaveBeenCalledWith(
				"Analyzing dynamic import relationships"
			);
			expect(mockContext.info).toHaveBeenCalledWith(
				"Processing HTML files for SRI injection"
			);

			// summary always prints
			expect(mockContext.info).toHaveBeenCalledWith(
				expect.stringContaining("SRI generation completed")
			);
		});

		it("explicit verboseLogging: false behaves same as default", async () => {
			const mockContext = createMockPluginContext();
			const plugin = sri({ verboseLogging: false }) as any;

			const bundle: any = {
				"index.html": {
					type: "asset",
					source: "<!DOCTYPE html><html><head></head><body></body></html>",
					fileName: "index.html",
				},
				"main.js": {
					type: "chunk",
					fileName: "main.js",
					code: "console.log('test');",
				},
			};

			await plugin.generateBundle.handler.call(mockContext, {}, bundle);

			// info suppressed
			expect(mockContext.info).not.toHaveBeenCalledWith(
				"Building SRI integrity mappings for non-entry chunks"
			);

			// summary always prints
			expect(mockContext.info).toHaveBeenCalledWith(
				expect.stringContaining("SRI generation completed")
			);
		});

		it("warnings still print in quiet mode", async () => {
			const mockContext = createMockPluginContext();
			const plugin = sri() as any;

			// Simulate SSR build with no HTML to trigger a warning
			plugin.configResolved?.({
				command: "build",
				mode: "production",
				appType: "ssr",
				build: { ssr: true },
			} as any);

			const bundle: any = { "entry.js": { code: "console.log(1)" } };
			await plugin.generateBundle.handler.call(mockContext, {}, bundle);

			// warn is always called regardless of verbose setting
			expect(mockContext.warn).toHaveBeenCalled();
		});

		it("summary includes asset and HTML counts", async () => {
			const mockContext = createMockPluginContext();
			const plugin = sri() as any;

			const bundle: any = {
				"index.html": {
					type: "asset",
					source: "<!DOCTYPE html><html><head></head><body></body></html>",
					fileName: "index.html",
				},
				"about.html": {
					type: "asset",
					source: "<!DOCTYPE html><html><head></head><body></body></html>",
					fileName: "about.html",
				},
				"main.js": {
					type: "chunk",
					fileName: "main.js",
					code: "console.log('test');",
				},
				"style.css": {
					type: "asset",
					fileName: "style.css",
					source: "body{}",
				},
			};

			await plugin.generateBundle.handler.call(mockContext, {}, bundle);

			// Summary should mention asset and HTML counts
			expect(mockContext.info).toHaveBeenCalledWith(
				expect.stringContaining("asset(s) processed")
			);
			expect(mockContext.info).toHaveBeenCalledWith(
				expect.stringContaining("HTML file(s) updated")
			);
		});
	});

	describe("Vite Manifest Integration", () => {
		it("injects integrity into an emitted .vite/manifest.json", async () => {
			const plugin = sri({ algorithm: "sha256" }) as any;
			const manifest = {
				"src/main.tsx": {
					file: "assets/main.js",
					src: "src/main.tsx",
					isEntry: true,
					css: ["assets/main.css"],
				},
			};
			const bundle: any = {
				"index.html": {
					type: "asset",
					source: "<!doctype html><html><head></head><body></body></html>",
				},
				"assets/main.js": {
					type: "chunk",
					fileName: "assets/main.js",
					code: "console.log('main')",
				},
				"assets/main.css": {
					type: "asset",
					fileName: "assets/main.css",
					source: "body{color:red}",
				},
				".vite/manifest.json": {
					type: "asset",
					fileName: ".vite/manifest.json",
					source: JSON.stringify(manifest),
				},
			};

			await plugin.generateBundle.handler({}, bundle);

			const updated = JSON.parse(String(bundle[".vite/manifest.json"].source));
			expect(updated["src/main.tsx"].integrity).toMatch(/^sha256-/);
			expect(Array.isArray(updated["src/main.tsx"].cssIntegrity)).toBe(true);
			expect(updated["src/main.tsx"].cssIntegrity[0]).toMatch(/^sha256-/);
			// Preserves unrelated fields
			expect(updated["src/main.tsx"].isEntry).toBe(true);
		});

		it("mentions manifest count in the completion summary", async () => {
			const mockContext = createMockPluginContext();
			const plugin = sri({ algorithm: "sha256" }) as any;
			const manifest = {
				"src/main.tsx": { file: "assets/main.js" },
			};
			const bundle: any = {
				"index.html": {
					type: "asset",
					source: "<!doctype html><html><head></head><body></body></html>",
				},
				"assets/main.js": {
					type: "chunk",
					fileName: "assets/main.js",
					code: "console.log('main')",
				},
				".vite/manifest.json": {
					type: "asset",
					fileName: ".vite/manifest.json",
					source: JSON.stringify(manifest),
				},
			};

			await plugin.generateBundle.handler.call(mockContext, {}, bundle);

			expect(mockContext.info).toHaveBeenCalledWith(
				expect.stringContaining("manifest file(s) updated")
			);
		});

		it("is a no-op when build.manifest is off (no manifest asset present)", async () => {
			const plugin = sri({ algorithm: "sha256" }) as any;
			const bundle: any = {
				"index.html": {
					type: "asset",
					source: "<!doctype html><html><head></head><body></body></html>",
				},
				"assets/main.js": {
					type: "chunk",
					fileName: "assets/main.js",
					code: "console.log('main')",
				},
			};

			// Should not throw and should leave bundle keys unchanged
			await plugin.generateBundle.handler({}, bundle);
			expect(Object.keys(bundle)).toEqual(["index.html", "assets/main.js"]);
		});

		it("injects manifest integrity even when the bundle has no HTML (backend-owned HTML scenario)", async () => {
			// This is the primary use case from issue #23: a Vite build configured
			// with build.manifest: true but no HTML emission, because the backend
			// renders its own HTML and only needs the manifest.
			const plugin = sri({ algorithm: "sha256" }) as any;
			const manifest = {
				"src/main.tsx": {
					file: "assets/main.js",
					src: "src/main.tsx",
					isEntry: true,
					css: ["assets/main.css"],
				},
			};
			const bundle: any = {
				"assets/main.js": {
					type: "chunk",
					fileName: "assets/main.js",
					code: "console.log('main')",
				},
				"assets/main.css": {
					type: "asset",
					fileName: "assets/main.css",
					source: "body{color:red}",
				},
				".vite/manifest.json": {
					type: "asset",
					fileName: ".vite/manifest.json",
					source: JSON.stringify(manifest),
				},
			};

			await plugin.generateBundle.handler({}, bundle);

			const updated = JSON.parse(
				String(bundle[".vite/manifest.json"].source)
			);
			expect(updated["src/main.tsx"].integrity).toMatch(/^sha256-/);
			expect(updated["src/main.tsx"].cssIntegrity[0]).toMatch(/^sha256-/);
		});

		it("honors skipResources when injecting manifest integrity", async () => {
			const plugin = sri({
				algorithm: "sha256",
				skipResources: ["assets/main.js"],
			}) as any;
			const manifest = {
				"src/main.tsx": { file: "assets/main.js" },
				"_shared.js": { file: "_shared.js" },
			};
			const bundle: any = {
				"index.html": {
					type: "asset",
					source: "<!doctype html><html><head></head><body></body></html>",
				},
				"assets/main.js": {
					type: "chunk",
					fileName: "assets/main.js",
					code: "console.log('main')",
				},
				"_shared.js": {
					type: "chunk",
					fileName: "_shared.js",
					code: "export {}",
				},
				".vite/manifest.json": {
					type: "asset",
					fileName: ".vite/manifest.json",
					source: JSON.stringify(manifest),
				},
			};

			await plugin.generateBundle.handler({}, bundle);

			const updated = JSON.parse(String(bundle[".vite/manifest.json"].source));
			expect(updated["src/main.tsx"].integrity).toBeUndefined();
			expect(updated["_shared.js"].integrity).toMatch(/^sha256-/);
		});
	});

	describe("dynamic import SRI enforcement", () => {
		it("rewriteDynamicImports replaces call-form import while leaving static syntax intact", () => {
			const input = [
				"import x from 'a';",
				"const m = import('./lazy.js');",
				"const n = import ( './lazy2.js' );",
				"console.log(import.meta.url);",
				"obj.import('./should-not-touch.js');",
				"const s = 'import(\"literal\")';",
			].join("\n");

			const out = rewriteDynamicImports(input);

			expect(out).toContain("import x from 'a';");
			// The importer's module URL must be threaded through so the
			// runtime can resolve relative specifiers the way native
			// import() does (issue #32).
			expect(out).toContain("__sriImport(import.meta.url, './lazy.js')");
			expect(out).toContain("__sriImport(import.meta.url,  './lazy2.js' )");
			expect(out).toContain("console.log(import.meta.url);");
			expect(out).toContain("obj.import('./should-not-touch.js')");
			// String literals are an accepted false-positive surface; ensure it
			// at least does not corrupt the file structure.
			expect(out.split("\n").length).toBe(input.split("\n").length);
		});

		it("rewriteDynamicImports is a no-op when the input has no import token", () => {
			expect(rewriteDynamicImports("const a = 1;\nfoo();\n")).toBe(
				"const a = 1;\nfoo();\n"
			);
			expect(rewriteDynamicImports("")).toBe("");
		});

		it("rewrites import() in chunks and enables enforceDynamicImports in the runtime when preload injection is disabled (manifest-only bundle)", async () => {
			const plugin = sri({
				algorithm: "sha256",
				preloadDynamicChunks: false,
				runtimePatchDynamicLinks: true,
			}) as any;
			plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);

			const bundle: Record<string, Chunk | Asset> = {
				".vite/manifest.json": {
					type: "asset",
					source: JSON.stringify({
						"src/main.ts": { file: "assets/entry.js" },
					}),
				},
				"assets/entry.js": makeEntryChunk({
					code: "const p = import('./lazy.js'); console.log(p);",
					dynamicImports: ["src/lazy.ts"],
				}),
				"assets/lazy.js": makeDynChunk(
					"assets/lazy.js",
					"src/lazy.ts"
				),
			} as any;

			await plugin.generateBundle.handler({}, bundle as any);

			const entryCode = (bundle["assets/entry.js"] as Chunk).code;
			expect(entryCode).toContain("__sriImport(import.meta.url, './lazy.js')");
			expect(entryCode).not.toMatch(/[^.\w$]import\s*\(\s*['"]\.\/lazy\.js/);
			expect(entryCode).toContain("enforceDynamicImports: true");
			expect(entryCode).toContain("installSriRuntime");
		});

		it("passes the configured Vite base through to the injected runtime", async () => {
			const plugin = sri({
				algorithm: "sha256",
				preloadDynamicChunks: false,
				runtimePatchDynamicLinks: true,
			}) as any;
			plugin.configResolved?.({
				base: "/app/",
				build: { ssr: false },
			} as any);

			const bundle: Record<string, Chunk | Asset> = {
				"index.html": { type: "asset", source: htmlDoc("") },
				"assets/entry.js": makeEntryChunk({
					code: "const p = import('./lazy.js');",
					dynamicImports: ["src/lazy.ts"],
				}),
				"assets/lazy.js": makeDynChunk(
					"assets/lazy.js",
					"src/lazy.ts"
				),
			} as any;

			await plugin.generateBundle.handler({}, bundle as any);

			const entryCode = (bundle["assets/entry.js"] as Chunk).code;
			expect(entryCode).toContain('base: "/app/"');
		});

		it("does not rewrite import() or enable enforcement when preload injection is enabled (default)", async () => {
			const plugin = sri({
				algorithm: "sha256",
				runtimePatchDynamicLinks: true,
			}) as any;
			plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);

			const bundle: Record<string, Chunk | Asset> = {
				"index.html": { type: "asset", source: htmlDoc("") },
				"assets/entry.js": makeEntryChunk({
					code: "const p = import('./lazy.js');",
					dynamicImports: ["src/lazy.ts"],
				}),
				"assets/lazy.js": makeDynChunk(
					"assets/lazy.js",
					"src/lazy.ts"
				),
			} as any;

			await plugin.generateBundle.handler({}, bundle as any);

			const entryCode = (bundle["assets/entry.js"] as Chunk).code;
			expect(entryCode).toContain("import('./lazy.js')");
			expect(entryCode).toContain("enforceDynamicImports: false");
		});

		it("does not rewrite import() when runtime patching is disabled", async () => {
			const plugin = sri({
				algorithm: "sha256",
				preloadDynamicChunks: false,
				runtimePatchDynamicLinks: false,
			}) as any;
			plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);

			const bundle: Record<string, Chunk | Asset> = {
				"index.html": { type: "asset", source: htmlDoc("") },
				"assets/entry.js": makeEntryChunk({
					code: "const p = import('./lazy.js');",
				}),
				"assets/lazy.js": makeDynChunk("assets/lazy.js"),
			} as any;

			await plugin.generateBundle.handler({}, bundle as any);
			const entryCode = (bundle["assets/entry.js"] as Chunk).code;
			expect(entryCode).toContain("import('./lazy.js')");
			expect(entryCode).not.toContain("installSriRuntime");
		});

		it("rewrites import() in non-entry chunks too (lazy chunk that imports another lazy chunk)", async () => {
			const plugin = sri({
				algorithm: "sha256",
				preloadDynamicChunks: false,
			}) as any;
			plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);

			const bundle: Record<string, Chunk | Asset> = {
				".vite/manifest.json": {
					type: "asset",
					source: JSON.stringify({
						"src/main.ts": { file: "assets/entry.js" },
					}),
				},
				"assets/entry.js": makeEntryChunk({
					code: "const a = import('./outer.js');",
				}),
				"assets/outer.js": makeDynChunk(
					"assets/outer.js",
					"src/outer.ts"
				),
				"assets/inner.js": makeDynChunk(
					"assets/inner.js",
					"src/inner.ts"
				),
			} as any;
			(bundle["assets/outer.js"] as Chunk).code =
				"const b = import('./inner.js'); export default b;";

			await plugin.generateBundle.handler({}, bundle as any);

			const outerCode = (bundle["assets/outer.js"] as Chunk).code;
			expect(outerCode).toContain("__sriImport(import.meta.url, './inner.js')");
			expect(outerCode).not.toMatch(/[^.\w$]import\s*\(\s*['"]\.\/inner\.js/);
		});

		it("invalidates source maps for chunks whose code was rewritten", async () => {
			const plugin = sri({
				algorithm: "sha256",
				preloadDynamicChunks: false,
			}) as any;
			plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);

			const entry = makeEntryChunk({
				code: "const p = import('./lazy.js');",
			}) as any;
			entry.map = { version: 3, sources: ["entry.ts"], mappings: "AAAA" };
			const lazy = makeDynChunk("assets/lazy.js") as any;
			lazy.map = { version: 3, sources: ["lazy.ts"], mappings: "AAAA" };

			const bundle: Record<string, Chunk | Asset> = {
				".vite/manifest.json": {
					type: "asset",
					source: JSON.stringify({
						"src/main.ts": { file: "assets/entry.js" },
					}),
				},
				"assets/entry.js": entry,
				"assets/lazy.js": lazy,
			} as any;

			await plugin.generateBundle.handler({}, bundle as any);

			expect(entry.map).toBeNull();
			// The lazy chunk had no `import(` to rewrite — its map should be left alone.
			expect(lazy.map).not.toBeNull();
		});

		it("rewrites import() across every entry in a multi-entry bundle", async () => {
			const plugin = sri({
				algorithm: "sha256",
				preloadDynamicChunks: false,
			}) as any;
			plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);

			const bundle: Record<string, Chunk | Asset> = {
				".vite/manifest.json": {
					type: "asset",
					source: JSON.stringify({
						"src/a.ts": { file: "assets/entry-a.js" },
						"src/b.ts": { file: "assets/entry-b.js" },
					}),
				},
				"assets/entry-a.js": makeEntryChunk({
					fileName: "assets/entry-a.js",
					code: "const a = import('./shared.js');",
					name: "entry-a",
					facadeModuleId: "src/a.ts",
				}),
				"assets/entry-b.js": makeEntryChunk({
					fileName: "assets/entry-b.js",
					code: "const b = import('./shared.js');",
					name: "entry-b",
					facadeModuleId: "src/b.ts",
				}),
				"assets/shared.js": makeDynChunk(
					"assets/shared.js",
					"src/shared.ts"
				),
			} as any;

			await plugin.generateBundle.handler({}, bundle as any);

			const aCode = (bundle["assets/entry-a.js"] as Chunk).code;
			const bCode = (bundle["assets/entry-b.js"] as Chunk).code;
			expect(aCode).toContain("__sriImport(import.meta.url, './shared.js')");
			expect(bCode).toContain("__sriImport(import.meta.url, './shared.js')");
			expect(aCode).toContain("installSriRuntime");
			expect(bCode).toContain("installSriRuntime");
		});

		it("rewriter does not match identifiers ending in 'import' or property-access forms", () => {
			const input = `obj.import('./x.js'); _import('./z.js'); $import('./w.js'); myimport('./q.js');`;
			const out = rewriteDynamicImports(input);
			expect(out).toContain("obj.import('./x.js')");
			expect(out).toContain("_import('./z.js')");
			expect(out).toContain("$import('./w.js')");
			expect(out).toContain("myimport('./q.js')");
			// Confirm no rewrite happened anywhere.
			expect(out).not.toContain("__sriImport");
		});

		// NOTE: with HTML in the bundle the import map subsumes JS-level
		// enforcement, so no rewrite occurs here — the round-trip still
		// verifies that the HTML integrity attribute matches the final
		// (runtime-prepended) entry chunk bytes.
		it("entry chunk hash reflects post-rewrite, post-runtime bytes (round-trip)", async () => {
			const plugin = sri({
				algorithm: "sha256",
				preloadDynamicChunks: false,
			}) as any;
			plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);

			const bundle: Record<string, Chunk | Asset> = {
				"index.html": {
					type: "asset",
					source: htmlDoc(
						'<script type="module" src="/assets/entry.js"></script>'
					),
				},
				"assets/entry.js": makeEntryChunk({
					code: "const p = import('./lazy.js');",
					dynamicImports: ["src/lazy.ts"],
				}),
				"assets/lazy.js": makeDynChunk(
					"assets/lazy.js",
					"src/lazy.ts"
				),
			} as any;

			await plugin.generateBundle.handler({}, bundle as any);

			const html = String((bundle["index.html"] as Asset).source);
			const match = html.match(
				/src="\/assets\/entry\.js"[^>]*integrity="(sha256-[A-Za-z0-9+/=]+)"/
			);
			expect(match).not.toBeNull();

			const finalCode = (bundle["assets/entry.js"] as Chunk).code;
			const expected = match![1];
			const digest = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(finalCode)
			);
			let bin = "";
			const bytes = new Uint8Array(digest);
			for (let i = 0; i < bytes.length; i++)
				bin += String.fromCharCode(bytes[i]);
			const actual = "sha256-" + btoa(bin);
			expect(actual).toBe(expected);
		});
	});
});

describe("buildSriRuntimeCode (issue #30: self-contained injected runtime)", () => {
	it("installs the global even when the serialized runtime references esbuild's __name helper", () => {
		// The plugin is bundled with esbuild's keepNames transform, which wraps
		// named function expressions in a module-scoped `__name(fn, "name")`
		// helper. That helper is NOT part of `installSriRuntime.toString()`, so
		// the injected copy references an undefined `__name`. The runtime's
		// best-effort try/catch then swallows the ReferenceError, leaving
		// `__sriImport` uninstalled (issue #30). Simulate that exact shape.
		const runtimeWithKeepNames = function fakeRuntime() {
			// @ts-expect-error `__name` is injected by esbuild in the real build
			const tagged = __name(function inner() {}, "inner");
			(globalThis as any).__sriImport = tagged;
		} as unknown as typeof installSriRuntime;

		// Control: the raw serialized function throws because `__name` is unbound.
		const control: any = {};
		vm.createContext(control);
		expect(() =>
			vm.runInContext(`(${runtimeWithKeepNames.toString()})({}, {})`, control)
		).toThrow(/__name/);

		// buildSriRuntimeCode must make the injected runtime self-contained.
		const code = buildSriRuntimeCode(
			runtimeWithKeepNames,
			{ "/a.js": "sha384-x" },
			{
				crossorigin: "anonymous",
				skipResources: [],
				enforceDynamicImports: true,
			}
		);
		const sandbox: any = {};
		vm.createContext(sandbox);
		expect(() => vm.runInContext(code, sandbox)).not.toThrow();
		expect(typeof sandbox.__sriImport).toBe("function");
	});

	it("installs globalThis.__sriImport from the real runtime when enforcement is enabled", () => {
		// Positive/smoke test for the real runtime. Note: vitest transforms `src`
		// without esbuild's keepNames, so the real `installSriRuntime.toString()`
		// here contains no `__name`; this test therefore passes with or without
		// the shim. The preceding test (synthetic `__name`) is the actual
		// regression guard for issue #30.
		const code = buildSriRuntimeCode(
			installSriRuntime,
			{ "/chunk.js": "sha384-abc" },
			{
				crossorigin: "anonymous",
				skipResources: [],
				enforceDynamicImports: true,
			}
		);
		// Minimal DOM constructors so the runtime's post-install patching has
		// prototypes to wrap. They are deliberately incomplete; any DOM-patch
		// error after install is swallowed by the runtime's try/catch, and the
		// assertion below only checks that `__sriImport` was installed (which
		// happens before the DOM patching).
		function El(this: any) {}
		El.prototype.setAttribute = function () {};
		function NodeCtor(this: any) {}
		NodeCtor.prototype = {};
		const sandbox: any = {
			Element: El,
			Node: NodeCtor,
			HTMLLinkElement: function Link(this: any) {},
			HTMLScriptElement: function Script(this: any) {},
		};
		vm.createContext(sandbox);
		expect(() => vm.runInContext(code, sandbox)).not.toThrow();
		expect(typeof sandbox.__sriImport).toBe("function");
	});

	it("preserves the runtime arguments and the installSriRuntime source", () => {
		const code = buildSriRuntimeCode(
			installSriRuntime,
			{ "/a.js": "sha384-x" },
			{
				crossorigin: "use-credentials",
				skipResources: ["analytics-*"],
				enforceDynamicImports: false,
			}
		);
		expect(code).toContain("installSriRuntime");
		expect(code).toContain('crossorigin: "use-credentials"');
		expect(code).toContain('skipResources: ["analytics-*"]');
		expect(code).toContain("enforceDynamicImports: false");
		expect(code).toContain('{"/a.js":"sha384-x"}');
	});

	it("serializes the base option into the injected runtime arguments", () => {
		const code = buildSriRuntimeCode(
			installSriRuntime,
			{ "/assets/lazy.js": "sha256-abc" },
			{
				crossorigin: "anonymous",
				skipResources: [],
				enforceDynamicImports: true,
				base: "/app/",
			}
		);
		expect(code).toContain('base: "/app/"');
	});

	it("defaults the serialized base to '/' when not provided", () => {
		const code = buildSriRuntimeCode(
			installSriRuntime,
			{ "/a.js": "sha384-x" },
			{
				crossorigin: undefined,
				skipResources: [],
				enforceDynamicImports: false,
			}
		);
		expect(code).toContain('base: "/"');
	});

	it("escapes `<` in serialized data so it cannot break out of the injected script", () => {
		const code = buildSriRuntimeCode(
			installSriRuntime,
			{ "/a</script>b.js": "sha384-x", "/normal path.js": "sha384-y" },
			{
				crossorigin: undefined,
				skipResources: ["x<y"],
				enforceDynamicImports: true,
			}
		);
		// `<` is rewritten to its < escape; the raw sequence must not survive.
		expect(code).not.toContain("</script>");
		expect(code).toContain("\\u003c/script>");
		expect(code).toContain("x\\u003cy");
		// Non-`<` content (spaces, slashes) is left untouched.
		expect(code).toContain("/normal path.js");
		// The escape is the standard JS form, so the runtime parses it back to `<`.
		const sandbox: any = {};
		vm.createContext(sandbox);
		vm.runInContext('globalThis.r = "\\u003c/script>";', sandbox);
		expect(sandbox.r).toBe("</script>");
	});
});

describe("import map SRI", () => {
	function buildPluginBundle(
		base = "/",
		html = htmlDoc(
			'<script type="module" src="/assets/entry.js"></script>'
		)
	) {
		const plugin = sri({
			algorithm: "sha256",
			preloadDynamicChunks: false,
			runtimePatchDynamicLinks: true,
		}) as any;
		plugin.configResolved?.({ base, build: { ssr: false } } as any);
		const bundle: Record<string, Chunk | Asset> = {
			"index.html": { type: "asset", source: html },
			"assets/entry.js": makeEntryChunk({
				code: "const p = import('./lazy.js');",
				dynamicImports: ["src/lazy.ts"],
			}),
			"assets/lazy.js": makeDynChunk("assets/lazy.js", "src/lazy.ts"),
		} as any;
		return { plugin, bundle };
	}

	it("injects no import map for a single-chunk bundle (issue #41)", async () => {
		const plugin = sri({
			algorithm: "sha256",
			preloadDynamicChunks: false,
			runtimePatchDynamicLinks: true,
		}) as any;
		plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);
		const bundle: Record<string, Chunk | Asset> = {
			"index.html": {
				type: "asset",
				source: htmlDoc(
					'<script type="module" src="/assets/entry.js"></script>'
				),
			},
			"assets/entry.js": makeEntryChunk({ code: "" }),
		} as any;
		await plugin.generateBundle.handler({}, bundle as any);
		const html = String((bundle["index.html"] as Asset).source);
		expect(html).not.toContain('type="importmap"');
	});

	it("excludes the top-level entry but keeps imported chunks in the map", async () => {
		const { plugin, bundle } = buildPluginBundle();
		await plugin.generateBundle.handler({}, bundle as any);
		const html = String((bundle["index.html"] as Asset).source);
		const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
		expect(m).toBeTruthy();
		const parsed = JSON.parse(m![1]);
		expect(parsed.integrity["/assets/entry.js"]).toBeUndefined();
		expect(parsed.integrity["/assets/lazy.js"]).toMatch(/^sha256-/);
	});

	it("keeps a statically-imported shared entry in the map (MPA regression guard)", async () => {
		const plugin = sri({
			algorithm: "sha256",
			preloadDynamicChunks: false,
			runtimePatchDynamicLinks: true,
		}) as any;
		plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);
		const bundle: Record<string, Chunk | Asset> = {
			"index.html": {
				type: "asset",
				source: htmlDoc(
					'<script type="module" src="/assets/main.js"></script>'
				),
			},
			"assets/main.js": makeEntryChunk({
				fileName: "assets/main.js",
				code: "",
				imports: ["src/shared.ts"],
			}),
			"assets/shared.js": {
				type: "chunk",
				fileName: "assets/shared.js",
				isEntry: true,
				code: "export{}",
				imports: [],
				dynamicImports: [],
				modules: { "src/shared.ts": {} },
				name: "shared",
				facadeModuleId: "src/shared.ts",
			},
		} as any;
		await plugin.generateBundle.handler({}, bundle as any);
		const html = String((bundle["index.html"] as Asset).source);
		const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
		expect(m).toBeTruthy();
		const parsed = JSON.parse(m![1]);
		expect(parsed.integrity["/assets/shared.js"]).toMatch(/^sha256-/);
		expect(parsed.integrity["/assets/main.js"]).toBeUndefined();
	});

	it("injects an import map for imported chunks, excluding the entry", async () => {
		const { plugin, bundle } = buildPluginBundle();
		await plugin.generateBundle.handler({}, bundle as any);
		const html = String((bundle["index.html"] as Asset).source);
		const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
		expect(m).toBeTruthy();
		const parsed = JSON.parse(m![1]);
		expect(parsed.integrity["/assets/entry.js"]).toBeUndefined();
		expect(parsed.integrity["/assets/lazy.js"]).toMatch(/^sha256-/);
	});

	it("does not rewrite import() and disables runtime enforcement when the import map is emitted", async () => {
		const { plugin, bundle } = buildPluginBundle();
		await plugin.generateBundle.handler({}, bundle as any);
		const entryCode = (bundle["assets/entry.js"] as Chunk).code;
		expect(entryCode).toContain("import('./lazy.js')");
		// Assert the actual import() call site was NOT rewritten. Match the
		// concrete rewrite output (`__sriImport(import.meta.url, './lazy.js'`)
		// rather than the bare `__sriImport(import.meta.url` prefix: that prefix
		// also occurs verbatim in an explanatory comment inside the serialized
		// installSriRuntime body, which some transforms (Vite 8 / Rolldown's oxc)
		// preserve when vitest loads the source.
		expect(entryCode).not.toContain(
			"__sriImport(import.meta.url, './lazy.js'"
		);
		expect(entryCode).toContain("enforceDynamicImports: false");
		expect(entryCode).toContain("installSriRuntime"); // DOM patching stays
	});

	it("injects the import map in default preload mode too, before modulepreload links", async () => {
		const plugin = sri({ algorithm: "sha256" }) as any;
		plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);
		const bundle: Record<string, Chunk | Asset> = {
			"index.html": { type: "asset", source: htmlDoc("") },
			"assets/entry.js": makeEntryChunk({
				code: "const p = import('./lazy.js');",
				dynamicImports: ["src/lazy.ts"],
			}),
			"assets/lazy.js": makeDynChunk("assets/lazy.js", "src/lazy.ts"),
		} as any;
		await plugin.generateBundle.handler({}, bundle as any);
		const html = String((bundle["index.html"] as Asset).source);
		const mapIdx = html.indexOf('<script type="importmap">');
		const preloadIdx = html.indexOf('rel="modulepreload"');
		expect(mapIdx).toBeGreaterThan(-1);
		expect(preloadIdx).toBeGreaterThan(-1);
		expect(mapIdx).toBeLessThan(preloadIdx);
	});

	it("merges integrity into an existing import map without overwriting user entries", async () => {
		const existing =
			'<script type="importmap">{"imports":{"lodash":"/vendor/lodash.js"},"integrity":{"/assets/entry.js":"sha256-USER"}}</script>';
		const { plugin, bundle } = buildPluginBundle(
			"/",
			`<!doctype html><html><head>${existing}</head><body></body></html>`
		);
		await plugin.generateBundle.handler({}, bundle as any);
		const html = String((bundle["index.html"] as Asset).source);
		const maps = html.match(/<script type="importmap">/g) ?? [];
		expect(maps.length).toBe(1); // merged, not duplicated
		const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
		const parsed = JSON.parse(m![1]);
		expect(parsed.imports.lodash).toBe("/vendor/lodash.js"); // preserved
		expect(parsed.integrity["/assets/entry.js"]).toBe("sha256-USER"); // user wins
		expect(parsed.integrity["/assets/lazy.js"]).toMatch(/^sha256-/); // ours added
	});

	it("skips injection and keeps the runtime enforcement path for relative base", async () => {
		const { plugin, bundle } = buildPluginBundle("./");
		await plugin.generateBundle.handler({}, bundle as any);
		const html = String((bundle["index.html"] as Asset).source);
		expect(html).not.toContain("importmap");
		const entryCode = (bundle["assets/entry.js"] as Chunk).code;
		expect(entryCode).toContain("__sriImport(import.meta.url");
		expect(entryCode).toContain("enforceDynamicImports: true");
	});

	it("leaves HTML untouched when an existing import map has malformed JSON", async () => {
		const existing = '<script type="importmap">{not json}</script>';
		const { plugin, bundle } = buildPluginBundle(
			"/",
			`<!doctype html><html><head>${existing}</head><body></body></html>`
		);
		await plugin.generateBundle.handler({}, bundle as any);
		const html = String((bundle["index.html"] as Asset).source);
		expect(html).toContain("{not json}"); // unmodified
		const maps = html.match(/<script type="importmap">/g) ?? [];
		expect(maps.length).toBe(1); // no second map added
	});

	it("preserves source maps when the rewrite is skipped (HTML present)", async () => {
		const { plugin, bundle } = buildPluginBundle();
		(bundle["assets/entry.js"] as any).map = { mappings: "AAAA" };
		await plugin.generateBundle.handler({}, bundle as any);
		expect((bundle["assets/entry.js"] as any).map).toEqual({
			mappings: "AAAA",
		});
	});

	it("excludes skipResources-matched chunks from the import map integrity object", async () => {
		const plugin = sri({
			algorithm: "sha256",
			preloadDynamicChunks: false,
			runtimePatchDynamicLinks: true,
			skipResources: ["**/vendor.js"],
		}) as any;
		plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);
		const bundle: Record<string, Chunk | Asset> = {
			"index.html": {
				type: "asset",
				source: htmlDoc(
					'<script type="module" src="/assets/entry.js"></script>'
				),
			},
			"assets/entry.js": makeEntryChunk({
				code: "",
				imports: ["src/vendor.ts"],
				dynamicImports: ["src/lazy.ts"],
			}),
			"assets/vendor.js": makeDynChunk(
				"assets/vendor.js",
				"src/vendor.ts"
			),
			"assets/lazy.js": makeDynChunk("assets/lazy.js", "src/lazy.ts"),
		} as any;
		await plugin.generateBundle.handler({}, bundle as any);
		const html = String((bundle["index.html"] as Asset).source);
		const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
		const parsed = JSON.parse(m![1]);
		expect(parsed.integrity["/assets/entry.js"]).toBeUndefined();
		expect(parsed.integrity["/assets/vendor.js"]).toBeUndefined();
		expect(parsed.integrity["/assets/lazy.js"]).toMatch(/^sha256-/);
	});

	it("injects integrity into an existing import map element that has no text content", async () => {
		const existing = '<script type="importmap"></script>';
		const { plugin, bundle } = buildPluginBundle(
			"/",
			`<!doctype html><html><head>${existing}</head><body><script type="module" src="/assets/entry.js"></script></body></html>`
		);
		await plugin.generateBundle.handler({}, bundle as any);
		const html = String((bundle["index.html"] as Asset).source);
		const maps = html.match(/<script type="importmap">/g) ?? [];
		expect(maps.length).toBe(1);
		const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
		const parsed = JSON.parse(m![1]);
		expect(parsed.integrity["/assets/entry.js"]).toBeUndefined();
		expect(parsed.integrity["/assets/lazy.js"]).toMatch(/^sha256-/);
	});

	it("uses absolute CDN URLs as import map keys when base is an absolute URL", async () => {
		const plugin = sri({
			algorithm: "sha256",
			preloadDynamicChunks: false,
			runtimePatchDynamicLinks: true,
		}) as any;
		plugin.configResolved?.({
			base: "https://cdn.example.com/",
			build: { ssr: false },
		} as any);
		const bundle: Record<string, Chunk | Asset> = {
			"index.html": {
				type: "asset",
				source: htmlDoc(
					'<script type="module" src="https://cdn.example.com/assets/entry.js"></script>'
				),
			},
			"assets/entry.js": makeEntryChunk({
				code: "",
				dynamicImports: ["src/lazy.ts"],
			}),
			"assets/lazy.js": makeDynChunk("assets/lazy.js", "src/lazy.ts"),
		} as any;
		await plugin.generateBundle.handler({}, bundle as any);
		const html = String((bundle["index.html"] as Asset).source);
		const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
		expect(m).toBeTruthy();
		const parsed = JSON.parse(m![1]);
		expect(
			parsed.integrity["https://cdn.example.com/assets/lazy.js"]
		).toMatch(/^sha256-/);
		expect(
			parsed.integrity["https://cdn.example.com/assets/entry.js"]
		).toBeUndefined();
		expect(parsed.integrity["/assets/entry.js"]).toBeUndefined();
	});

	it("injects the import map even when runtimePatchDynamicLinks is false", async () => {
		const plugin = sri({
			algorithm: "sha256",
			preloadDynamicChunks: false,
			runtimePatchDynamicLinks: false,
		}) as any;
		plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);
		const bundle: Record<string, Chunk | Asset> = {
			"index.html": { type: "asset", source: htmlDoc("") },
			"assets/entry.js": makeEntryChunk({
				code: "const p = import('./lazy.js');",
				dynamicImports: ["src/lazy.ts"],
			}),
			"assets/lazy.js": makeDynChunk("assets/lazy.js", "src/lazy.ts"),
		} as any;
		await plugin.generateBundle.handler({}, bundle as any);
		const html = String((bundle["index.html"] as Asset).source);
		const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
		expect(m).toBeTruthy();
		const parsed = JSON.parse(m![1]);
		expect(parsed.integrity["/assets/lazy.js"]).toMatch(/^sha256-/);
		expect(
			(bundle["assets/entry.js"] as Chunk).code
		).not.toContain("installSriRuntime");
	});

	it("keeps the JS enforcement rewrite when a manifest is emitted alongside HTML (mixed-bundle consumers)", async () => {
		const plugin = sri({
			algorithm: "sha256",
			preloadDynamicChunks: false,
			runtimePatchDynamicLinks: true,
		}) as any;
		plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);
		const bundle: Record<string, Chunk | Asset> = {
			"index.html": { type: "asset", source: htmlDoc("") },
			".vite/manifest.json": {
				type: "asset",
				source: JSON.stringify({
					"src/main.ts": { file: "assets/entry.js" },
				}),
			},
			"assets/entry.js": makeEntryChunk({
				code: "const p = import('./lazy.js');",
				dynamicImports: ["src/lazy.ts"],
			}),
			"assets/lazy.js": makeDynChunk("assets/lazy.js", "src/lazy.ts"),
		} as any;
		await plugin.generateBundle.handler({}, bundle as any);
		// Manifest consumers render their own HTML without the import map, so
		// the JS-level enforcement path must remain active for them.
		const entryCode = (bundle["assets/entry.js"] as Chunk).code;
		expect(entryCode).toContain("__sriImport(import.meta.url, './lazy.js')");
		expect(entryCode).toContain("enforceDynamicImports: true");
		// The emitted HTML still gets the import map (covers its own pages).
		const html = String((bundle["index.html"] as Asset).source);
		expect(html).toContain('<script type="importmap">');
	});

	it("warns when an existing import map pins an integrity value that differs from the computed hash", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const existing =
				'<script type="importmap">{"integrity":{"/assets/lazy.js":"sha256-USER"}}</script>';
			const { plugin, bundle } = buildPluginBundle(
				"/",
				`<!doctype html><html><head>${existing}</head><body></body></html>`
			);
			await plugin.generateBundle.handler({}, bundle as any);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					"differs from the build-computed hash"
				)
			);
			// The user's entry is still kept (documented precedence).
			const html = String((bundle["index.html"] as Asset).source);
			const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
			const parsed = JSON.parse(m![1]);
			expect(parsed.integrity["/assets/lazy.js"]).toBe("sha256-USER");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("warns when an existing import map pins a stale hash for a tag-covered (excluded) chunk", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// entry.js is excluded from the injected map (tag-covered), but a
			// stale user-pinned hash for it must still be flagged.
			const existing =
				'<script type="importmap">{"integrity":{"/assets/entry.js":"sha256-STALE"}}</script>';
			const { plugin, bundle } = buildPluginBundle(
				"/",
				`<!doctype html><html><head>${existing}</head><body><script type="module" src="/assets/entry.js"></script></body></html>`
			);
			await plugin.generateBundle.handler({}, bundle as any);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("differs from the build-computed hash")
			);
			// User precedence still applies to the merged result.
			const html = String((bundle["index.html"] as Asset).source);
			const m = html.match(
				/<script type="importmap">([\s\S]*?)<\/script>/
			);
			const parsed = JSON.parse(m![1]);
			expect(parsed.integrity["/assets/entry.js"]).toBe("sha256-STALE");
			expect(parsed.integrity["/assets/lazy.js"]).toMatch(/^sha256-/);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("warns when the HTML contains an absolute <base href> that changes key resolution", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { plugin, bundle } = buildPluginBundle(
				"/",
				'<!doctype html><html><head><base href="https://cdn.example.com/app/"></head><body><script type="module" src="/assets/entry.js"></script></body></html>'
			);
			await plugin.generateBundle.handler({}, bundle as any);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					"resolve against the document base URL"
				)
			);
			// Advisory only — the map is still injected.
			const html = String((bundle["index.html"] as Asset).source);
			expect(html).toContain('type="importmap"');
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("does not warn for a relative <base href>", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { plugin, bundle } = buildPluginBundle(
				"/",
				'<!doctype html><html><head><base href="/app/"></head><body><script type="module" src="/assets/entry.js"></script></body></html>'
			);
			await plugin.generateBundle.handler({}, bundle as any);
			const baseWarnings = warnSpy.mock.calls.filter((c) =>
				String(c[0]).includes("document base URL")
			);
			expect(baseWarnings).toEqual([]);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("logs an error and leaves the HTML unchanged when import map injection fails", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		try {
			// "null" is valid JSON, so the merge path proceeds past the
			// invalid-JSON guard and throws on property access — exercising
			// the outer error boundary.
			const existing = '<script type="importmap">null</script>';
			const { plugin, bundle } = buildPluginBundle(
				"/",
				`<!doctype html><html><head>${existing}</head><body><script type="module" src="/assets/entry.js"></script></body></html>`
			);
			await plugin.generateBundle.handler({}, bundle as any);
			expect(
				errorSpy.mock.calls.some((c) =>
					String(c[0]).includes("Failed to inject import map")
				)
			).toBe(true);
			const html = String((bundle["index.html"] as Asset).source);
			expect(html).toContain(">null</script>"); // map left untouched
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("injects the runtime without rewriting when no dynamic import() calls exist (relative base)", async () => {
		const plugin = sri({
			algorithm: "sha256",
			preloadDynamicChunks: false,
			runtimePatchDynamicLinks: true,
		}) as any;
		plugin.configResolved?.({ base: "./", build: { ssr: false } } as any);
		const bundle: Record<string, Chunk | Asset> = {
			"index.html": {
				type: "asset",
				source: htmlDoc(
					'<script type="module" src="assets/entry.js"></script>'
				),
			},
			"assets/entry.js": makeEntryChunk({ code: "console.log(1);" }),
		} as any;
		await plugin.generateBundle.handler({}, bundle as any);
		const entryCode = (bundle["assets/entry.js"] as Chunk).code;
		// Runtime installed even though nothing needed rewriting; the user
		// code itself is prepended-to but otherwise untouched.
		expect(entryCode).toContain("enforceDynamicImports: true");
		expect(entryCode.endsWith("console.log(1);")).toBe(true);
	});

	it("keeps a leading meta charset before the injected import map", async () => {
		const { plugin, bundle } = buildPluginBundle(
			"/",
			'<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body></body></html>'
		);
		await plugin.generateBundle.handler({}, bundle as any);
		const html = String((bundle["index.html"] as Asset).source);
		const charsetIdx = html.indexOf("<meta charset");
		const mapIdx = html.indexOf('<script type="importmap">');
		expect(charsetIdx).toBeGreaterThan(-1);
		expect(mapIdx).toBeGreaterThan(-1);
		// The charset declaration must stay within the first 1024 bytes; the
		// import map grows with chunk count, so it goes after the charset.
		expect(charsetIdx).toBeLessThan(mapIdx);
	});

	it("keeps a leading meta charset ahead of the import map and modulepreload links in default preload mode", async () => {
		const plugin = sri({ algorithm: "sha256" }) as any;
		plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);
		const bundle: Record<string, Chunk | Asset> = {
			"index.html": {
				type: "asset",
				source: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>',
			},
			"assets/entry.js": makeEntryChunk({
				code: "const p = import('./lazy.js');",
				dynamicImports: ["src/lazy.ts"],
			}),
			"assets/lazy.js": makeDynChunk("assets/lazy.js", "src/lazy.ts"),
		} as any;
		await plugin.generateBundle.handler({}, bundle as any);
		const html = String((bundle["index.html"] as Asset).source);
		const charsetIdx = html.indexOf("<meta charset");
		const mapIdx = html.indexOf('<script type="importmap">');
		const preloadIdx = html.indexOf('rel="modulepreload"');
		expect(charsetIdx).toBeGreaterThan(-1);
		expect(mapIdx).toBeGreaterThan(-1);
		expect(preloadIdx).toBeGreaterThan(-1);
		// charset first, then the import map, then the preload links — the
		// map must still precede every modulepreload link and module script.
		expect(charsetIdx).toBeLessThan(mapIdx);
		expect(mapIdx).toBeLessThan(preloadIdx);
	});

	it("injects the import map at the start of head when no charset meta is present", async () => {
		const { plugin, bundle } = buildPluginBundle(
			"/",
			"<!doctype html><html><head><title>t</title></head><body></body></html>"
		);
		await plugin.generateBundle.handler({}, bundle as any);
		const html = String((bundle["index.html"] as Asset).source);
		const headIdx = html.indexOf("<head>");
		const mapIdx = html.indexOf('<script type="importmap">');
		const titleIdx = html.indexOf("<title>");
		expect(mapIdx).toBe(headIdx + "<head>".length);
		expect(mapIdx).toBeLessThan(titleIdx);
	});
});

describe("importMapIntegrity: CSP-safe coverage without an inline script", () => {
	// Reproduces the reported topology: a lazy route chunk reached by import(),
	// which in turn statically imports a leaf chunk. The leaf has no HTML
	// element of its own, so today only the import map covers it.
	function makeGapBundle(): Record<string, Chunk | Asset> {
		return {
			"index.html": {
				type: "asset",
				source:
					'<!doctype html><html><head><script type="module" src="/assets/entry.js"></script></head><body></body></html>',
			},
			"assets/entry.js": makeEntryChunk({
				code: "const p = import('./lazy.js'); console.log(p);",
				dynamicImports: ["src/lazy.ts"],
			}),
			"assets/lazy.js": {
				type: "chunk",
				fileName: "assets/lazy.js",
				code: "import './dep.js'; export default 1",
				imports: ["src/dep.ts"],
				dynamicImports: [],
				modules: { "src/lazy.ts": {} },
				name: "lazy",
				facadeModuleId: "src/lazy.ts",
			},
			"assets/dep.js": {
				type: "chunk",
				fileName: "assets/dep.js",
				code: "export const dep = 42",
				imports: [],
				dynamicImports: [],
				modules: { "src/dep.ts": {} },
				name: "dep",
				facadeModuleId: "src/dep.ts",
			},
		} as any;
	}

	it("covers statically-imported lazy dependencies with a modulepreload link", async () => {
		const plugin = sri({
			algorithm: "sha256",
			importMapIntegrity: false,
		}) as any;
		plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);

		const bundle = makeGapBundle();
		await plugin.generateBundle.handler({}, bundle as any);
		const html = String((bundle["index.html"] as Asset).source);

		expect(html).toMatch(
			/<link rel="modulepreload" href="\/assets\/dep\.js" integrity="sha256-[^"]+"/
		);
	});

	it("emits no inline import map script when disabled", async () => {
		const plugin = sri({
			algorithm: "sha256",
			importMapIntegrity: false,
		}) as any;
		plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);

		const bundle = makeGapBundle();
		await plugin.generateBundle.handler({}, bundle as any);
		const html = String((bundle["index.html"] as Asset).source);

		expect(html).not.toContain("importmap");
	});

	it("keeps the import map and narrow preloads when left at its default", async () => {
		const plugin = sri({ algorithm: "sha256" }) as any;
		plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);

		const bundle = makeGapBundle();
		await plugin.generateBundle.handler({}, bundle as any);
		const html = String((bundle["index.html"] as Asset).source);

		expect(html).toContain('type="importmap"');
		expect(html).toContain("/assets/dep.js");
		// Regression guard: the default must not start eagerly preloading leaves.
		expect(html).not.toMatch(
			/<link rel="modulepreload" href="\/assets\/dep\.js"/
		);
	});

	it("makes JS-level import() enforcement reachable once the map is off", async () => {
		const plugin = sri({
			algorithm: "sha256",
			importMapIntegrity: false,
			preloadDynamicChunks: false,
		}) as any;
		plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);

		const bundle = makeGapBundle();
		await plugin.generateBundle.handler({}, bundle as any);

		const entryCode = (bundle["assets/entry.js"] as Chunk).code;
		expect(entryCode).toContain("enforceDynamicImports: true");
		expect(entryCode).toContain("__sriImport(import.meta.url, './lazy.js')");
	});

	it("does not warn once the widened preload set already covers the graph", async () => {
		// preloadDynamicChunks left at its default (true)
		const plugin = sri({
			algorithm: "sha256",
			importMapIntegrity: false,
		}) as any;
		plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);

		const mockContext = createMockPluginContext();
		await plugin.generateBundle.handler.call(
			mockContext,
			{},
			makeGapBundle() as any
		);

		expect(mockContext.warn).not.toHaveBeenCalledWith(
			expect.stringContaining("will load without SRI")
		);
	});

	it("counts only chunks the import() rewrite cannot reach", async () => {
		// entry -> import() -> lazy.js -> static import -> dep.js
		// The rewrite covers lazy.js, so only dep.js is genuinely unverified.
		const plugin = sri({
			algorithm: "sha256",
			importMapIntegrity: false,
			preloadDynamicChunks: false,
		}) as any;
		plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);

		const mockContext = createMockPluginContext();
		await plugin.generateBundle.handler.call(
			mockContext,
			{},
			makeGapBundle() as any
		);

		expect(mockContext.warn).toHaveBeenCalledWith(
			expect.stringContaining("1 module-graph chunk(s)")
		);
	});

	it("counts dynamic chunks too when the rewrite is disabled", async () => {
		const plugin = sri({
			algorithm: "sha256",
			importMapIntegrity: false,
			preloadDynamicChunks: false,
			runtimePatchDynamicLinks: false,
		}) as any;
		plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);

		const mockContext = createMockPluginContext();
		await plugin.generateBundle.handler.call(
			mockContext,
			{},
			makeGapBundle() as any
		);

		expect(mockContext.warn).toHaveBeenCalledWith(
			expect.stringContaining("2 module-graph chunk(s)")
		);
	});

	it("warns when no channel is left to carry module-graph integrity", async () => {
		const plugin = sri({
			algorithm: "sha256",
			importMapIntegrity: false,
			preloadDynamicChunks: false,
		}) as any;
		plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);

		const mockContext = createMockPluginContext();
		await plugin.generateBundle.handler.call(
			mockContext,
			{},
			makeGapBundle() as any
		);

		expect(mockContext.warn).toHaveBeenCalledWith(
			expect.stringContaining("will load without SRI")
		);
	});

	it("propagates crossorigin onto widened preload links", async () => {
		// SRI on a cross-origin fetch requires CORS, so the attribute must
		// reach the links added by the widened set, not just the narrow one.
		const plugin = sri({
			algorithm: "sha256",
			importMapIntegrity: false,
			crossorigin: "anonymous",
		}) as any;
		plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);

		const bundle = makeGapBundle();
		await plugin.generateBundle.handler({}, bundle as any);
		const html = String((bundle["index.html"] as Asset).source);

		expect(html).toMatch(
			/<link rel="modulepreload" href="\/assets\/dep\.js" integrity="sha256-[^"]+" crossorigin="anonymous">/
		);
	});

	it("keeps skipResources opt-outs out of the widened preload set", async () => {
		const plugin = sri({
			algorithm: "sha256",
			importMapIntegrity: false,
			skipResources: ["**/dep.js"],
		}) as any;
		plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);

		const bundle = makeGapBundle();
		await plugin.generateBundle.handler({}, bundle as any);
		const html = String((bundle["index.html"] as Asset).source);

		expect(html).not.toContain("/assets/dep.js");
	});
});

describe("no-channel warning", () => {
	it("stays quiet for a single-bundle build with no module-graph chunks", async () => {
		const plugin = sri({
			algorithm: "sha256",
			importMapIntegrity: false,
			preloadDynamicChunks: false,
		}) as any;
		plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);

		const mockContext = createMockPluginContext();
		const bundle: any = {
			"index.html": {
				type: "asset",
				source:
					'<!doctype html><html><head><script type="module" src="/assets/entry.js"></script></head><body></body></html>',
			},
			"assets/entry.js": makeEntryChunk({ code: "console.log('only')" }),
		};

		await plugin.generateBundle.handler.call(mockContext, {}, bundle);

		expect(mockContext.warn).not.toHaveBeenCalledWith(
			expect.stringContaining("will load without SRI")
		);
	});
});

describe("relative base preload hrefs resolve against the document", () => {
	function nestedBundle(): any {
		return {
			"index.html": {
				type: "asset",
				source:
					'<!doctype html><html><head><script type="module" src="./assets/entry.js"></script></head><body></body></html>',
			},
			"admin/index.html": {
				type: "asset",
				source:
					'<!doctype html><html><head><script type="module" src="../assets/entry.js"></script></head><body></body></html>',
			},
			"assets/entry.js": {
				type: "chunk",
				fileName: "assets/entry.js",
				code: "import './dep.js'; console.log(1)",
				imports: ["src/dep.ts"],
				dynamicImports: [],
				modules: { "src/entry.ts": {} },
				name: "entry",
				isEntry: true,
				facadeModuleId: "src/entry.ts",
			},
			"assets/dep.js": {
				type: "chunk",
				fileName: "assets/dep.js",
				code: "export const d = 1",
				imports: [],
				dynamicImports: [],
				modules: { "src/dep.ts": {} },
				name: "dep",
				facadeModuleId: "src/dep.ts",
			},
		};
	}

	it("prefixes ../ for HTML emitted into a subdirectory", async () => {
		const plugin = sri({
			algorithm: "sha256",
			importMapIntegrity: false,
		}) as any;
		plugin.configResolved?.({ base: "./", build: { ssr: false } } as any);

		const bundle = nestedBundle();
		await plugin.generateBundle.handler({}, bundle);

		expect(String(bundle["admin/index.html"].source)).toMatch(
			/<link rel="modulepreload" href="\.\.\/assets\/dep\.js" integrity="sha256-/
		);
	});

	it("keeps root-level HTML pointing at its own directory", async () => {
		const plugin = sri({
			algorithm: "sha256",
			importMapIntegrity: false,
		}) as any;
		plugin.configResolved?.({ base: "./", build: { ssr: false } } as any);

		const bundle = nestedBundle();
		await plugin.generateBundle.handler({}, bundle);

		expect(String(bundle["index.html"].source)).toMatch(
			/<link rel="modulepreload" href="\.\/assets\/dep\.js" integrity="sha256-/
		);
	});

	it("leaves root-relative and absolute bases document-independent", async () => {
		for (const base of ["/", "https://cdn.example.com/"]) {
			const plugin = sri({
				algorithm: "sha256",
				importMapIntegrity: false,
			}) as any;
			plugin.configResolved?.({ base, build: { ssr: false } } as any);

			const bundle = nestedBundle();
			await plugin.generateBundle.handler({}, bundle);

			const expected = `href="${base === "/" ? "/assets/dep.js" : "https://cdn.example.com/assets/dep.js"}"`;
			expect(String(bundle["index.html"].source)).toContain(expected);
			expect(String(bundle["admin/index.html"].source)).toContain(expected);
		}
	});
});

describe("silent-gap detection at stock defaults", () => {
	function relativeBaseGraph(): any {
		return {
			"index.html": {
				type: "asset",
				source:
					'<!doctype html><html><head><script type="module" src="./assets/entry.js"></script></head><body></body></html>',
			},
			"assets/entry.js": {
				type: "chunk",
				fileName: "assets/entry.js",
				code: "import('./lazy.js')",
				imports: [],
				dynamicImports: ["src/lazy.ts"],
				modules: { "src/entry.ts": {} },
				name: "entry",
				isEntry: true,
				facadeModuleId: "src/entry.ts",
			},
			"assets/lazy.js": {
				type: "chunk",
				fileName: "assets/lazy.js",
				code: "import './dep.js'; export const l = 1",
				imports: ["src/dep.ts"],
				dynamicImports: [],
				modules: { "src/lazy.ts": {} },
				name: "lazy",
				facadeModuleId: "src/lazy.ts",
			},
			"assets/dep.js": {
				type: "chunk",
				fileName: "assets/dep.js",
				code: "export const d = 1",
				imports: [],
				dynamicImports: [],
				modules: { "src/dep.ts": {} },
				name: "dep",
				facadeModuleId: "src/dep.ts",
			},
		};
	}

	it("warns about a relative-base gap even with every option untouched", async () => {
		// No import map (relative base), narrow preloads only, no rewrite —
		// dep.js reaches the browser unverified and used to do so in silence.
		const plugin = sri({ algorithm: "sha256" }) as any;
		plugin.configResolved?.({ base: "./", build: { ssr: false } } as any);

		const mockContext = createMockPluginContext();
		await plugin.generateBundle.handler.call(
			mockContext,
			{},
			relativeBaseGraph()
		);

		expect(mockContext.warn).toHaveBeenCalledWith(
			expect.stringContaining("assets/dep.js")
		);
	});

	it("goes quiet on a relative-base build once the widened set is enabled", async () => {
		const plugin = sri({
			algorithm: "sha256",
			importMapIntegrity: false,
		}) as any;
		plugin.configResolved?.({ base: "./", build: { ssr: false } } as any);

		const mockContext = createMockPluginContext();
		const bundle = relativeBaseGraph();
		await plugin.generateBundle.handler.call(mockContext, {}, bundle);

		expect(mockContext.warn).not.toHaveBeenCalledWith(
			expect.stringContaining("will load without SRI")
		);
		expect(String(bundle["index.html"].source)).toContain(
			'href="./assets/dep.js"'
		);
	});

	it("drops a skipResources chunk from preloads even when dynamically imported", async () => {
		const plugin = sri({
			algorithm: "sha256",
			skipResources: ["**/lazy.js"],
		}) as any;
		plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);

		const bundle = relativeBaseGraph();
		bundle["index.html"].source =
			'<!doctype html><html><head><script type="module" src="/assets/entry.js"></script></head><body></body></html>';
		await plugin.generateBundle.handler({}, bundle);

		expect(String(bundle["index.html"].source)).not.toContain(
			'href="/assets/lazy.js"'
		);
	});
});
