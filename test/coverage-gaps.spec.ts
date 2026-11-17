import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import sri from "../src/index";
import {
	addSriToHtml,
	computeIntegrity,
	installSriRuntime,
	loadResource,
} from "../src/internal";
import { createMockBundleLogger, mockBundle } from "./mocks/bundle-logger";

describe("runtime setAttribute stamps integrity before the URL attribute lands", () => {
	const saved: Record<string, unknown> = {};
	const names = [
		"Node",
		"Element",
		"HTMLLinkElement",
		"HTMLScriptElement",
		"location",
	];
	let FakeLink: any;
	let FakeScript: any;

	// The native setAttribute is where a connected element's fetch starts, so
	// the fake records which integrity value was already present at that moment.
	const make = (ctor: any, attrs: Record<string, string> = {}) => {
		const el = Object.create(ctor.prototype);
		el._attrs = { ...attrs };
		el.integrityAtFetch = undefined;
		return el;
	};

	beforeEach(() => {
		for (const n of names) saved[n] = (globalThis as any)[n];
		const FakeNode: any = function () {};
		FakeNode.prototype = { appendChild() {}, insertBefore() {} };
		const FakeElement: any = function () {};
		FakeElement.prototype = {
			append() {},
			prepend() {},
			hasAttribute(name: string) {
				return Object.prototype.hasOwnProperty.call(this._attrs, name);
			},
			getAttribute(name: string) {
				return this._attrs[name] ?? null;
			},
			setAttribute(name: string, value: string) {
				this._attrs[name] = value;
				if (name !== "integrity" && name !== "crossorigin") {
					this.integrityAtFetch = this._attrs.integrity ?? null;
				}
			},
		};
		FakeLink = function () {};
		FakeLink.prototype = Object.create(FakeElement.prototype);
		// The runtime reads the reflected `rel` property, as on a real link.
		Object.defineProperty(FakeLink.prototype, "rel", {
			get() {
				return this._attrs.rel ?? "";
			},
		});
		FakeScript = function () {};
		FakeScript.prototype = Object.create(FakeElement.prototype);
		(globalThis as any).Node = FakeNode;
		(globalThis as any).Element = FakeElement;
		(globalThis as any).HTMLLinkElement = FakeLink;
		(globalThis as any).HTMLScriptElement = FakeScript;
		(globalThis as any).location = { href: "http://localhost/" };
		installSriRuntime(
			{ "/app.js": "sha256-APP", "/a.css": "sha256-CSS", "/cdn/lib.js": "sha256-LIB" },
			{ crossorigin: "anonymous", skipResources: ["/cdn/*"] }
		);
	});

	afterEach(() => {
		for (const n of names) (globalThis as any)[n] = saved[n];
	});

	it("script src", () => {
		const el = make(FakeScript);
		el.setAttribute("src", "/app.js");
		expect(el.integrityAtFetch).toBe("sha256-APP");
		expect(el.getAttribute("crossorigin")).toBe("anonymous");
	});

	it("stylesheet link href", () => {
		const el = make(FakeLink, { rel: "stylesheet" });
		el.setAttribute("href", "/a.css");
		expect(el.integrityAtFetch).toBe("sha256-CSS");
	});

	it("link that becomes eligible when rel is set after href", () => {
		const el = make(FakeLink, { href: "/a.css" });
		el.setAttribute("rel", "stylesheet");
		expect(el.integrityAtFetch).toBe("sha256-CSS");
	});

	it("leaves a URL matching skipResources alone", () => {
		const el = make(FakeScript);
		el.setAttribute("src", "/cdn/lib.js");
		expect(el.hasAttribute("integrity")).toBe(false);
	});

	it("leaves an ineligible link alone", () => {
		const el = make(FakeLink, { rel: "icon" });
		el.setAttribute("href", "/a.css");
		expect(el.hasAttribute("integrity")).toBe(false);
	});
});

