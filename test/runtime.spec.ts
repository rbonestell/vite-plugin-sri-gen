import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sri from "../src/index";
import { installSriRuntime } from "../src/runtime";

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

type Asset = { type: "asset"; source: string };

type Bundle = Record<string, Chunk | Asset>;

function makeBundle(jsFile = "assets/chunk-A.js", code = "export{}"): Bundle {
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

describe("runtime helper behavior", () => {
	let cleanup: () => void;
	beforeEach(() => {
		cleanup = setupFakeDom();
	});
	afterEach(() => {
		cleanup();
	});

	it("sets integrity and crossorigin on link via setAttribute path", async () => {
		const plugin = sri({ crossorigin: "anonymous" }) as any;
		// Build SRI map by running generateBundle on a bundle with one JS asset
		const bundle = makeBundle("assets/chunk-A.js", "console.log('A')");
		await plugin.generateBundle({}, bundle as any);

		const result = plugin.renderChunk("console.log('x')", {
			isEntry: true,
		} as any);
		const injected = (result as any).code as string;

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
		const bundle = makeBundle("assets/chunk-B.js", "console.log('B')");
		await plugin.generateBundle({}, bundle as any);

		const result = plugin.renderChunk("console.log('y')", {
			isEntry: true,
		} as any);
		const injected = (result as any).code as string;
		new Function(injected)();

		const link = new (globalThis as any).HTMLLinkElement();
		link.rel = "modulepreload";
		(link as any).setAttribute("href", "/assets/chunk-B.js");

		expect(link.hasAttribute("integrity")).toBe(true);
		expect(link.hasAttribute("crossorigin")).toBe(false);
	});

	it("sets integrity for scripts via setAttribute path", async () => {
		const plugin = sri() as any;
		const bundle = makeBundle("assets/mod.js", "export{};");
		await plugin.generateBundle({}, bundle as any);
		const result = plugin.renderChunk("console.log('z')", {
			isEntry: true,
		} as any);
		new Function((result as any).code)();

		const script = new (globalThis as any).HTMLScriptElement();
		(script as any).setAttribute("src", "/assets/mod.js");
		expect(script.hasAttribute("integrity")).toBe(true);
	});

	it("sets integrity when nodes are inserted via appendChild/prepend hooks", async () => {
		// Install fake DOM with insert functions to exercise wrapInsert branches
		cleanup();
		cleanup = setupFakeDom(true);

		const plugin = sri({ crossorigin: "anonymous" }) as any;
		const bundle = makeBundle("assets/ins.js", "export{};");
		await plugin.generateBundle({}, bundle as any);
		const result = plugin.renderChunk("console.log('i')", {
			isEntry: true,
		} as any);
		new Function((result as any).code)();

		// Parent Node with appendChild
		const parent: any = Object.create((globalThis as any).Node.prototype);
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

// Unit-focused tests for the runtime helper installed into a minimal fake DOM
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
			(Element as any).prototype.setAttribute.call(el, "href", "/a.js")
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
