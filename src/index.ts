import type { IndexHtmlTransformContext, Plugin } from "vite";
import { addSriToHtml, type LoadResourceOptions } from "./internal";

export interface SriPluginOptions {
  /** The hashing algorithm to use for generating SRI hashes. */
  algorithm?: "sha256" | "sha384" | "sha512";
  /** The CORS setting to use for fetched scripts and styles. */
  crossorigin?: "anonymous" | "use-credentials";
  /** Enable in-memory caching for remote fetches. Default: true */
  fetchCache?: boolean;
  /** Abort remote fetches after the given milliseconds. Default: 5000 (0 disables). */
  fetchTimeoutMs?: number;
}

// Vite plugin to add Subresource Integrity (SRI) attributes to external assets in index.html
// ESM-only, requires Node 18+ (uses global fetch)
export default function sri(options: SriPluginOptions = {}): Plugin & {
  transformIndexHtml(
    html: string,
    context: IndexHtmlTransformContext
  ): Promise<string>;
} {
  let algorithm: "sha256" | "sha384" | "sha512" = options.algorithm ?? "sha384";
  const crossorigin = options.crossorigin;
  const enableCache = options.fetchCache !== false; // default true
  const fetchTimeoutMs = options.fetchTimeoutMs ?? 5000; // 0 = disabled
  const remoteCache = enableCache ? new Map<string, Uint8Array>() : undefined;
  const pending = enableCache ? new Map<string, Promise<Uint8Array>>() : undefined;
  let isSSR = false;

  return {
    name: "vite-plugin-sri-gen",
    enforce: "post",
    // Only run during `vite build`
    apply: "build",
  configResolved(config: import('vite').ResolvedConfig) {
      // Fallback SSR detection from resolved config (may be a string or boolean)
      isSSR = isSSR || !!config.build?.ssr;

      // Validate algorithm at runtime and fallback safely
      if (algorithm !== "sha256" && algorithm !== "sha384" && algorithm !== "sha512") {
  // use vite logger if available
  const warn: (msg: string) => void = (this && (this as any).warn?.bind(this)) ?? console.warn;
        warn(
          `[vite-plugin-sri-gen] Unsupported algorithm "${String(
            algorithm
          )}". Falling back to "sha384". Supported: sha256 | sha384 | sha512.`
        );
        algorithm = "sha384";
      }
    },

  async transformIndexHtml(html: string, context: IndexHtmlTransformContext) {
      const resourceOpts: LoadResourceOptions = { cache: remoteCache, pending, enableCache, fetchTimeoutMs };
      return addSriToHtml(html, context?.bundle as any, {
        algorithm,
        crossorigin,
        resourceOpts,
      });
    },

    async generateBundle(_options: unknown, bundle: import('rollup').OutputBundle) {
      // Use Vite/Rollup logger when available, fallback to console.warn otherwise
      const warn: (msg: string) => void = this && typeof (this as any).warn === "function" ? (this as any).warn.bind(this) : console.warn;
      // Add SRI to any emitted HTML files (useful for MPA and SSR prerendered outputs)
      // This runs for both client and SSR builds; we only modify .html assets if present.
      const htmlFiles = Object.entries(bundle).filter(([fileName, out]) => {
        return fileName.toLowerCase().endsWith(".html") && out && (out as any).type === "asset";
      });
      if (htmlFiles.length === 0) {
        if (isSSR) {
          warn(
            "[vite-plugin-sri-gen] No emitted HTML detected during SSR build. SRI can only be added to HTML files; pure SSR server output will be skipped."
          );
        }
        return;
      }
      for (const [fileName, asset] of htmlFiles as any) {
        try {
          const html = typeof (asset as any).source === "string" ? (asset as any).source : String((asset as any).source || "");
          const updated = await addSriToHtml(html, bundle as any, {
            algorithm,
            crossorigin,
            resourceOpts: { cache: remoteCache, pending, enableCache, fetchTimeoutMs },
          });
          (asset as any).source = updated;
        } catch (err: any) {
          // Non-fatal: skip file on error
          warn(`[vite-plugin-sri-gen] Failed to add SRI to ${fileName}: ${err?.message || err}`);
        }
      }
    },
  } as any;
}