describe("public directory files", () => {
	let root: string;
	let publicDir: string;
	const PUB = 'console.log("public file")';

	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "sri-public-"));
		publicDir = path.join(root, "public");
		fs.mkdirSync(path.join(publicDir, "vendor"), { recursive: true });
		fs.writeFileSync(path.join(publicDir, "pub.js"), PUB);
		fs.writeFileSync(path.join(publicDir, "vendor", "my lib.js"), PUB);
		fs.writeFileSync(path.join(publicDir, "..odd.js"), PUB);
		fs.writeFileSync(path.join(root, "secret.js"), "outside");
	});

	afterAll(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	const text = (v: unknown) => Buffer.from(v as Uint8Array).toString();

	it("loads a file that exists only in the public directory", async () => {
		const got = await loadResource("/pub.js", {}, { publicDir });
		expect(text(got)).toBe(PUB);
	});

	it("strips the configured base and ignores query strings", async () => {
		const got = await loadResource("/app/pub.js?v=2", {}, { publicDir, base: "/app/" });
		expect(text(got)).toBe(PUB);
	});

	it("decodes percent-encoded paths", async () => {
		const got = await loadResource("/vendor/my%20lib.js", {}, { publicDir });
		expect(text(got)).toBe(PUB);
	});

	it("never reads outside the public directory", async () => {
		expect(await loadResource("/../secret.js", {}, { publicDir })).toBeNull();
		expect(await loadResource("/%2e%2e/secret.js", {}, { publicDir })).toBeNull();
	});

	it("prefers an exact bundle key over the public directory", async () => {
		const bundle = mockBundle({ "pub.js": "from bundle" });
		expect(await loadResource("/pub.js", bundle, { publicDir })).toBe("from bundle");
	});

	it("prefers the public file over a same-named bundle file elsewhere", async () => {
		const bundle = mockBundle({ "assets/pub.js": "different file" });
		expect(text(await loadResource("/pub.js", bundle, { publicDir }))).toBe(PUB);
	});

	it("reads from disk instead of fetching when base is an absolute URL", async () => {
		const got = await loadResource(
			"https://cdn.example.com/x/pub.js",
			{},
			{ publicDir, base: "https://cdn.example.com/x/" }
		);
		expect(text(got)).toBe(PUB);
	});

	it("resolves a relative URL against the HTML file's directory", async () => {
		const got = await loadResource(
			"../pub.js",
			{},
			{ publicDir, base: "./", htmlDir: "nested" }
		);
		expect(text(got)).toBe(PUB);
	});

	it("loads a file whose name merely starts with two dots", async () => {
		const got = await loadResource("/..odd.js", {}, { publicDir });
		expect(text(got)).toBe(PUB);
	});

	it("reaches the HTML pass from the plugin's resolved config", async () => {
		const plugin = sri() as any;
		plugin.configResolved?.({ base: "/", publicDir, build: {} } as any);
		const bundle: any = {
			"index.html": {
				type: "asset",
				source: '<html><head><script src="/pub.js"></script></head><body></body></html>',
			},
		};
		await plugin.generateBundle.handler({}, bundle);
		expect(String(bundle["index.html"].source)).toContain(
			`integrity="${computeIntegrity(PUB, "sha384")}"`
		);
	});

	it("warns once per URL and never for data: URLs", async () => {
		const logger = createMockBundleLogger();
		const warned = new Set<string>();
		const html =
			'<html><head><script src="/nowhere.js"></script><script src="data:text/javascript,1"></script></head><body></body></html>';
		await addSriToHtml(html, {}, logger, { resourceOpts: { publicDir, warned } });
		await addSriToHtml(html, {}, logger, { resourceOpts: { publicDir, warned } });
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});

	it("adds integrity to a tag that references a public file", async () => {
		const logger = createMockBundleLogger();
		const html = await addSriToHtml(
			'<html><head><script src="/pub.js"></script></head><body></body></html>',
			{},
			logger,
			{ resourceOpts: { publicDir } }
		);
		expect(html).toContain(`integrity="${computeIntegrity(PUB, "sha384")}"`);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("warns by name when a local file cannot be found anywhere", async () => {
		const logger = createMockBundleLogger();
		const html = await addSriToHtml(
			'<html><head><script src="/nowhere.js"></script></head><body></body></html>',
			{},
			logger,
			{ resourceOpts: { publicDir } }
		);
		expect(html).not.toContain("integrity");
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("/nowhere.js")
		);
	});
});
