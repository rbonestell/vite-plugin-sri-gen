import { describe, expect, it } from "vitest";
import sri from "../src/index";

// Minimal Rollup-like OutputChunk/Asset shapes for our tests

type Chunk = {
	type: "chunk";
	fileName: string;
	isEntry?: boolean;
	code: string;
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

type Bundle = Record<string, Chunk | Asset>;

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

function htmlDoc(body: string): string {
	return `<!doctype html><html><head></head><body>${body}</body></html>`;
}

describe("dynamic chunks & runtime", () => {
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
		const bundle: Bundle = {
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

		await plugin.generateBundle({}, bundle as any);
		const out = String((bundle["index.html"] as Asset).source);

		// Should inject rel=modulepreload with base-prefixed href, integrity and crossorigin
		expect(out).toMatch(
			/<link rel="modulepreload" href="\/base\/assets\/chunk-A\.js" integrity="sha256-[^"]+" crossorigin="anonymous">/
		);
	});

	it("does not duplicate existing modulepreload links", async () => {
		const plugin = sri({ algorithm: "sha256" }) as any;
		plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);

		const existing = '<link rel="modulepreload" href="/assets/chunk-A.js">';
		const html = `<!doctype html><html><head>${existing}</head><body></body></html>`;

		const bundle: Bundle = {
			"index.html": { type: "asset", source: html },
			"assets/entry.js": makeEntryChunk({
				dynamicImports: ["src/chunkA.ts"],
			}),
			"assets/chunk-A.js": makeDynChunk(
				"assets/chunk-A.js",
				"src/chunkA.ts"
			),
		} as any;

		await plugin.generateBundle({}, bundle as any);
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
		plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);

		const html = htmlDoc(
			'<script type="module" src="/assets/entry.js"></script>'
		);
		const bundle: Bundle = {
			"index.html": { type: "asset", source: html },
			"assets/entry.js": makeEntryChunk({
				dynamicImports: ["src/chunkA.ts"],
			}),
			"assets/chunk-A.js": makeDynChunk(
				"assets/chunk-A.js",
				"src/chunkA.ts"
			),
		} as any;

		await plugin.generateBundle({}, bundle as any);
		const out = String((bundle["index.html"] as Asset).source);

		expect(out).not.toContain(
			'rel="modulepreload" href="/assets/chunk-A.js"'
		);
	});

	it("injects runtime into entry chunks when enabled", () => {
		const plugin = sri({ crossorigin: "anonymous" }) as any;
		// Simulate renderChunk on an entry
		const result = plugin.renderChunk("console.log('x')", {
			isEntry: true,
		} as any);
		expect(result && typeof result.code === "string").toBe(true);
		const code = (result as any).code as string;
		expect(code).toContain("function installSriRuntime");
		expect(code).toContain("crossorigin");
	});

	it("does not inject runtime when disabled", () => {
		const plugin = sri({ runtimePatchDynamicLinks: false }) as any;
		const result = plugin.renderChunk("console.log('x')", {
			isEntry: true,
		} as any);
		expect(result).toBeNull();
	});

	it("renderChunk returns null for non-entry chunks", () => {
		const plugin = sri() as any;
		const result = plugin.renderChunk("console.log('no entry')", {
			isEntry: false,
		} as any);
		expect(result).toBeNull();
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

		const bundle: Bundle = {
			"index.html": { type: "asset", source: html },
			[entry.fileName]: entry,
			[dyn.fileName]: dyn,
		} as any;

		await plugin.generateBundle({}, bundle as any);
		const out = String((bundle["index.html"] as Asset).source);
		expect(out).toMatch(
			/<link rel="modulepreload" href="\/base\/assets\/chunk-by-name\.js" integrity="sha256-/
		);
	});

	it("injects modulepreload without crossorigin when option not set", async () => {
		const plugin = sri({ algorithm: "sha256" }) as any;
		plugin.configResolved?.({ base: "/", build: { ssr: false } } as any);
		const html = htmlDoc(
			'<script type="module" src="/assets/entry.js"></script>'
		);
		const bundle: Bundle = {
			"index.html": { type: "asset", source: html },
			"assets/entry.js": makeEntryChunk({
				dynamicImports: ["src/chunkA.ts"],
			}),
			"assets/chunk-A.js": makeDynChunk(
				"assets/chunk-A.js",
				"src/chunkA.ts"
			),
		} as any;
		await plugin.generateBundle({}, bundle as any);
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
		const bundle: Bundle = {
			"index.html": { type: "asset", source: html },
			[entry.fileName]: entry,
			[dyn.fileName]: dyn,
		} as any;
		await plugin.generateBundle({}, bundle as any);
		const out = String((bundle["index.html"] as Asset).source);
		expect(out).toMatch(
			/<link rel="modulepreload" href="\/base\/assets\/chunk-by-name\.js" integrity="sha256-/
		);
	});
});
