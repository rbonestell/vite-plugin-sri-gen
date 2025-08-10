import { load as cheerioLoad } from "cheerio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sri from "../src/index";
import {
	addSriToHtml,
	computeIntegrity,
	createLogger,
	DynamicImportAnalyzer,
	getUrlAttrName,
	handleGenerateBundleError,
	HtmlProcessor,
	installSriRuntime,
	IntegrityProcessor,
	isHttpUrl,
	loadResource,
	normalizeBundlePath,
	processElement,
	validateGenerateBundleInputs,
} from "../src/internal";

type BundleEntry = { code?: any; source?: any };
type Bundle = Record<string, BundleEntry>;

function mockBundle(files: Record<string, string | BundleEntry>): Bundle {
	return Object.fromEntries(
		Object.entries(files).map(([k, v]) => [
			k,
			typeof v === "string" ? { code: v } : v,
		])
	) as Bundle;
}

// Mock global fetch for HTTP resource tests
const mockFetch = vi.fn();
Object.defineProperty(globalThis, "fetch", {
	value: mockFetch,
	writable: true,
});

beforeEach(() => {
	mockFetch.mockClear();
});

afterEach(() => {
	vi.resetAllMocks();
});

describe("Internal Utility Functions", () => {
	describe("isHttpUrl", () => {
		it("detects HTTP URLs", () => {
			expect(isHttpUrl("http://example.com/foo")).toBe(true);
			expect(isHttpUrl("https://example.com/foo")).toBe(true);
			expect(isHttpUrl("//example.com/foo")).toBe(true);
			expect(isHttpUrl("/foo")).toBe(false);
			expect(isHttpUrl("foo")).toBe(false);
			expect(isHttpUrl(null)).toBe(false);
			expect(isHttpUrl(123)).toBe(false);
		});
	});

	describe("normalizeBundlePath", () => {
		it("strips leading slashes and protocol-relative prefixes", () => {
			expect(normalizeBundlePath("/foo")).toBe("foo");
			expect(normalizeBundlePath("foo")).toBe("foo");
			expect(normalizeBundlePath("//foo")).toBe("foo");
			expect(normalizeBundlePath(null)).toBe(null);
		});
	});

	describe("computeIntegrity", () => {
		it("computes sha256 integrity", () => {
			const result = computeIntegrity("hello", "sha256");
			expect(result).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
		});

		it("computes sha384 integrity", () => {
			const result = computeIntegrity("hello", "sha384");
			expect(result).toMatch(/^sha384-[A-Za-z0-9+/]+=*$/);
		});

		it("computes sha512 integrity", () => {
			const result = computeIntegrity("hello", "sha512");
			expect(result).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
		});

		it("handles Uint8Array input", () => {
			const bytes = new Uint8Array([104, 101, 108, 108, 111]); // "hello"
			const result = computeIntegrity(bytes, "sha256");
			expect(result).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
		});
	});

	describe("getUrlAttrName", () => {
		it("returns correct attribute names", () => {
			expect(getUrlAttrName({ name: "script" })).toBe("src");
			expect(getUrlAttrName({ name: "SCRIPT" })).toBe("src");
			expect(getUrlAttrName({ name: "link" })).toBe("href");
			expect(getUrlAttrName({ name: "div" })).toBe("href"); // fallback
			expect(getUrlAttrName({})).toBe(null);
			expect(getUrlAttrName(null)).toBe(null);
		});
	});

	describe("loadResource", () => {
		it("loads local bundle resources", async () => {
			const bundle = mockBundle({ "foo.js": "console.log('foo')" });
			const result = await loadResource("foo.js", bundle);
			expect(result).toBe("console.log('foo')");
		});

		it("returns null for missing local resources", async () => {
			const bundle = mockBundle({ "foo.js": "console.log('foo')" });
			const result = await loadResource("missing.js", bundle);
			expect(result).toBeNull();
		});

		it("loads remote HTTP resources", async () => {
			const bytes = new Uint8Array([1, 2, 3]);
			mockFetch.mockResolvedValue({
				ok: true,
				arrayBuffer: () => Promise.resolve(bytes.buffer),
			});

			const result = await loadResource(
				"http://example.com/foo.js",
				undefined
			);
			expect(result).toEqual(bytes);
			expect(mockFetch).toHaveBeenCalledWith(
				"http://example.com/foo.js",
				undefined
			);
		});

		it("handles protocol-relative URLs by assuming https", async () => {
			const bytes = new Uint8Array([1, 2, 3]);
			mockFetch.mockResolvedValue({
				ok: true,
				arrayBuffer: () => Promise.resolve(bytes.buffer),
			});

			await loadResource("//example.com/foo.js", undefined);
			expect(mockFetch).toHaveBeenCalledWith(
				"https://example.com/foo.js",
				undefined
			);
		});

		it("uses cache for repeated requests", async () => {
			const bytes = new Uint8Array([1, 2, 3]);
			mockFetch.mockResolvedValue({
				ok: true,
				arrayBuffer: () => Promise.resolve(bytes.buffer),
			});

			const cache = new Map();
			const opts = { cache, enableCache: true };

			await loadResource("http://example.com/foo.js", undefined, opts);
			await loadResource("http://example.com/foo.js", undefined, opts);

			expect(mockFetch).toHaveBeenCalledTimes(1);
		});

		it("handles fetch timeouts", async () => {
			mockFetch.mockImplementation(() => {
				return new Promise((_, reject) => {
					setTimeout(() => reject(new Error("timeout")), 100);
				});
			});

			await expect(
				loadResource("http://example.com/foo.js", undefined, {
					fetchTimeoutMs: 1,
				})
			).rejects.toThrow();
		});

		it("handles HTTP errors", async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 404,
				statusText: "Not Found",
			});

			await expect(
				loadResource("http://example.com/foo.js", undefined)
			).rejects.toThrow("Failed to fetch");
		});

		it("handles in-flight request deduplication", async () => {
			const bytes = new Uint8Array([1, 2, 3]);
			mockFetch.mockResolvedValue({
				ok: true,
				arrayBuffer: () => Promise.resolve(bytes.buffer),
			});

			const cache = new Map();
			const pending = new Map();
			const opts = { cache, pending, enableCache: true };

			const [result1, result2] = await Promise.all([
				loadResource("http://example.com/foo.js", undefined, opts),
				loadResource("http://example.com/foo.js", undefined, opts),
			]);

			expect(result1).toEqual(bytes);
			expect(result2).toEqual(bytes);
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});
	});

	describe("processElement", () => {
		it("adds integrity to script elements", async () => {
			const $ = cheerioLoad('<script src="/foo.js"></script>');
			const $script = $("script").first();
			const bundle = mockBundle({ "foo.js": "console.log('test')" });

			await processElement($script, bundle, "sha256");

			expect($script.attr("integrity")).toMatch(/^sha256-/);
		});

		it("adds integrity to link elements", async () => {
			const $ = cheerioLoad('<link rel="stylesheet" href="/style.css">');
			const $link = $("link").first();
			const bundle = mockBundle({ "style.css": "body{}" });

			await processElement($link, bundle, "sha256", "anonymous");

			expect($link.attr("integrity")).toMatch(/^sha256-/);
			expect($link.attr("crossorigin")).toBe("anonymous");
		});

		it("skips elements with existing integrity", async () => {
			const $ = cheerioLoad(
				'<script src="/foo.js" integrity="existing"></script>'
			);
			const $script = $("script").first();
			const bundle = mockBundle({ "foo.js": "console.log('test')" });

			await processElement($script, bundle, "sha256");

			expect($script.attr("integrity")).toBe("existing");
		});

		it("handles missing resources gracefully", async () => {
			const $ = cheerioLoad('<script src="/missing.js"></script>');
			const $script = $("script").first();
			const bundle = mockBundle({});

			await processElement($script, bundle, "sha256");

			expect($script.attr("integrity")).toBeUndefined();
		});
	});

	describe("addSriToHtml", () => {
		it("adds integrity to multiple element types", async () => {
			const html = `
				<script src="/script.js"></script>
				<link rel="stylesheet" href="/style.css">
				<link rel="modulepreload" href="/module.js">
			`;
			const bundle = mockBundle({
				"script.js": "console.log('script')",
				"style.css": "body{}",
				"module.js": "export default 42",
			});

			const result = await addSriToHtml(html, bundle, {
				algorithm: "sha256",
			});

			expect(result).toContain('integrity="sha256-');
			expect((result.match(/integrity="sha256-/g) || []).length).toBe(3);
		});

		it("handles processing errors gracefully", async () => {
			const warnSpy = vi
				.spyOn(console, "warn")
				.mockImplementation(() => {});

			const html = '<script src="http://invalid-url"></script>';
			mockFetch.mockRejectedValue(new Error("Network error"));

			const result = await addSriToHtml(
				html,
				{},
				{ algorithm: "sha256" }
			);

			expect(result).toContain('src="http://invalid-url"');
			expect(warnSpy).toHaveBeenCalled();

			warnSpy.mockRestore();
		});

		it("adds crossorigin when specified", async () => {
			const html = '<script src="/script.js"></script>';
			const bundle = mockBundle({ "script.js": "console.log('script')" });

			const result = await addSriToHtml(html, bundle, {
				algorithm: "sha256",
				crossorigin: "anonymous",
			});

			expect(result).toContain('crossorigin="anonymous"');
		});
	});
});

describe("Helper Functions", () => {
	describe("createLogger", () => {
		it("creates logger with plugin context", () => {
			const mockContext = {
				warn: vi.fn(),
				error: vi.fn(),
			};

			const logger = createLogger(mockContext);

			logger.warn("test warning");
			logger.error("test error");

			expect(mockContext.warn).toHaveBeenCalledWith("test warning");
		});

		it("falls back to console when no plugin context", () => {
			const warnSpy = vi
				.spyOn(console, "warn")
				.mockImplementation(() => {});
			const errorSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});

			const logger = createLogger(null);

			logger.warn("test warning");
			logger.error("test error");

			expect(warnSpy).toHaveBeenCalledWith(
				"[vite-plugin-sri-gen] test warning"
			);
			expect(errorSpy).toHaveBeenCalledWith(
				"[vite-plugin-sri-gen] test error"
			);

			warnSpy.mockRestore();
			errorSpy.mockRestore();
		});

		it("logs info only in development", () => {
			const infoSpy = vi
				.spyOn(console, "info")
				.mockImplementation(() => {});
			const originalEnv = process.env.NODE_ENV;

			const logger = createLogger(null);

			// Test in production (default)
			process.env.NODE_ENV = "production";
			logger.info("production info");
			expect(infoSpy).not.toHaveBeenCalled();

			// Test in development
			process.env.NODE_ENV = "development";
			logger.info("development info");
			expect(infoSpy).toHaveBeenCalledWith(
				"[vite-plugin-sri-gen] development info"
			);

			process.env.NODE_ENV = originalEnv;
			infoSpy.mockRestore();
		});
	});

	describe("validateGenerateBundleInputs", () => {
		it("validates bundle structure", () => {
			// Valid bundle
			const validBundle = {
				"index.html": { type: "asset", source: "<html></html>" },
			};
			const result = validateGenerateBundleInputs(
				validBundle as any,
				false
			);
			expect(result.isValid).toBe(true);
			expect(result.shouldWarn).toBe(false);
			expect(result.message).toBeNull();
		});

		it("rejects invalid bundles", () => {
			// Null bundle
			const result1 = validateGenerateBundleInputs(null as any, false);
			expect(result1.isValid).toBe(false);
			expect(result1.shouldWarn).toBe(true);
			expect(result1.message).toContain("Invalid bundle provided");

			// Non-object bundle
			const result2 = validateGenerateBundleInputs(
				"invalid" as any,
				false
			);
			expect(result2.isValid).toBe(false);
			expect(result2.shouldWarn).toBe(true);
			expect(result2.message).toContain("Invalid bundle provided");

			// Empty bundle
			const result3 = validateGenerateBundleInputs({} as any, false);
			expect(result3.isValid).toBe(false);
			expect(result3.shouldWarn).toBe(true);
			expect(result3.message).toContain("Empty bundle detected");
		});

		it("handles SSR-specific validation", () => {
			const noHtmlBundle = {
				"main.js": { type: "chunk", code: "console.log('test')" },
			};

			// SSR mode should warn about no HTML
			const result1 = validateGenerateBundleInputs(
				noHtmlBundle as any,
				true
			);
			expect(result1.isValid).toBe(false);
			expect(result1.shouldWarn).toBe(true);
			expect(result1.message).toContain("SSR build");

			// Non-SSR mode should not warn
			const result2 = validateGenerateBundleInputs(
				noHtmlBundle as any,
				false
			);
			expect(result2.isValid).toBe(false);
			expect(result2.shouldWarn).toBe(false);
		});
	});

	describe("handleGenerateBundleError", () => {
		it("handles different error types with specific advice", () => {
			const logger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			};

			// Test cheerio error
			handleGenerateBundleError(new Error("cheerio load failed"), logger);
			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining("cheerio load failed"),
				expect.any(Error)
			);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("HTML parsing failed")
			);

			// Test fetch error
			handleGenerateBundleError(new Error("fetch timeout"), logger);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("Remote resource fetching failed")
			);

			// Test integrity error
			handleGenerateBundleError(
				new Error("integrity computation failed"),
				logger
			);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("Integrity computation failed")
			);
		});

		it("handles non-Error objects", () => {
			const logger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			};

			handleGenerateBundleError("string error", logger);
			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining("string error"),
				undefined
			);
		});
	});
});

