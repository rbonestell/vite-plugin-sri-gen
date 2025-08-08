import type { IndexHtmlTransformContext, Plugin } from "vite";

export interface SriPluginOptions {
	/**
	 * The hashing algorithm to use for generating SRI hashes.
	 */
	algorithm?: "sha256" | "sha384" | "sha512";

	/**
	 * The CORS setting to use for fetched scripts and styles.
	 */
	crossorigin?: "anonymous" | "use-credentials";

	/**
	 * Enable in-memory caching for remote fetches. Default: true
	 */
	fetchCache?: boolean;

	/**
	 * Abort remote fetches after the given milliseconds. Default: 5000 (5 seconds).
	 * When > 0, a timeout is applied; if not provided but enabled elsewhere, use 15000ms.
	 */
	fetchTimeoutMs?: number;
}

/**
 * Create a Vite plugin for adding SRI attributes to appropriate elements.
 * @param options SRI plugin options.
 */
export default function sri(options?: SriPluginOptions): Plugin & {
	transformIndexHtml(
		html: string,
		context: IndexHtmlTransformContext
	): Promise<string>;
};
