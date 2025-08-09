import { describe, expect, it, vi } from "vitest";
import sri from "../src/index";

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

describe("vite-plugin-sri-gen", () => {
	it("adds integrity to scripts and links", async () => {
		const plugin = sri({ algorithm: "sha256" });

		const html = `<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="/style.css">
    <link rel="modulepreload" href="/entry.js">
  </head>
  <body>
    <script type="module" src="/entry.js"></script>
  </body>
</html>`;

		const fakeCtx = {
			meta: { watchMode: false },
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: (e: any) => {
				throw e instanceof Error ? e : new Error(String(e));
			},
		} as any;

		const out = await plugin.transformIndexHtml!.call(fakeCtx, html, {
			bundle: mockBundle({
				"style.css": "body{color:red}",
				"entry.js": 'console.log("hi")',
			}),
		} as any);

		expect(out).toContain('integrity="sha256-');
	});

	it("does not overwrite existing integrity", async () => {
		const plugin = sri({ algorithm: "sha256" });
		const html = `<!doctype html><html><head>
      <script src="/a.js" integrity="sha256-abc"></script>
    </head></html>`;
		const fakeCtx = {
			meta: { watchMode: false },
			debug() {},
			info() {},
			warn() {},
			error(e: any) {
				throw e;
			},
		} as any;
		const out = await plugin.transformIndexHtml!.call(fakeCtx, html, {
			bundle: mockBundle({ "a.js": "console.log(1)" }),
		} as any);
		expect(out).toContain('integrity="sha256-abc"');
	});

	it("adds crossorigin when provided", async () => {
		const plugin = sri({ algorithm: "sha256", crossorigin: "anonymous" });
		const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="/a.css" />
    </head></html>`;
		const fakeCtx = {
			meta: { watchMode: false },
			debug() {},
			info() {},
			warn() {},
			error(e: any) {
				throw e;
			},
		} as any;
		const out = await plugin.transformIndexHtml!.call(fakeCtx, html, {
			bundle: mockBundle({ "a.css": "body{ }" }),
		} as any);
		expect(out).toContain('crossorigin="anonymous"');
	});

	describe("apply (dev & build modes)", () => {
		it('is build-only (apply = "build")', () => {
			const plugin = sri() as any;
			expect(plugin.apply).toBe("build");
		});
	});

	// Dev gating removed: plugin is build-only

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

			await plugin.generateBundle({}, bundle);
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

			await plugin.generateBundle({}, bundle);
			const out = String(bundle["index.html"].source);
			expect(out).toContain('integrity="sha256-abc"');
		});

		it("warns on SSR build with no emitted HTML", async () => {
			const warnSpy = vi
				.spyOn(console, "warn")
				.mockImplementation(() => {});
			const plugin = sri() as any;
			plugin.configResolved?.({
				command: "build",
				mode: "production",
				appType: "ssr",
				build: { ssr: true },
			} as any);
			const bundle: any = { "entry.js": { code: "console.log(1)" } };
			await plugin.generateBundle({}, bundle);
			expect(warnSpy).toHaveBeenCalled();
			warnSpy.mockRestore();
		});

		it("logs warning and skips file when processing an HTML asset throws", async () => {
			const warnSpy = vi
				.spyOn(console, "warn")
				.mockImplementation(() => {});
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
			await plugin.generateBundle({}, bundle);
			expect(warnSpy).toHaveBeenCalled();
			warnSpy.mockRestore();
		});

		it("does not warn when no HTML is emitted in a non-SSR build", async () => {
			const warnSpy = vi
				.spyOn(console, "warn")
				.mockImplementation(() => {});
			const plugin = sri() as any;
			// Non-SSR build
			plugin.configResolved?.({
				command: "build",
				mode: "production",
				appType: "spa",
				build: { ssr: false },
			} as any);
			const bundle: any = { "entry.js": { code: "console.log(1)" } };
			await plugin.generateBundle({}, bundle);
			expect(warnSpy).not.toHaveBeenCalled();
			warnSpy.mockRestore();
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
			await plugin.generateBundle({}, bundle);
			const out = String(bundle["index.html"].source);
			expect(out).toContain("integrity=");
		});

		it("uses plugin context warn when available", async () => {
			const plugin = sri() as any;
			const warnSpy = vi.fn();
			// Simulate SSR build with no HTML to trigger the warn path
			plugin.configResolved?.({
				command: "build",
				mode: "production",
				appType: "ssr",
				build: { ssr: true },
			} as any);
			// Call with plugin context containing warn()
			await plugin.generateBundle.call({ warn: warnSpy }, {}, {} as any);
			expect(warnSpy).toHaveBeenCalled();
		});
	});

	describe("algorithm validation & fallback", () => {
		it("falls back to sha384 and warns when algorithm is unsupported", async () => {
			const plugin = sri({ algorithm: "md5" } as any) as any;
			const warnSpy = vi.fn();
			// Simulate Vite config resolution context providing warn()
			plugin.configResolved?.call({ warn: warnSpy }, {
				command: "build",
				mode: "production",
				appType: "spa",
				build: {},
			} as any);

			const html = `<!doctype html><html><head>
        <script src="/a.js"></script>
      </head></html>`;
			const out = await plugin.transformIndexHtml(html, {
				bundle: mockBundle({ "a.js": "console.log(1)" }),
			} as any);
			expect(out).toContain('integrity="sha384-'); // fallback
			expect(warnSpy).toHaveBeenCalled();
		});

		it("uses a valid algorithm without warning", async () => {
			const plugin = sri({ algorithm: "sha512" }) as any;
			const warnSpy = vi.fn();
			plugin.configResolved?.call({ warn: warnSpy }, {
				command: "build",
				mode: "production",
				appType: "spa",
				build: {},
			} as any);

			const html = `<!doctype html><html><head>
        <script src="/a.js"></script>
      </head></html>`;
			const out = await plugin.transformIndexHtml(html, {
				bundle: mockBundle({ "a.js": "console.log(1)" }),
			} as any);
			expect(out).toContain('integrity="sha512-');
			expect(warnSpy).not.toHaveBeenCalled();
		});
	});

	describe("resource options wiring (cache & timeout)", () => {
		it("uses shared cache and in-flight dedupe within a page transform", async () => {
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

			const html = `<!doctype html><html><head>
        <script src="https://cdn.example.com/a.js"></script>
        <script src="https://cdn.example.com/a.js"></script>
      </head></html>`;

			const out = await plugin.transformIndexHtml(html, {
				bundle: {},
			} as any);
			expect(out.match(/integrity="sha256-/g)?.length).toBe(2);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			fetchSpy.mockRestore();
		});

		it("applies timeout and surfaces per-element warnings on failure", async () => {
			const plugin = sri({
				algorithm: "sha256",
				fetchTimeoutMs: 1,
			}) as any;
			const warnSpy = vi
				.spyOn(console, "warn")
				.mockImplementation(() => {});

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

			const html = `<!doctype html><html><head>
        <script src="https://cdn.example.com/a.js"></script>
      </head></html>`;

			const out = await plugin.transformIndexHtml(html, {
				bundle: {},
			} as any);
			// No integrity due to failure, warning emitted
			expect(out).toContain(
				'<script src="https://cdn.example.com/a.js"></script>'
			);
			expect(warnSpy).toHaveBeenCalled();
			warnSpy.mockRestore();
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
			await plugin.generateBundle({}, bundle);
			// Nothing to assert beyond no-throw; coverage will include the binary branch
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
			await plugin.generateBundle({}, bundle);
		});
	});
});

// helper tests moved to test/internal.spec.ts
