// Runtime helper injected into entry chunks
export function installSriRuntime(
	sriByPathname: Record<string, string>,
	opts?: { crossorigin?: false | "anonymous" | "use-credentials" }
) {
	try {
		const map = new Map<string, string>(
			Object.entries(sriByPathname || {})
		);
		const cors =
			opts && Object.prototype.hasOwnProperty.call(opts, "crossorigin")
				? (opts as any).crossorigin
				: "anonymous";

		const getIntegrityForUrl = (
			url: string | null | undefined
		): string | undefined => {
			if (!url) return undefined;
			let value: string | undefined;
			try {
				const u = new URL(
					url,
					(globalThis as any).location?.href || ""
				);
				value = map.get(u.pathname);
			} catch {}
			return value;
		};

		const maybeSetIntegrity = (el: any) => {
			if (!el) return;
			const isLink =
				typeof HTMLLinkElement !== "undefined" &&
				el instanceof HTMLLinkElement;
			const isScript =
				typeof HTMLScriptElement !== "undefined" &&
				el instanceof HTMLScriptElement;
			if (!isLink && !isScript) return;

			let url: string | null = null;
			if (isLink) {
				const rel = (el.rel || "").toLowerCase();
				const as = (
					(el.getAttribute && el.getAttribute("as")) ||
					""
				).toLowerCase();
				const eligible =
					rel === "stylesheet" ||
					rel === "modulepreload" ||
					(rel === "preload" &&
						(as === "script" || as === "style" || as === "font"));
				if (!eligible) return;
				url = el.getAttribute && el.getAttribute("href");
			} else if (isScript) {
				url = el.getAttribute && el.getAttribute("src");
			}
			if (!url) return;

			const integrity = getIntegrityForUrl(url);
			if (!integrity) return;
			if (!el.hasAttribute || !el.setAttribute) return;
			if (!el.hasAttribute("integrity"))
				el.setAttribute("integrity", integrity);
			if (cors && !el.hasAttribute("crossorigin"))
				el.setAttribute("crossorigin", cors);
		};

		// Patch relevant setters
		const origSetAttribute = (Element as any)?.prototype?.setAttribute;
		if (origSetAttribute) {
			(Element as any).prototype.setAttribute = function (
				name: string,
				_value: string
			) {
				const r = origSetAttribute.apply(this, arguments as any);
				try {
					const n = String(name || "").toLowerCase();
					if (
						(this instanceof (globalThis as any).HTMLLinkElement &&
							(n === "href" || n === "rel" || n === "as")) ||
						(this instanceof
							(globalThis as any).HTMLScriptElement &&
							n === "src")
					) {
						maybeSetIntegrity(this);
					}
				} catch {}
				return r;
			};
		}

		const wrapInsert = (proto: any, key: string) => {
			const orig = proto && proto[key];
			if (!orig || typeof orig !== "function") return;
			const wrapped = function (this: any) {
				try {
					const node = arguments[0];
					if (node) maybeSetIntegrity(node);
				} catch {}
				return orig.apply(this, arguments as any);
			};
			try {
				Object.defineProperty(proto, key, {
					value: wrapped,
					configurable: true,
					writable: true,
				});
			} catch {
				try {
					proto[key] = wrapped;
				} catch {}
			}
		};

		wrapInsert((Node as any).prototype, "appendChild");
		wrapInsert((Node as any).prototype, "insertBefore");
		wrapInsert((Element as any).prototype, "append");
		wrapInsert((Element as any).prototype, "prepend");
	} catch {}
}
