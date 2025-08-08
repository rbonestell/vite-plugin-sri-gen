import { load as cheerioLoad } from "cheerio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	addSriToHtml,
	computeIntegrity,
	getUrlAttrName,
	isHttpUrl,
	loadResource,
	normalizeBundlePath,
	processElement,
} from "../src/internal";
// Use TS source import path (extensionless)
// @ts-ignore - resolved by TS during tests
export { };

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

describe("helpers", () => {
	describe("isHttpUrl", () => {
		it("detects http/https and protocol-relative", () => {
			expect(isHttpUrl("http://x")).toBe(true);
			expect(isHttpUrl("https://x")).toBe(true);
			expect(isHttpUrl("//cdn.example.com/x.js")).toBe(true);
			expect(isHttpUrl("/x.js")).toBe(false);
			expect(isHttpUrl("x.js")).toBe(false);
			expect(isHttpUrl("ftp://x")).toBe(false);
			expect(isHttpUrl(undefined as any)).toBe(false);
		});
	});

	describe("normalizeBundlePath", () => {
		it("strips leading slash", () => {
			expect(normalizeBundlePath("/a/b")).toBe("a/b");
			expect(normalizeBundlePath("a/b")).toBe("a/b");
			expect(normalizeBundlePath(123 as any)).toBe(123 as any);
		});

		it("strips protocol-relative prefix", () => {
			expect(normalizeBundlePath("//cdn.example.com/x.js")).toBe(
				"cdn.example.com/x.js"
			);
		});
	});

	describe("computeIntegrity", () => {
		it("hashes strings and Uint8Array consistently", () => {
			const s = "hello world";
			const i1 = computeIntegrity(s, "sha256");
			const i2 = computeIntegrity(new TextEncoder().encode(s), "sha256");
			expect(i1).toEqual(i2);
			expect(i1.startsWith("sha256-")).toBe(true);
		});
	});

	describe("getUrlAttrName", () => {
		it("returns src for script and href otherwise", () => {
			const $s = cheerioLoad('<script src="/a.js"></script>')("script").get(0);
			const $l = cheerioLoad('<link rel="stylesheet" href="/a.css">')(
				"link"
			).get(0);
			expect(getUrlAttrName($s)).toBe("src");
			expect(getUrlAttrName($l)).toBe("href");
		});

		it("returns null for invalid element", () => {
			expect(getUrlAttrName(undefined as any)).toBeNull();
			// Element without name
			const node: any = { name: undefined };
			expect(getUrlAttrName(node)).toBeNull();
		});
	});

	describe("loadResource", () => {
		const realFetch = globalThis.fetch;
		afterEach(() => {
			globalThis.fetch = realFetch as any;
			vi.restoreAllMocks();
		});

		it("loads from bundle when not http", async () => {
			const bundle = mockBundle({ "a.js": "1+1" });
			const res = await loadResource("/a.js", bundle);
			expect(res).toBe("1+1");
		});

		it("fetches remote when http and returns bytes", async () => {
			const bytes = new Uint8Array([1, 2, 3]);
			globalThis.fetch = vi
				.fn()
				.mockResolvedValue({
					ok: true,
					arrayBuffer: () => Promise.resolve(bytes.buffer),
				}) as any;
			const res = await loadResource(
				"https://example.com/x.js",
				{},
				{ enableCache: false }
			);
			expect(res).toBeInstanceOf(Uint8Array);
			expect(Array.from(res as Uint8Array)).toEqual([1, 2, 3]);
			expect(globalThis.fetch).toHaveBeenCalled();
		});

		it("throws on failed fetch", async () => {
			globalThis.fetch = vi
				.fn()
				.mockResolvedValue({
					ok: false,
					status: 404,
					statusText: "Not Found",
				}) as any;
			await expect(
				loadResource("https://example.com/404.js", {})
			).rejects.toThrow("Failed to fetch");
		});

		it("supports protocol-relative URLs via https", async () => {
			const bytes = new Uint8Array([9, 8, 7]);
			const fetchSpy = vi
				.fn()
				.mockResolvedValue({
					ok: true,
					arrayBuffer: () => Promise.resolve(bytes.buffer),
				});
			globalThis.fetch = fetchSpy as any;
			const res = await loadResource(
				"//cdn.example.com/lib.js",
				{},
				{ enableCache: false }
			);
			expect(res).toBeInstanceOf(Uint8Array);
			expect(fetchSpy.mock.calls[0][0]).toBe("https://cdn.example.com/lib.js");
		});

		it("caches remote fetches when enabled", async () => {
			const bytes = new Uint8Array([5, 4, 3]);
			const fetchSpy = vi
				.fn()
				.mockResolvedValue({
					ok: true,
					arrayBuffer: () => Promise.resolve(bytes.buffer),
				});
			globalThis.fetch = fetchSpy as any;
			const cache = new Map<string, Uint8Array>();
			const url = "https://example.com/once.js";
			const a = await loadResource(url, {}, { cache, enableCache: true });
			const b = await loadResource(url, {}, { cache, enableCache: true });
			expect(a).toBeInstanceOf(Uint8Array);
			expect(b).toBe(a);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		});

		it("applies fetch timeout when configured", async () => {
			// Simulate a hanging fetch that never resolves; AbortController will abort
			let _abortHandler: () => void;
			const controller = new AbortController();
			const _signal = controller.signal;
			const fetchSpy = vi.fn().mockImplementation((_url, init: any) => {
				// When our internal AbortController aborts, fetch should reject
				const p = new Promise((_resolve, reject) => {
					if (init?.signal) {
						init.signal.addEventListener("abort", () =>
							reject(new Error("aborted"))
						);
					}
				});
				return p;
			});
			globalThis.fetch = fetchSpy as any;
			await expect(
				loadResource(
					"https://example.com/slow.js",
					{},
					{ enableCache: false, fetchTimeoutMs: 1 }
				)
			).rejects.toThrow();
		});

		it("returns null when bundle is missing for local paths", async () => {
			const res = await loadResource("/a.js", undefined as any);
			expect(res).toBeNull();
		});

		it('returns null when relPath is empty (e.g., "/")', async () => {
			const res = await loadResource("/", {});
			expect(res).toBeNull();
		});

		it("prefers source over code when code is missing", async () => {
			const bundle = mockBundle({ "a.js": { source: "console.log(42)" } });
			const res = await loadResource("/a.js", bundle);
			expect(res).toBe("console.log(42)");
		});
	});

	describe("processElement", () => {
		let $: ReturnType<typeof cheerioLoad>;
		beforeEach(() => {
			$ = cheerioLoad(
				'<html><head><script src="/a.js"></script><link rel="stylesheet" href="/a.css"></head></html>'
			);
		});

		it("adds integrity and crossorigin", async () => {
			const $script = $("script");
			await processElement(
				$script,
				mockBundle({ "a.js": "console.log(1)" }),
				"sha256",
				"anonymous"
			);
			expect($script.attr("integrity")).toMatch(/^sha256-/);
			expect($script.attr("crossorigin")).toBe("anonymous");
		});

		it("skips when already has integrity", async () => {
			const $script = $("script");
			$script.attr("integrity", "sha256-abc");
			await processElement($script, mockBundle({ "a.js": "x" }), "sha256");
			expect($script.attr("integrity")).toBe("sha256-abc");
		});

		it("skips when source missing", async () => {
			const $link = $("link");
			await processElement($link, mockBundle({}), "sha256");
			expect($link.attr("integrity")).toBeUndefined();
		});

		it("skips when element wrapper is invalid", async () => {
			const fakeWrapper: any = { get: () => undefined, attr: () => {} };
			await processElement(fakeWrapper, mockBundle({ "a.js": "x" }), "sha256");
		});

		it("skips when URL attribute missing", async () => {
			const $noHref = cheerioLoad('<link rel="stylesheet"></link>')("link");
			await processElement($noHref, mockBundle({ "a.css": "x" }), "sha256");
			expect($noHref.attr("integrity")).toBeUndefined();
		});
	});

	describe("addSriToHtml", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		afterEach(() => warnSpy.mockReset());

		it("adds integrity to multiple element types", async () => {
			const html = `<!doctype html><html><head>
				<link rel="stylesheet" href="/style.css">
				<link rel="modulepreload" href="/entry.js">
			</head><body>
				<script src="/entry.js"></script>
			</body></html>`;
			const out = await addSriToHtml(
				html,
				mockBundle({ "style.css": "body{}", "entry.js": "x" }),
				{ algorithm: "sha384" }
			);
			expect(out).toContain('integrity="sha384-');
		});

		it("skips missing bundle resources without warning", async () => {
			const html = `<html><head><script src="/missing.js"></script></head></html>`;
			const out = await addSriToHtml(html, mockBundle({}), {
				algorithm: "sha256",
			});
			expect(out).toContain('<script src="/missing.js"></script>');
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it("respects crossorigin option", async () => {
			const html = `<html><head><script src="/a.js"></script></head></html>`;
			const out = await addSriToHtml(html, mockBundle({ "a.js": "x" }), {
				algorithm: "sha256",
				crossorigin: "anonymous",
			} as any);
			expect(out).toContain('crossorigin="anonymous"');
		});

		it("resolves bundle items via endsWith match", async () => {
			const html = `<html><head><script src="/nested/path/app.js"></script></head></html>`;
			const bundle = mockBundle({
				"dist/assets/nested/path/app.js": "console.log(1)",
			});
			const out = await addSriToHtml(html, bundle, { algorithm: "sha256" });
			expect(out).toContain('integrity="sha256-');
		});

		it("resolves bundle items via basename fallback", async () => {
			const html = `<html><head><script src="/assets/app.js"></script></head></html>`;
			const bundle = mockBundle({ "dist/app.js": "console.log(2)" });
			const out = await addSriToHtml(html, bundle, { algorithm: "sha256" });
			expect(out).toContain('integrity="sha256-');
		});

		it("warns per element when processing fails", async () => {
			const realFetch = globalThis.fetch;
			const warnLocal = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				globalThis.fetch = vi
					.fn()
					.mockResolvedValue({
						ok: false,
						status: 500,
						statusText: "ERR",
					}) as any;
				const html = `<html><head><script src=\"//cdn.example.com/a.js\"></script></head></html>`;
				const out = await addSriToHtml(html, mockBundle({}), {
					algorithm: "sha256",
				});
				expect(out).toContain('<script src="//cdn.example.com/a.js"></script>');
				expect(warnLocal).toHaveBeenCalled();
			} finally {
				globalThis.fetch = realFetch as any;
				warnLocal.mockRestore();
			}
		});
	});
});
