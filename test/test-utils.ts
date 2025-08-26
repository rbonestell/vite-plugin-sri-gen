/**
 * Test Utilities for vite-plugin-sri-gen
 * Comprehensive helpers for testing SRI functionality
 */

import * as parse5 from "parse5";
import type { Element } from "parse5/dist/tree-adapters/default";

/**
 * Advanced HTML generation utilities
 */
export class HtmlGenerator {
	/**
	 * Generate HTML with multiple script and link elements for testing
	 */
	static generateMultiResourceHtml(
		scripts: string[] = [],
		stylesheets: string[] = [],
		options: {
			includeDoctype?: boolean;
			includeHead?: boolean;
			includeBody?: boolean;
			addIntegrity?: boolean;
		} = {}
	): string {
		const {
			includeDoctype = true,
			includeHead = true,
			includeBody = true,
			addIntegrity = false,
		} = options;

		const scriptTags = scripts
			.map((src) => {
				const integrity = addIntegrity
					? ` integrity="sha256-placeholder"`
					: "";
				return `<script src="${src}"${integrity}></script>`;
			})
			.join("\n\t\t");

		const linkTags = stylesheets
			.map((href) => {
				const integrity = addIntegrity
					? ` integrity="sha256-placeholder"`
					: "";
				return `<link rel="stylesheet" href="${href}"${integrity}>`;
			})
			.join("\n\t\t");

		let html = "";
		if (includeDoctype) html += "<!DOCTYPE html>\n";
		html += "<html>\n";
		if (includeHead) {
			html += "\t<head>\n";
			if (scriptTags) html += `\t\t${scriptTags}\n`;
			if (linkTags) html += `\t\t${linkTags}\n`;
			html += "\t</head>\n";
		}
		if (includeBody) html += "\t<body></body>\n";
		html += "</html>";

		return html;
	}

	/**
	 * Generate malformed HTML for testing error handling
	 */
	static generateMalformedHtml(type: "unclosed" | "invalid" | "nested"): string {
		switch (type) {
			case "unclosed":
				return "<html><head><script src='/test.js'><body>"; // Missing closing tags
			case "invalid":
				return "<html><head><script src='/test.js' invalid-attr></head></html>"; // Invalid attributes
			case "nested":
				return "<html><head><script><script src='/nested.js'></script></script></head></html>"; // Improperly nested
			default:
				return "<html></html>";
		}
	}
}

/**
 * Bundle generation utilities
 */
export class BundleGenerator {
	/**
	 * Create bundle with specified content and types
	 */
	static createBundle(files: Record<string, string | Buffer | Uint8Array>): any {
		const bundle: any = {};

		for (const [filename, content] of Object.entries(files)) {
			const extension = filename.split(".").pop()?.toLowerCase();
			
			bundle[filename] = {
				type: ["js", "ts", "jsx", "tsx", "mjs"].includes(extension || "") ? "chunk" : "asset",
				fileName: filename,
				...(typeof content === "string" && ["js", "ts", "jsx", "tsx", "mjs"].includes(extension || "")
					? { code: content }
					: { source: content }
				),
			};
		}

		return bundle;
	}

	/**
	 * Create bundle with corrupted or edge case data
	 */
	static createCorruptedBundle(): any {
		return {
			"valid.js": { type: "chunk", code: "console.log('valid');" },
			"null-source.js": { type: "chunk", code: null },
			"empty-source.css": { type: "asset", source: "" },
			"binary.wasm": { type: "asset", source: new Uint8Array([0, 1, 2, 3]) },
			"missing-type": { source: "no type specified" },
		};
	}

	/**
	 * Generate bundle with performance test data
	 */
	static createLargeBundle(fileCount: number = 100): any {
		const bundle: any = {};

		for (let i = 0; i < fileCount; i++) {
			const isScript = i % 2 === 0;
			const filename = `${isScript ? "script" : "style"}-${i}.${isScript ? "js" : "css"}`;
			const content = isScript 
				? `console.log('script ${i}');`
				: `.class-${i} { color: hsl(${i * 10}, 50%, 50%); }`;

			bundle[filename] = {
				type: isScript ? "chunk" : "asset",
				fileName: filename,
				[isScript ? "code" : "source"]: content,
			};
		}

		return bundle;
	}
}

/**
 * DOM validation utilities
 */
export class DomValidator {
	/**
	 * Parse HTML and validate structure
	 */
	static validateHtml(html: string): {
		isValid: boolean;
		hasHead: boolean;
		hasBody: boolean;
		scriptCount: number;
		linkCount: number;
		integrityCount: number;
		errors: string[];
	} {
		const errors: string[] = [];
		
		try {
			const document = parse5.parse(html);
			const htmlElement = document.childNodes.find(
				(node: any) => node.nodeName === "html"
			) as any;

			if (!htmlElement) {
				errors.push("No HTML element found");
				return {
					isValid: false,
					hasHead: false,
					hasBody: false,
					scriptCount: 0,
					linkCount: 0,
					integrityCount: 0,
					errors,
				};
			}

			const head = htmlElement.childNodes?.find((node: any) => node.nodeName === "head");
			const body = htmlElement.childNodes?.find((node: any) => node.nodeName === "body");

			let scriptCount = 0;
			let linkCount = 0;
			let integrityCount = 0;

			// Count elements recursively
			const countElements = (nodes: any[]) => {
				for (const node of nodes || []) {
					if (node.nodeName === "script") {
						scriptCount++;
						if (node.attrs?.some((attr: any) => attr.name === "integrity")) {
							integrityCount++;
						}
					} else if (node.nodeName === "link") {
						linkCount++;
						if (node.attrs?.some((attr: any) => attr.name === "integrity")) {
							integrityCount++;
						}
					}
					
					if (node.childNodes) {
						countElements(node.childNodes);
					}
				}
			};

			countElements([htmlElement]);

			return {
				isValid: errors.length === 0,
				hasHead: !!head,
				hasBody: !!body,
				scriptCount,
				linkCount,
				integrityCount,
				errors,
			};
		} catch (error) {
			errors.push(`Parse error: ${error}`);
			return {
				isValid: false,
				hasHead: false,
				hasBody: false,
				scriptCount: 0,
				linkCount: 0,
				integrityCount: 0,
				errors,
			};
		}
	}

