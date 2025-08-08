import { load } from "cheerio";
import { createHash } from "node:crypto";

export function isHttpUrl(url) {
	return typeof url === "string" && /^(https?:)?\/\//i.test(url);
}

export function normalizeBundlePath(p) {
	if (typeof p !== "string") return p;
	// Remove any protocol-relative prefix that might slip through
	if (p.startsWith("//")) return p.slice(2);
	// Strip leading slash (Vite bundle keys are relative)
	if (p.startsWith("/")) return p.slice(1);
	return p;
}

function findBundleItem(bundle, relPath) {
	if (!bundle) return null;
	const keys = Object.keys(bundle);
	// Exact match
	if (bundle[relPath]) return bundle[relPath];

	// If the HTML path contains a base prefix or extra leading segments,
	// try to find a key that ends with the relative path.
	let match = keys.find((k) => k === relPath || k.endsWith("/" + relPath));
	if (match) return bundle[match];

	// Fallback to basename match as a last resort
	const last = relPath.split("/").pop();
	if (!last) return null;
	match = keys.find((k) => k === last || k.endsWith("/" + last));
	return match ? bundle[match] : null;
}

/**
 * @param {string} resourcePath
 * @param {Record<string, any>} bundle
 * @param {{ cache?: Map<string, Uint8Array>, enableCache?: boolean, fetchTimeoutMs?: number }} [opts]
 */
export async function loadResource(resourcePath, bundle, opts) {
	if (!resourcePath) return null;
	const enableCache = opts?.enableCache !== false; // default true
	const cache = opts?.cache;
	const fetchTimeoutMs = opts?.fetchTimeoutMs ?? 0; // 0 = disabled
	const pending = opts?.pending; // Map<string, Promise<Uint8Array>> for in-flight dedupe

	// Remote resource handling (supports protocol-relative URLs by assuming https)
	if (isHttpUrl(resourcePath)) {
		const url = resourcePath.startsWith("//") ? `https:${resourcePath}` : resourcePath;
		if (enableCache && cache && cache.has(url)) {
			return cache.get(url);
		}
		let controller;
		let signal;
		let timeoutId;
		if (fetchTimeoutMs && fetchTimeoutMs > 0 && typeof AbortController !== "undefined") {
			controller = new AbortController();
			signal = controller.signal;
			timeoutId = setTimeout(() => controller.abort(), fetchTimeoutMs);
		}
		const doFetch = async () => {
			let res;
			try {
				res = await fetch(url, signal ? { signal } : undefined);
			} finally {
				if (timeoutId) clearTimeout(timeoutId);
			}
			if (!res.ok) {
				throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
			}
			return new Uint8Array(await res.arrayBuffer());
		};

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

		const bytes = await doFetch();
		if (enableCache && cache) cache.set(url, bytes);
		return bytes;
	}

	// Local bundle lookup
	if (!bundle) return null;
	const relPath = normalizeBundlePath(resourcePath);
	const bundleItem = findBundleItem(bundle, relPath);
	if (!bundleItem) return null;
	return bundleItem.code ?? bundleItem.source ?? null;
}

export function computeIntegrity(source, algorithm) {
	const buf = typeof source === "string" ? Buffer.from(source) : Buffer.from(source);
	const digest = createHash(algorithm).update(buf).digest("base64");
	return `${algorithm}-${digest}`;
}

export function getUrlAttrName(el) {
	if (!el || !el.name) return null;
	return el.name.toLowerCase() === "script" ? "src" : "href";
}

export async function processElement($el, bundle, algorithm, crossorigin, resourceOpts) {
	const el = $el.get(0);
	if (!el || !el.attribs) return;
	if (el.attribs.integrity) return;

	const attrName = getUrlAttrName(el);
	if (!attrName) return;
	const resourcePath = el.attribs[attrName];
	if (!resourcePath) return;

	const source = await loadResource(resourcePath, bundle, resourceOpts);
	if (!source) return;

	const integrity = computeIntegrity(source, algorithm);
	$el.attr("integrity", integrity);
	if (crossorigin) $el.attr("crossorigin", crossorigin);
}

export async function addSriToHtml(
	html,
	bundle,
	{ algorithm = "sha384", crossorigin, resourceOpts } = {}
) {
	const $ = load(html);
	const $elements = $(
		'script[src], link[rel="stylesheet"][href], link[rel="modulepreload"][href]'
	);

	await Promise.all(
		$elements
			.toArray()
			.map((node) => $(node))
			.map(($node) =>
				processElement($node, bundle, algorithm, crossorigin, resourceOpts).catch((err) => {
					const src = $node.attr("src") || $node.attr("href");
					console.warn(
						`[vite-plugin-sri-gen] Failed to compute integrity for ${src}:`,
						err?.message || err
					);
				})
			)
	);
	let htmlRes = $.html();
	return htmlRes;
}
