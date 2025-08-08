import type { IndexHtmlTransformContext, Plugin } from 'vite'

export interface SriPluginOptions {
  algorithm?: 'sha256' | 'sha384' | 'sha512'
  crossorigin?: 'anonymous' | 'use-credentials'
  /**
   * Enable SRI generation during dev server. Default: false
   */
  dev?: boolean
  /**
   * Enable in-memory caching for remote fetches. Default: true
   */
  fetchCache?: boolean
  /**
   * Abort remote fetches after the given milliseconds. Default: 5000 (5 seconds).
   * When > 0, a timeout is applied; if not provided but enabled elsewhere, use 15000ms.
   */
  fetchTimeoutMs?: number
}

export default function sri(options?: SriPluginOptions): Plugin & {
  transformIndexHtml(html: string, context: IndexHtmlTransformContext): Promise<string>
}