	/**
	 * Extract all SRI hashes from HTML
	 */
	static extractSriHashes(html: string): {
		hashes: string[];
		elements: Array<{
			type: "script" | "link";
			src?: string;
			href?: string;
			integrity: string;
		}>;
	} {
		const hashes: string[] = [];
		const elements: any[] = [];

		try {
			const document = parse5.parse(html);
			
			const extractFromNodes = (nodes: any[]) => {
				for (const node of nodes || []) {
					if ((node.nodeName === "script" || node.nodeName === "link") && node.attrs) {
						const integrityAttr = node.attrs.find((attr: any) => attr.name === "integrity");
						if (integrityAttr) {
							const srcAttr = node.attrs.find((attr: any) => attr.name === "src");
							const hrefAttr = node.attrs.find((attr: any) => attr.name === "href");
							
							hashes.push(integrityAttr.value);
							elements.push({
								type: node.nodeName,
								src: srcAttr?.value,
								href: hrefAttr?.value,
								integrity: integrityAttr.value,
							});
						}
					}
					
					if (node.childNodes) {
						extractFromNodes(node.childNodes);
					}
				}
			};

			extractFromNodes(document.childNodes);
		} catch (error) {
			// Ignore parse errors, return empty results
		}

		return { hashes, elements };
	}
}

/**
 * Performance testing utilities
 */
export class PerformanceTester {
	/**
	 * Measure execution time of async functions
	 */
	static async measureAsync<T>(
		fn: () => Promise<T>
	): Promise<{ result: T; duration: number }> {
		const start = performance.now();
		const result = await fn();
		const end = performance.now();
		
		return {
			result,
			duration: end - start,
		};
	}

	/**
	 * Run performance benchmark with multiple iterations
	 */
	static async benchmark<T>(
		fn: () => Promise<T>,
		iterations: number = 10
	): Promise<{
		results: T[];
		durations: number[];
		avgDuration: number;
		minDuration: number;
		maxDuration: number;
	}> {
		const results: T[] = [];
		const durations: number[] = [];

		for (let i = 0; i < iterations; i++) {
			const { result, duration } = await this.measureAsync(fn);
			results.push(result);
			durations.push(duration);
		}

		return {
			results,
			durations,
			avgDuration: durations.reduce((sum, d) => sum + d, 0) / durations.length,
			minDuration: Math.min(...durations),
			maxDuration: Math.max(...durations),
		};
	}
}

/**
 * File system and path utilities for testing
 */
export class PathTestUtils {
	/**
	 * Generate test paths for cross-platform testing
	 */
	static generateTestPaths(): Array<{
		input: string;
		expected: string;
		platform: "windows" | "unix" | "mixed";
		description: string;
	}> {
		return [
			{
				input: "/assets/script.js",
				expected: "assets/script.js",
				platform: "unix",
				description: "Unix absolute path",
			},
			{
				input: "\\assets\\script.js",
				expected: "assets/script.js",
				platform: "windows",
				description: "Windows path with backslashes",
			},
			{
				input: "C:\\project\\assets\\script.js",
				expected: "C:/project/assets/script.js",
				platform: "windows",
				description: "Windows absolute path with drive letter",
			},
			{
				input: "assets\\mixed/path\\script.js",
				expected: "assets/mixed/path/script.js",
				platform: "mixed",
				description: "Mixed path separators",
			},
			{
				input: "//cdn.example.com/script.js",
				expected: "cdn.example.com/script.js",
				platform: "unix",
				description: "Protocol-relative URL",
			},
			{
				input: "./relative/path.js",
				expected: "relative/path.js",
				platform: "unix",
				description: "Relative path",
			},
			{
				input: "../parent/script.js",
				expected: "../parent/script.js",
				platform: "unix",
				description: "Parent directory reference",
			},
		];
	}
}

/**
 * Mock logger with enhanced tracking
 */
export class MockLogger {
	public infoMessages: string[] = [];
	public warnMessages: string[] = [];
	public errorMessages: Array<{ message: string; error?: any }> = [];

	info = (message: string) => {
		this.infoMessages.push(message);
	};

	warn = (message: string) => {
		this.warnMessages.push(message);
	};

	error = (message: string, error?: any) => {
		this.errorMessages.push({ message, error });
	};

	reset() {
		this.infoMessages = [];
		this.warnMessages = [];
		this.errorMessages = [];
	}

	get totalMessages() {
		return this.infoMessages.length + this.warnMessages.length + this.errorMessages.length;
	}

	hasMessage(level: "info" | "warn" | "error", pattern: string): boolean {
		const messages = level === "info" ? this.infoMessages 
			: level === "warn" ? this.warnMessages
			: this.errorMessages.map(e => e.message);
		
		return messages.some(msg => msg.includes(pattern));
	}
}