describe("Processing Classes", () => {
	describe("IntegrityProcessor", () => {
		it("processes assets with different types correctly", async () => {
			const plugin = sri({ algorithm: "sha256" }) as any;

			// Mock bundle with various asset types
			const bundle: any = {
				"index.html": {
					type: "asset",
					source: "<!DOCTYPE html><html></html>",
				},
				"style.css": {
					type: "asset",
					fileName: "style.css",
					source: "body{color:red}",
				},
				"chunk.js": {
					type: "chunk",
					fileName: "chunk.js",
					code: "console.log('test')",
				},
				"binary.wasm": {
					type: "asset",
					fileName: "binary.wasm",
					source: new Uint8Array([1, 2, 3, 4]),
				},
				"image.png": {
					type: "asset",
					fileName: "image.png",
					source: Buffer.from("fake-image"),
				},
				"unknown.txt": {
					type: "asset",
					fileName: "unknown.txt",
					source: "text content",
				},
			};

			// Should process without throwing
			await plugin.generateBundle({}, bundle);

			// Check that HTML was processed
			const processedHtml = String(bundle["index.html"].source);
			expect(processedHtml).toBeDefined();
		});

		it("handles empty or null sources gracefully", async () => {
			const plugin = sri({ algorithm: "sha256" }) as any;

			const bundle: any = {
				"index.html": {
					type: "asset",
					source: "<!DOCTYPE html><html></html>",
				},
				"empty.js": { type: "chunk", fileName: "empty.js", code: "" },
				"null-source.css": {
					type: "asset",
					fileName: "null-source.css",
					source: null,
				},
				"undefined-code.js": {
					type: "chunk",
					fileName: "undefined-code.js",
					code: undefined,
				},
			};

			// Should handle gracefully without throwing
			await plugin.generateBundle({}, bundle);
		});

		it("handles integrity computation errors", async () => {
			const errorSpy = vi
				.spyOn(console, "error")
				.mockImplementation(() => {});

			const plugin = sri({ algorithm: "sha256" }) as any;

			const bundle: any = {
				"index.html": {
					type: "asset",
					source: "<!DOCTYPE html><html></html>",
				},
				// Use a corrupted source that might cause computation issues
				"error.js": {
					type: "chunk",
					fileName: "error.js",
					code: "console.log('normal');",
				},
				"normal.css": {
					type: "asset",
					fileName: "normal.css",
					source: "body{}",
				},
			};

			// Should handle any errors gracefully
			await plugin.generateBundle({}, bundle);

			errorSpy.mockRestore();
		});

		it("processes parallel assets correctly", async () => {
			const plugin = sri({ algorithm: "sha256" }) as any;

			// Large bundle to test parallel processing
			const bundle: any = {
				"index.html": {
					type: "asset",
					source: "<!DOCTYPE html><html></html>",
				},
			};

			// Add multiple assets
			for (let i = 0; i < 20; i++) {
				bundle[`asset${i}.js`] = {
					type: "chunk",
					fileName: `asset${i}.js`,
					code: `console.log('asset ${i}');`,
				};
				bundle[`style${i}.css`] = {
					type: "asset",
					fileName: `style${i}.css`,
					source: `.class${i} { color: red; }`,
				};
			}

			await plugin.generateBundle({}, bundle);
		});

		it("builds integrity mappings directly", async () => {
			const mockLogger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			};

			const processor = new IntegrityProcessor("sha256", mockLogger);
			const bundle: any = {
				"test.js": { type: "chunk", code: "console.log('test')" },
				"test.css": { type: "asset", source: "body{}" },
			};

			const result = await processor.buildIntegrityMappings(bundle);

			expect(result).toHaveProperty("/test.js");
			expect(result).toHaveProperty("/test.css");
			expect(result["/test.js"]).toMatch(/^sha256-/);
			expect(result["/test.css"]).toMatch(/^sha256-/);
		});

		it("handles bundle items with missing content", async () => {
			const mockLogger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			};

			const processor = new IntegrityProcessor("sha256", mockLogger);
			const bundle: any = {
				"empty-chunk.js": { type: "chunk", code: null },
				"empty-asset.css": { type: "asset", source: null },
			};

			const result = await processor.buildIntegrityMappings(bundle);

			expect(Object.keys(result)).toHaveLength(0);
			expect(mockLogger.warn).toHaveBeenCalled();
		});

		it("handles unknown bundle item types", async () => {
			const mockLogger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			};

			const processor = new IntegrityProcessor("sha256", mockLogger);
			// Use a non-processable file extension instead of unknown type
			const bundle: any = {
				"unknown.txt": { type: "asset", source: "text content" },
			};

			const result = await processor.buildIntegrityMappings(bundle);

			// Should skip .txt files (not processable extension)
			expect(Object.keys(result)).toHaveLength(0);
		});

		it("handles integrity computation errors gracefully", async () => {
			const mockLogger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			};

			const processor = new IntegrityProcessor("sha256", mockLogger);

			// Create a bundle item that will cause integrity computation to fail
			const problematicItem = {
				type: "chunk",
				fileName: "error.js",
				get code() {
					// Throwing when accessing code property
					throw new Error("Code access failed");
				},
			};

			const bundle: any = {
				"error.js": problematicItem,
			};

			// Should handle the error gracefully and not crash
			const result = await processor.buildIntegrityMappings(bundle);

			// Should result in empty mappings due to error
			expect(Object.keys(result)).toHaveLength(0);
			expect(mockLogger.error).toHaveBeenCalled();
		});
	});

	describe("DynamicImportAnalyzer", () => {
		it("analyzes complex dynamic import relationships", async () => {
			const plugin = sri({
				algorithm: "sha256",
				preloadDynamicChunks: true,
			}) as any;

			const bundle: any = {
				"index.html": {
					type: "asset",
					source: "<!DOCTYPE html><html></html>",
				},
				"entry.js": {
					type: "chunk",
					fileName: "entry.js",
					facadeModuleId: "src/entry.js",
					name: "entry",
					code: "import('./dynamic1.js'); import('./dynamic2.js');",
					modules: { "src/entry.js": {} },
					dynamicImports: ["src/dynamic1.js", "src/dynamic2.js"],
				},
				"dynamic1.js": {
					type: "chunk",
					fileName: "dynamic1.js",
					facadeModuleId: "src/dynamic1.js",
					name: "dynamic1",
					code: "export const a = 1;",
					modules: { "src/dynamic1.js": {} },
					dynamicImports: [],
				},
				"dynamic2.js": {
					type: "chunk",
					fileName: "dynamic2.js",
					facadeModuleId: "src/dynamic2.js",
					name: "dynamic2",
					code: "export const b = 2;",
					modules: { "src/dynamic2.js": {} },
					dynamicImports: [],
				},
			};

			await plugin.generateBundle({}, bundle);

			// Check that HTML includes preload links for dynamic chunks
			const processedHtml = String(bundle["index.html"].source);
			expect(processedHtml).toContain('rel="modulepreload"');
		});

		it("handles missing chunk mappings", async () => {
			const mockLogger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			};

			const analyzer = new DynamicImportAnalyzer(mockLogger);
			const bundle: any = {
				"entry.js": {
					type: "chunk",
					fileName: "entry.js",
					facadeModuleId: "src/entry.js",
					name: "entry",
					code: "import('./missing.js');",
					modules: { "src/entry.js": {} },
					dynamicImports: ["src/missing.js"],
				},
				// Note: missing.js chunk is not present
			};

			const result = analyzer.analyzeDynamicImports(bundle);

			expect(result.size).toBe(0);
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("Could not resolve dynamic import")
			);
		});

		it("resolves dynamic imports by various strategies", async () => {
			const mockLogger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			};

			const analyzer = new DynamicImportAnalyzer(mockLogger);
			const bundle: any = {
				"entry.js": {
					type: "chunk",
					fileName: "entry.js",
					facadeModuleId: "src/entry.js",
					name: "entry",
					dynamicImports: [
						"src/dynamic.js",
						"chunk-by-name",
						"direct-key.js",
					],
					modules: { "src/entry.js": {} },
				},
				// Strategy 1: facade module ID mapping
				"dynamic.js": {
					type: "chunk",
					fileName: "dynamic.js",
					facadeModuleId: "src/dynamic.js",
					name: "dynamic",
					modules: { "src/dynamic.js": {} },
					dynamicImports: [],
				},
				// Strategy 2: chunk name mapping
				"chunk-by-name.js": {
					type: "chunk",
					fileName: "chunk-by-name.js",
					name: "chunk-by-name",
					modules: { "src/chunk.js": {} },
					dynamicImports: [],
				},
				// Strategy 3: direct bundle key
				"direct-key.js": {
					type: "chunk",
					fileName: "direct-key.js",
					name: "direct",
					modules: { "src/direct.js": {} },
					dynamicImports: [],
				},
			};

			const result = analyzer.analyzeDynamicImports(bundle);

			expect(result.size).toBe(3);
			expect(result.has("dynamic.js")).toBe(true);
			expect(result.has("chunk-by-name.js")).toBe(true);
			expect(result.has("direct-key.js")).toBe(true);
		});
		it("covers chunk name matching strategy in resolveDynamicImport", async () => {
			const mockLogger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			};

			const analyzer = new DynamicImportAnalyzer(mockLogger);
			const bundle: any = {
				"entry.js": {
					type: "chunk",
					fileName: "entry.js",
					facadeModuleId: "src/entry.js",
					name: "entry",
					dynamicImports: ["chunk-name-only"], // This will only match by name (lines 1035-1038)
					modules: { "src/entry.js": {} },
				},
				// This chunk has NO facadeModuleId and is NOT a direct bundle key match
				// So it can only be resolved by chunk name matching (Strategy 3)
				"assets/chunk-abc123.js": {
					type: "chunk",
					fileName: "assets/chunk-abc123.js",
					name: "chunk-name-only", // This name will match the dynamic import
					modules: { "src/lazy.js": {} },
					dynamicImports: [],
					// Explicitly no facadeModuleId to force chunk name matching
				},
			};

			const result = analyzer.analyzeDynamicImports(bundle);

			expect(result.size).toBe(1);
			expect(result.has("assets/chunk-abc123.js")).toBe(true);
		});
	});

	describe("HtmlProcessor", () => {
		it("processes HTML files with comprehensive configuration", async () => {
			const mockLogger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			};

			const config = {
				algorithm: "sha256" as const,
				crossorigin: "anonymous" as const,
				base: "/",
				preloadDynamicChunks: true,
				enableCache: true,
				remoteCache: new Map(),
				pending: new Map(),
				fetchTimeoutMs: 5000,
				logger: mockLogger,
			};

			const processor = new HtmlProcessor(config);
			const bundle: any = {
				"index.html": {
					type: "asset",
					source: '<html><head><script src="/test.js"></script></head></html>',
				},
				"test.js": {
					type: "chunk",
					fileName: "test.js",
					code: "console.log('test')",
				},
			};
			const sriByPathname = {}; // Empty - let it compute dynamically
			const dynamicChunkFiles = new Set<string>();

			await processor.processHtmlFiles(
				bundle,
				sriByPathname,
				dynamicChunkFiles
			);

			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("Processing")
			);
			// Check that integrity was added (will be dynamically computed)
			expect(String(bundle["index.html"].source)).toContain(
				'integrity="sha256-'
			);
		});

		it("handles HTML processing errors gracefully", async () => {
			const mockLogger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			};

			const config = {
				algorithm: "sha256" as const,
				base: "/",
				preloadDynamicChunks: false,
				enableCache: false,
				fetchTimeoutMs: 0,
				logger: mockLogger,
			};

			const processor = new HtmlProcessor(config);
			const bundle: any = {
				"broken.html": {
					type: "asset",
					source: {
						toString() {
							throw new Error("HTML processing error");
						},
					},
				},
			};

			await processor.processHtmlFiles(bundle, {}, new Set());

			expect(mockLogger.error).toHaveBeenCalledWith(
				expect.stringContaining("Failed to process HTML file"),
				expect.any(Error)
			);
		});

		it("adds preload links for dynamic chunks", async () => {
			const mockLogger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			};

			const config = {
				algorithm: "sha256" as const,
				crossorigin: "anonymous" as const,
				base: "/assets/",
				preloadDynamicChunks: true,
				enableCache: false,
				fetchTimeoutMs: 0,
				logger: mockLogger,
			};

			const processor = new HtmlProcessor(config);
			const bundle: any = {
				"index.html": {
					type: "asset",
					source: "<html><head></head><body></body></html>",
				},
			};
			const sriByPathname = { "/chunk.js": "sha256-abc123" };
			const dynamicChunkFiles = new Set(["chunk.js"]);

			await processor.processHtmlFiles(
				bundle,
				sriByPathname,
				dynamicChunkFiles
			);

			const html = String(bundle["index.html"].source);
			expect(html).toContain('rel="modulepreload"');
			expect(html).toContain('href="/assets/chunk.js"');
			expect(html).toContain('integrity="sha256-abc123"');
			expect(html).toContain('crossorigin="anonymous"');
		});

		it("skips duplicate preload links", async () => {
			const mockLogger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			};

			const config = {
				algorithm: "sha256" as const,
				base: "/",
				preloadDynamicChunks: true,
				enableCache: false,
				fetchTimeoutMs: 0,
				logger: mockLogger,
			};

			const processor = new HtmlProcessor(config);
			const bundle: any = {
				"index.html": {
					type: "asset",
					source: '<html><head><link rel="modulepreload" href="/chunk.js"></head></html>',
				},
			};
			const sriByPathname = { "/chunk.js": "sha256-abc123" };
			const dynamicChunkFiles = new Set(["chunk.js"]);

			await processor.processHtmlFiles(
				bundle,
				sriByPathname,
				dynamicChunkFiles
			);

			const html = String(bundle["index.html"].source);
			const matches = html.match(/rel="modulepreload"/g) || [];
			expect(matches.length).toBe(1); // Should not duplicate existing link
		});

		it("warns when integrity is missing for dynamic chunks", async () => {
			const mockLogger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			};

			const config = {
				algorithm: "sha256" as const,
				base: "/",
				preloadDynamicChunks: true,
				enableCache: false,
				fetchTimeoutMs: 0,
				logger: mockLogger,
			};

			const processor = new HtmlProcessor(config);
			const bundle: any = {
				"index.html": {
					type: "asset",
					source: "<html><head></head><body></body></html>",
				},
			};
			const sriByPathname = {}; // Missing integrity for chunk.js
			const dynamicChunkFiles = new Set(["chunk.js"]);

			await processor.processHtmlFiles(
				bundle,
				sriByPathname,
				dynamicChunkFiles
			);

			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("No integrity found for dynamic chunk")
			);
		});

		it("handles empty HTML content", async () => {
			const mockLogger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			};

			const config = {
				algorithm: "sha256" as const,
				base: "/",
				preloadDynamicChunks: false,
				enableCache: false,
				fetchTimeoutMs: 0,
				logger: mockLogger,
			};

			const processor = new HtmlProcessor(config);
			const bundle: any = {
				"empty.html": {
					type: "asset",
					source: "",
				},
			};

			await processor.processHtmlFiles(bundle, {}, new Set());

			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("has no source content")
			);
		});
		it("handles empty HTML content with warning", async () => {
			const mockLogger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			};

			const config = {
				algorithm: "sha256" as const,
				base: "/",
				preloadDynamicChunks: false,
				enableCache: false,
				fetchTimeoutMs: 0,
				logger: mockLogger,
			};

			const processor = new HtmlProcessor(config);
			const bundle: any = {
				"empty.html": {
					type: "asset",
					source: "   \n\t  ", // Only whitespace content
				},
			};

			await processor.processHtmlFiles(bundle, {}, new Set());

			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("appears to be empty")
			);
		});
		it("covers no HTML files found warning", async () => {
			const mockLogger = {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			};

			const config = {
				algorithm: "sha256" as const,
				base: "/",
				preloadDynamicChunks: false,
				enableCache: false,
				fetchTimeoutMs: 0,
				logger: mockLogger,
			};

			const processor = new HtmlProcessor(config);

			// Bundle with no HTML files
			const bundle: any = {
				"main.js": {
					type: "chunk",
					fileName: "main.js",
					code: "console.log('test');",
				},
			};

			await processor.processHtmlFiles(bundle, {}, new Set());

			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("No HTML files found in bundle")
			);
		});
	});

	describe("Additional Coverage Tests", () => {
		it("covers URL parsing failure in runtime helpers", () => {
			// Test the internal URL parsing error handling
			const originalLocation = (globalThis as any).location;
			(globalThis as any).location = undefined;

			try {
				const originalElement = (globalThis as any).Element;
				const originalHTMLLinkElement = (globalThis as any)
					.HTMLLinkElement;

				// Create minimal fake DOM
				(globalThis as any).Element = function Element() {};
				(globalThis as any).Element.prototype = {
					setAttribute: function () {},
				};
				(globalThis as any).HTMLLinkElement =
					function HTMLLinkElement() {};
				(globalThis as any).HTMLLinkElement.prototype = Object.create(
					(globalThis as any).Element.prototype
				);

				try {
					// This should not throw even with missing location
					expect(() => {
						const runtime = `(${installSriRuntime.toString()})({}, {})`;
						new Function(runtime)();
					}).not.toThrow();
				} finally {
					(globalThis as any).Element = originalElement;
					(globalThis as any).HTMLLinkElement =
						originalHTMLLinkElement;
				}
			} finally {
				(globalThis as any).location = originalLocation;
			}
		});

		it("covers runtime installation with missing globals", () => {
			// Test complete failure when globals are missing
			const originalNode = (globalThis as any).Node;
			const originalElement = (globalThis as any).Element;
			const originalHTMLLinkElement = (globalThis as any).HTMLLinkElement;
			const originalHTMLScriptElement = (globalThis as any)
				.HTMLScriptElement;

			// Remove all necessary globals
			(globalThis as any).Node = undefined;
			(globalThis as any).Element = undefined;
			(globalThis as any).HTMLLinkElement = undefined;
			(globalThis as any).HTMLScriptElement = undefined;

			try {
				// Top-level error handling should prevent crashes
				expect(() => {
					const runtime = `(${installSriRuntime.toString()})({}, {})`;
					new Function(runtime)();
				}).not.toThrow();
			} finally {
				(globalThis as any).Node = originalNode;
				(globalThis as any).Element = originalElement;
				(globalThis as any).HTMLLinkElement = originalHTMLLinkElement;
				(globalThis as any).HTMLScriptElement =
					originalHTMLScriptElement;
			}
		});
	});
});
