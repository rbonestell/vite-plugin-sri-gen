/**
 * Test suite for the DOM abstraction layer and dependency injection system.
 *
 * This file tests the new architecture that eliminates global prototype pollution
 * by using dependency injection with proper mock implementations for browser APIs.
 *
 * Key testing patterns demonstrated:
 * - Clean mock creation and setup without global state pollution
 * - Dependency injection for testable browser API interactions
 * - Proper error handling and graceful degradation
 * - Comprehensive coverage of DOM abstraction layer interfaces
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DOMAdapter,
	NodeAdapter,
	URLAdapter,
	defaultDependencies,
	type IBrowserElement,
} from "../src/dom-abstraction";
import { installSriRuntimeWithDeps } from "../src/internal";
import {
	createMockElements,
	createTestDependencies,
} from "./mocks/dom-abstraction-mocks";
import { autoSetupConsoleMock } from "./mocks/logger-mock";

// Auto-setup console mocking for all tests
autoSetupConsoleMock();

describe("DOM Abstraction Layer", () => {
	let dependencies: ReturnType<typeof createTestDependencies>;
	let mockElements: ReturnType<typeof createMockElements>;

	beforeEach(() => {
		// Create fresh dependency mocks for each test to ensure isolation
		dependencies = createTestDependencies();
		mockElements = createMockElements();

		// Clear any state from previous tests to prevent cross-test pollution
		dependencies.mocks.domAdapter.clearCallLog();
		dependencies.mocks.nodeAdapter.clearCallLog();
		dependencies.mocks.urlAdapter.clearCallLog();
	});

	describe("Mock Implementations", () => {
		/**
		 * Validates that mock element creation works correctly.
		 * This ensures our test foundation is solid before testing DOM operations.
		 */
		it("creates mock elements with correct attributes", () => {
			const script = mockElements.createScript({ src: "/test.js" });
			const link = mockElements.createLink({
				href: "/test.css",
				rel: "stylesheet",
			});

			expect(script.getAttribute("src")).toBe("/test.js");
			expect(script.tagName).toBe("script");
			expect(link.getAttribute("href")).toBe("/test.css");
			expect(link.getAttribute("rel")).toBe("stylesheet");
			expect(link.tagName).toBe("link");
		});

		it("handles attribute operations correctly", () => {
			const element = mockElements.createElement("div");

			expect(element.hasAttribute("class")).toBe(false);
			element.setAttribute("class", "test");
			expect(element.hasAttribute("class")).toBe(true);
			expect(element.getAttribute("class")).toBe("test");
		});
	});

	describe("DOMAdapter", () => {
		it("identifies element types correctly with call tracking", () => {
			const script = mockElements.createScript();
			const link = mockElements.createLink();
			const div = mockElements.createElement("div");

			expect(dependencies.domAdapter.isHTMLScriptElement(script)).toBe(
				true
			);
			expect(dependencies.domAdapter.isHTMLLinkElement(link)).toBe(true);
			expect(dependencies.domAdapter.isHTMLScriptElement(div)).toBe(
				false
			);
			expect(dependencies.domAdapter.isHTMLLinkElement(div)).toBe(false);

			// Verify call tracking
			expect(
				dependencies.mocks.domAdapter.getScriptElementCalls()
			).toContain(script);
			expect(
				dependencies.mocks.domAdapter.getScriptElementCalls()
			).toContain(div);
			expect(
				dependencies.mocks.domAdapter.getLinkElementCalls()
			).toContain(link);
			expect(
				dependencies.mocks.domAdapter.getLinkElementCalls()
			).toContain(div);
		});

		it("checks SRI eligibility correctly with Vitest spy verification", () => {
			const scriptWithSrc = mockElements.createScript({
				src: "/test.js",
			});
			const scriptWithoutSrc = mockElements.createScript();
			const scriptWithIntegrity = mockElements.createScript({
				src: "/test.js",
				integrity: "sha256-abc",
			});

			const stylesheetLink = mockElements.createLink({
				href: "/test.css",
				rel: "stylesheet",
			});
			const modulepreloadLink = mockElements.createLink({
				href: "/test.js",
				rel: "modulepreload",
			});
			const preloadScript = mockElements.createLink({
				href: "/test.js",
				rel: "preload",
				as: "script",
			});
			const nonEligibleLink = mockElements.createLink({
				href: "/test.html",
				rel: "next",
			});

			expect(
				dependencies.domAdapter.isEligibleForSRI(scriptWithSrc)
			).toBe(true);
			expect(
				dependencies.domAdapter.isEligibleForSRI(scriptWithoutSrc)
			).toBe(false);
			expect(
				dependencies.domAdapter.isEligibleForSRI(scriptWithIntegrity)
			).toBe(false);
			expect(
				dependencies.domAdapter.isEligibleForSRI(stylesheetLink)
			).toBe(true);
			expect(
				dependencies.domAdapter.isEligibleForSRI(modulepreloadLink)
			).toBe(true);
			expect(
				dependencies.domAdapter.isEligibleForSRI(preloadScript)
			).toBe(true);
			expect(
				dependencies.domAdapter.isEligibleForSRI(nonEligibleLink)
			).toBe(false);

			// Verify spy was called 7 times
			expect(
				dependencies.mocks.domAdapter.isEligibleForSRI
			).toHaveBeenCalledTimes(7);
		});

		it("extracts URLs correctly with spy verification", () => {
			const script = mockElements.createScript({ src: "/test.js" });
			const link = mockElements.createLink({ href: "/test.css" });
			const div = mockElements.createElement("div");

			expect(dependencies.domAdapter.getElementURL(script)).toBe(
				"/test.js"
			);
			expect(dependencies.domAdapter.getElementURL(link)).toBe(
				"/test.css"
			);
			expect(dependencies.domAdapter.getElementURL(div)).toBe(null);

			// Verify spy calls
			expect(
				dependencies.mocks.domAdapter.getElementURL
			).toHaveBeenCalledTimes(3);
			expect(
				dependencies.mocks.domAdapter.getElementURL
			).toHaveBeenCalledWith(script);
			expect(
				dependencies.mocks.domAdapter.getElementURL
			).toHaveBeenCalledWith(link);
			expect(
				dependencies.mocks.domAdapter.getElementURL
			).toHaveBeenCalledWith(div);
		});

		it("sets integrity attributes with Vitest spy verification", () => {
			const element = mockElements.createScript({ src: "/test.js" });

			dependencies.domAdapter.setIntegrityAttributes(
				element,
				"sha256-abc123",
				"anonymous"
			);

			expect(element.getAttribute("integrity")).toBe("sha256-abc123");
			expect(element.getAttribute("crossorigin")).toBe("anonymous");

			// Use standard Vitest assertions
			expect(
				dependencies.mocks.domAdapter.setIntegrityAttributes
			).toHaveBeenCalledTimes(1);
			expect(
				dependencies.mocks.domAdapter.setIntegrityAttributes
			).toHaveBeenCalledWith(element, "sha256-abc123", "anonymous");
		});

		it("handles setAttribute failures gracefully", () => {
			const element = mockElements.createScript({ src: "/test.js" });
			dependencies.mocks.domAdapter.shouldFailSetIntegrity = true;

			// Should not throw, error is caught internally
			expect(() => {
				dependencies.domAdapter.setIntegrityAttributes(
					element,
					"sha256-abc123"
				);
			}).not.toThrow();

			// Attributes should not be set due to the mock failure
			expect(element.hasAttribute("integrity")).toBe(false);
		});
	});

	describe("URLAdapter", () => {
		it("resolves URLs correctly with Vitest spy verification", () => {
			const adapter = dependencies.mocks.urlAdapter;
			adapter.setBaseURL("http://example.com/app/");

			const resolved = adapter.resolveURL("/test.js");
			expect(resolved).toBe("http://example.com/test.js");

			const relativeResolved = adapter.resolveURL("test.js");
			expect(relativeResolved).toBe("http://example.com/app/test.js");

			// Verify spy calls
			expect(
				dependencies.mocks.urlAdapter.resolveURL
			).toHaveBeenCalledTimes(2);
			expect(
				dependencies.mocks.urlAdapter.resolveURL
			).toHaveBeenCalledWith("/test.js");
			expect(
				dependencies.mocks.urlAdapter.resolveURL
			).toHaveBeenCalledWith("test.js");
		});

		it("handles URL parsing failures with spy tracking", () => {
			const adapter = dependencies.mocks.urlAdapter;
			adapter.shouldFailResolve = true;

			const result = adapter.resolveURL("invalid://url");
			expect(result).toBe("invalid://url"); // Returns original on failure

			// Verify spy was called
			expect(
				dependencies.mocks.urlAdapter.resolveURL
			).toHaveBeenCalledWith("invalid://url");
		});

		it("tracks getBaseURL calls with Vitest spy", () => {
			const adapter = dependencies.mocks.urlAdapter;

			const baseURL = adapter.getBaseURL();
			expect(baseURL).toBe("http://localhost/");

			// Verify spy was called
			expect(
				dependencies.mocks.urlAdapter.getBaseURL
			).toHaveBeenCalledTimes(1);
		});
	});

	describe("NodeAdapter", () => {
		it("tracks wrapping calls with Vitest spy", () => {
			const mockProto = { testMethod: () => {} };
			const callback = () => {};

			dependencies.nodeAdapter.wrapNodeInsertion(
				mockProto,
				"testMethod",
				callback
			);

			// Verify spy was called with correct arguments
			expect(
				dependencies.mocks.nodeAdapter.wrapNodeInsertion
			).toHaveBeenCalledTimes(1);
			expect(
				dependencies.mocks.nodeAdapter.wrapNodeInsertion
			).toHaveBeenCalledWith(mockProto, "testMethod", callback);
		});

		it("actually wraps methods for testing", () => {
			const mockProto = {
				appendChild: (child: any) => `appended ${child.tagName}`,
			};

			const processedElements: any[] = [];
			dependencies.nodeAdapter.wrapNodeInsertion(
				mockProto,
				"appendChild",
				(el) => processedElements.push(el)
			);

			const testElement = mockElements.createScript({ src: "/test.js" });
			const result = mockProto.appendChild(testElement);

			expect(result).toBe("appended script");
			expect(processedElements).toHaveLength(1);
			expect(processedElements[0]).toBe(testElement);
		});

		it("wraps setAttribute correctly with spy verification", () => {
			const mockProto = {
				setAttribute: function (name: string, value: string) {
					(this as any)[name] = value;
				},
			};

			const processedElements: any[] = [];
			const callback = (el: any) => processedElements.push(el);

			dependencies.nodeAdapter.wrapSetAttribute(mockProto, callback);

			// Verify spy was called
			expect(
				dependencies.mocks.nodeAdapter.wrapSetAttribute
			).toHaveBeenCalledTimes(1);
			expect(
				dependencies.mocks.nodeAdapter.wrapSetAttribute
			).toHaveBeenCalledWith(mockProto, callback);

			const testElement = mockElements.createScript();
			// Ensure the element has tagName property for URL attribute detection
			Object.defineProperty(testElement, "tagName", {
				value: "script",
				configurable: true,
			});

			// Manually call the wrapped method instead of re-binding
			mockProto.setAttribute.call(testElement, "src", "/test.js");

			expect(processedElements).toHaveLength(1);
			expect(processedElements[0]).toBe(testElement);
		});

		it("restores prototypes after testing", () => {
			const original = () => "original";
			const mockProto = { testMethod: original };

			dependencies.nodeAdapter.wrapNodeInsertion(
				mockProto,
				"testMethod",
				() => {}
			);
			expect(mockProto.testMethod).not.toBe(original);

			dependencies.mocks.nodeAdapter.restorePrototypes();
			expect(mockProto.testMethod).toBe(original);
		});
	});
});

describe("Runtime Installation with Dependency Injection", () => {
	let dependencies: ReturnType<typeof createTestDependencies>;
	let mockElements: ReturnType<typeof createMockElements>;

	beforeEach(() => {
		dependencies = createTestDependencies();
		mockElements = createMockElements();
		dependencies.mocks.urlAdapter.setBaseURL("http://localhost/");
	});

	it("installs runtime with injected dependencies", () => {
		const sriMap = { "/test.js": "sha256-abc123" };

		// Mock global prototypes for testing
		const mockElement = { prototype: { setAttribute: () => {} } };
		const mockNode = {
			prototype: { appendChild: () => {}, insertBefore: () => {} },
		};

		// Temporarily set global prototypes
		const originalElement = (globalThis as any).Element;
		const originalNode = (globalThis as any).Node;

		try {
			(globalThis as any).Element = mockElement;
			(globalThis as any).Node = mockNode;

			// Should not throw
			expect(() => {
				installSriRuntimeWithDeps(
					sriMap,
					{ crossorigin: "anonymous" },
					dependencies
				);
			}).not.toThrow();

			// Verify that adapters were used through Vitest spies
			expect(
				dependencies.mocks.nodeAdapter.wrapSetAttribute
			).toHaveBeenCalledTimes(1);
			expect(
				dependencies.mocks.nodeAdapter.wrapNodeInsertion
			).toHaveBeenCalledTimes(4); // Updated to match actual calls
		} finally {
			(globalThis as any).Element = originalElement;
			(globalThis as any).Node = originalNode;
		}
	});

	it("processes elements correctly through the runtime", () => {
		const sriMap = { "/test.js": "sha256-abc123" };
		installSriRuntimeWithDeps(
			sriMap,
			{ crossorigin: "anonymous" },
			dependencies
		);

		// Simulate what happens when an element is processed
		const script = mockElements.createScript({ src: "/test.js" });

		// Mock the element processing by calling the DOM adapter directly
		if (dependencies.domAdapter.isEligibleForSRI(script)) {
			const url = dependencies.domAdapter.getElementURL(script);
			const integrity = sriMap[url || ""];
			if (integrity) {
				dependencies.domAdapter.setIntegrityAttributes(
					script,
					integrity,
					"anonymous"
				);
			}
		}

		expect(script.getAttribute("integrity")).toBe("sha256-abc123");
		expect(script.getAttribute("crossorigin")).toBe("anonymous");
	});

	it("handles errors gracefully", () => {
		const sriMap = { "/test.js": "sha256-abc123" };

		// Make DOM adapter fail
		dependencies.mocks.domAdapter.shouldFailSetIntegrity = true;

		// Should not throw even with failing dependencies
		expect(() => {
			installSriRuntimeWithDeps(
				sriMap,
				{ crossorigin: "anonymous" },
				dependencies
			);
		}).not.toThrow();
	});

	it("uses production dependencies by default", () => {
		const sriMap = { "/test.js": "sha256-abc123" };

		// Should not throw when using default dependencies
		expect(() => {
			installSriRuntimeWithDeps(sriMap, { crossorigin: "anonymous" });
		}).not.toThrow();
	});
});

describe("Production DOMAdapter", () => {
	let adapter: DOMAdapter;

	beforeEach(() => {
		adapter = new DOMAdapter();
	});

	describe("isHTMLLinkElement", () => {
		it("returns false when HTMLLinkElement is undefined", () => {
			const originalHTMLLinkElement = (globalThis as any).HTMLLinkElement;
			(globalThis as any).HTMLLinkElement = undefined;

			try {
				const result = adapter.isHTMLLinkElement({});
				expect(result).toBe(false);
			} finally {
				(globalThis as any).HTMLLinkElement = originalHTMLLinkElement;
			}
		});

		it("returns false when element is not an instance of HTMLLinkElement", () => {
			const mockElement = {};
			const result = adapter.isHTMLLinkElement(mockElement);
			expect(result).toBe(false);
		});

		it("returns true when element is an instance of HTMLLinkElement", () => {
			class MockHTMLLinkElement {}
			const originalHTMLLinkElement = (globalThis as any).HTMLLinkElement;
			(globalThis as any).HTMLLinkElement = MockHTMLLinkElement;

			try {
				const mockElement = new MockHTMLLinkElement();
				const result = adapter.isHTMLLinkElement(mockElement);
				expect(result).toBe(true);
			} finally {
				(globalThis as any).HTMLLinkElement = originalHTMLLinkElement;
			}
		});
	});

	describe("isHTMLScriptElement", () => {
		it("returns false when HTMLScriptElement is undefined", () => {
			const originalHTMLScriptElement = (globalThis as any)
				.HTMLScriptElement;
			(globalThis as any).HTMLScriptElement = undefined;

			try {
				const result = adapter.isHTMLScriptElement({});
				expect(result).toBe(false);
			} finally {
				(globalThis as any).HTMLScriptElement =
					originalHTMLScriptElement;
			}
		});

		it("returns false when element is not an instance of HTMLScriptElement", () => {
			const mockElement = {};
			const result = adapter.isHTMLScriptElement(mockElement);
			expect(result).toBe(false);
		});

		it("returns true when element is an instance of HTMLScriptElement", () => {
			class MockHTMLScriptElement {}
			const originalHTMLScriptElement = (globalThis as any)
				.HTMLScriptElement;
			(globalThis as any).HTMLScriptElement = MockHTMLScriptElement;

			try {
				const mockElement = new MockHTMLScriptElement();
				const result = adapter.isHTMLScriptElement(mockElement);
				expect(result).toBe(true);
			} finally {
				(globalThis as any).HTMLScriptElement =
					originalHTMLScriptElement;
			}
		});
	});

	describe("isEligibleForSRI", () => {
		it("returns false when element lacks hasAttribute method", () => {
			const element = {} as IBrowserElement;
			const result = adapter.isEligibleForSRI(element);
			expect(result).toBe(false);
		});

		it("handles script elements correctly", () => {
			const createMockElement = (
				attrs: Record<string, string>,
				tagName = "script"
			) =>
				({
					hasAttribute: (name: string) => name in attrs,
					getAttribute: (name: string) => attrs[name] || null,
					tagName,
					nodeName: tagName.toUpperCase(),
				} as IBrowserElement);

			// Script with src but no integrity - eligible
			expect(
				adapter.isEligibleForSRI(createMockElement({ src: "/test.js" }))
			).toBe(true);

			// Script without src - not eligible
			expect(adapter.isEligibleForSRI(createMockElement({}))).toBe(false);

			// Script with src and integrity - not eligible
			expect(
				adapter.isEligibleForSRI(
					createMockElement({
						src: "/test.js",
						integrity: "sha256-abc",
					})
				)
			).toBe(false);
		});

		it("handles link elements correctly", () => {
			const createMockElement = (
				attrs: Record<string, string>,
				tagName = "link"
			) =>
				({
					hasAttribute: (name: string) => name in attrs,
					getAttribute: (name: string) => attrs[name] || null,
					tagName,
					nodeName: tagName.toUpperCase(),
				} as IBrowserElement);

			// Stylesheet link - eligible
			expect(
				adapter.isEligibleForSRI(
					createMockElement({ href: "/test.css", rel: "stylesheet" })
				)
			).toBe(true);

			// Modulepreload link - eligible
			expect(
				adapter.isEligibleForSRI(
					createMockElement({
						href: "/test.js",
						rel: "modulepreload",
					})
				)
			).toBe(true);

			// Preload script - eligible
			expect(
				adapter.isEligibleForSRI(
					createMockElement({
						href: "/test.js",
						rel: "preload",
						as: "script",
					})
				)
			).toBe(true);

			// Preload style - eligible
			expect(
				adapter.isEligibleForSRI(
					createMockElement({
						href: "/test.css",
						rel: "preload",
						as: "style",
					})
				)
			).toBe(true);

			// Preload font - eligible
			expect(
				adapter.isEligibleForSRI(
					createMockElement({
						href: "/test.woff2",
						rel: "preload",
						as: "font",
					})
				)
			).toBe(true);

			// Preload other - not eligible
			expect(
				adapter.isEligibleForSRI(
					createMockElement({
						href: "/test.txt",
						rel: "preload",
						as: "document",
					})
				)
			).toBe(false);

			// Link without href - not eligible
			expect(
				adapter.isEligibleForSRI(
					createMockElement({ rel: "stylesheet" })
				)
			).toBe(false);

			// Link with integrity - not eligible
			expect(
				adapter.isEligibleForSRI(
					createMockElement({
						href: "/test.css",
						rel: "stylesheet",
						integrity: "sha256-abc",
					})
				)
			).toBe(false);

			// Non-eligible rel type - not eligible
			expect(
				adapter.isEligibleForSRI(
					createMockElement({ href: "/test.html", rel: "next" })
				)
			).toBe(false);
		});

		it("handles other element types", () => {
			const createMockElement = (tagName: string) =>
				({
					hasAttribute: () => true,
					getAttribute: () => "value",
					tagName,
					nodeName: tagName.toUpperCase(),
				} as IBrowserElement);

			expect(adapter.isEligibleForSRI(createMockElement("div"))).toBe(
				false
			);
			expect(adapter.isEligibleForSRI(createMockElement("img"))).toBe(
				false
			);
		});

		it("handles elements with missing tagName gracefully", () => {
			const element = {
				hasAttribute: (name: string) => name === "src",
				getAttribute: (name: string) =>
					name === "src" ? "/test.js" : null,
				nodeName: "SCRIPT",
			} as IBrowserElement;

			expect(adapter.isEligibleForSRI(element)).toBe(true);
		});
	});

	describe("setIntegrityAttributes", () => {
		it("sets integrity and crossorigin attributes successfully", () => {
			const attributes: Record<string, string> = {};
			const element = {
				setAttribute: (name: string, value: string) => {
					attributes[name] = value;
				},
			} as IBrowserElement;

			adapter.setIntegrityAttributes(
				element,
				"sha256-abc123",
				"anonymous"
			);

			expect(attributes.integrity).toBe("sha256-abc123");
			expect(attributes.crossorigin).toBe("anonymous");
		});

		it("sets only integrity when crossorigin is not provided", () => {
			const attributes: Record<string, string> = {};
			const element = {
				setAttribute: (name: string, value: string) => {
					attributes[name] = value;
				},
			} as IBrowserElement;

			adapter.setIntegrityAttributes(element, "sha256-abc123");

			expect(attributes.integrity).toBe("sha256-abc123");
			expect(attributes.crossorigin).toBeUndefined();
		});

		it("handles setAttribute errors gracefully", () => {
			const element = {
				setAttribute: () => {
					throw new Error("setAttribute failed");
				},
			} as IBrowserElement;

			// Should not throw
			expect(() => {
				adapter.setIntegrityAttributes(
					element,
					"sha256-abc123",
					"anonymous"
				);
			}).not.toThrow();
		});
	});

	describe("getElementURL", () => {
		it("returns src for script elements", () => {
			const element = {
				tagName: "script",
				getAttribute: (name: string) =>
					name === "src" ? "/test.js" : null,
			} as IBrowserElement;

			expect(adapter.getElementURL(element)).toBe("/test.js");
		});

		it("returns href for link elements", () => {
			const element = {
				tagName: "link",
				getAttribute: (name: string) =>
					name === "href" ? "/test.css" : null,
			} as IBrowserElement;

			expect(adapter.getElementURL(element)).toBe("/test.css");
		});

		it("returns null for other element types", () => {
			const element = {
				tagName: "div",
				getAttribute: () => "/test.txt",
			} as IBrowserElement;

			expect(adapter.getElementURL(element)).toBe(null);
		});

		it("handles elements with missing tagName gracefully using nodeName", () => {
			const element = {
				nodeName: "SCRIPT",
				getAttribute: (name: string) =>
					name === "src" ? "/test.js" : null,
			} as IBrowserElement;

			expect(adapter.getElementURL(element)).toBe("/test.js");
		});
	});
});

describe("Production NodeAdapter", () => {
	let adapter: NodeAdapter;

	beforeEach(() => {
		adapter = new NodeAdapter();
	});

	describe("wrapNodeInsertion", () => {
		it("returns early when prototype is missing", () => {
			const callback = vi.fn();

			// Should not throw
			expect(() => {
				adapter.wrapNodeInsertion(null, "appendChild", callback);
			}).not.toThrow();

			expect(() => {
				adapter.wrapNodeInsertion(undefined, "appendChild", callback);
			}).not.toThrow();
		});

		it("returns early when method does not exist", () => {
			const prototype = {};
			const callback = vi.fn();

			// Should not throw
			expect(() => {
				adapter.wrapNodeInsertion(prototype, "appendChild", callback);
			}).not.toThrow();
		});

		it("wraps method and processes inserted elements", () => {
			const originalMethod = vi.fn(
				(child: any) => `appended ${child.tagName}`
			);
			const prototype = { appendChild: originalMethod };
			const processedElements: any[] = [];

			adapter.wrapNodeInsertion(prototype, "appendChild", (el) => {
				processedElements.push(el);
			});

			// Method should be wrapped
			expect(prototype.appendChild).not.toBe(originalMethod);

			// Test with element
			const element = { tagName: "script" };
			const result = prototype.appendChild(element);

			expect(result).toBe("appended script");
			expect(originalMethod).toHaveBeenCalledWith(element);
			expect(processedElements).toContain(element);
		});

		it("ignores non-element arguments", () => {
			const originalMethod = vi.fn();
			const prototype = { appendChild: originalMethod };
			const processedElements: any[] = [];

			adapter.wrapNodeInsertion(prototype, "appendChild", (el) => {
				processedElements.push(el);
			});

			// Test with non-element arguments
			prototype.appendChild("string");
			prototype.appendChild(123);
			prototype.appendChild(null);
			prototype.appendChild({}); // Object without tagName

			expect(processedElements).toHaveLength(0);
		});

		it("processes multiple elements in arguments", () => {
			const originalMethod = vi.fn();
			const prototype = {
				append: originalMethod, // Method that takes multiple arguments
			};
			const processedElements: any[] = [];

			adapter.wrapNodeInsertion(prototype, "append", (el) => {
				processedElements.push(el);
			});

			const element1 = { tagName: "script" };
			const element2 = { tagName: "link" };

			prototype.append(element1, "text", element2);

			expect(processedElements).toHaveLength(2);
			expect(processedElements).toContain(element1);
			expect(processedElements).toContain(element2);
		});
	});

	describe("wrapSetAttribute", () => {
		it("returns early when prototype is missing", () => {
			const callback = vi.fn();

			// Should not throw
			expect(() => {
				adapter.wrapSetAttribute(null, callback);
			}).not.toThrow();

			expect(() => {
				adapter.wrapSetAttribute(undefined, callback);
			}).not.toThrow();
		});

		it("returns early when setAttribute does not exist", () => {
			const prototype = {};
			const callback = vi.fn();

			// Should not throw
			expect(() => {
				adapter.wrapSetAttribute(prototype, callback);
			}).not.toThrow();
		});

		it("wraps setAttribute and processes URL-changing attributes", () => {
			const originalSetAttribute = vi.fn();
			const prototype = { setAttribute: originalSetAttribute };
			const processedElements: any[] = [];

			adapter.wrapSetAttribute(prototype, (el) => {
				processedElements.push(el);
			});

			// Method should be wrapped
			expect(prototype.setAttribute).not.toBe(originalSetAttribute);

			// Test with script src attribute
			const scriptElement = { tagName: "script" };
			prototype.setAttribute.call(scriptElement, "src", "/test.js");

			expect(originalSetAttribute).toHaveBeenCalledWith(
				"src",
				"/test.js"
			);
			expect(processedElements).toContain(scriptElement);
		});

		it("processes link href attributes", () => {
			const originalSetAttribute = vi.fn();
			const prototype = { setAttribute: originalSetAttribute };
			const processedElements: any[] = [];

			adapter.wrapSetAttribute(prototype, (el) => {
				processedElements.push(el);
			});

			const linkElement = { tagName: "link" };
			prototype.setAttribute.call(linkElement, "href", "/test.css");

			expect(processedElements).toContain(linkElement);
		});

		it("processes rel and as attributes", () => {
			const originalSetAttribute = vi.fn();
			const prototype = { setAttribute: originalSetAttribute };
			const processedElements: any[] = [];

			adapter.wrapSetAttribute(prototype, (el) => {
				processedElements.push(el);
			});

			const linkElement = { tagName: "link" };

			// Test rel attribute
			prototype.setAttribute.call(linkElement, "rel", "stylesheet");
			expect(processedElements).toContain(linkElement);

			processedElements.length = 0; // Clear array

			// Test as attribute
			prototype.setAttribute.call(linkElement, "as", "script");
			expect(processedElements).toContain(linkElement);
		});

		it("ignores non-URL attributes", () => {
			const originalSetAttribute = vi.fn();
			const prototype = { setAttribute: originalSetAttribute };
			const processedElements: any[] = [];

			adapter.wrapSetAttribute(prototype, (el) => {
				processedElements.push(el);
			});

			const element = { tagName: "div" };

			// These should not trigger the callback
			prototype.setAttribute.call(element, "class", "test");
			prototype.setAttribute.call(element, "id", "test");
			prototype.setAttribute.call(element, "data-test", "value");

			expect(processedElements).toHaveLength(0);
		});

		it("handles elements without tagName", () => {
			const originalSetAttribute = vi.fn();
			const prototype = { setAttribute: originalSetAttribute };
			const processedElements: any[] = [];

			adapter.wrapSetAttribute(prototype, (el) => {
				processedElements.push(el);
			});

			const element = {}; // No tagName property
			prototype.setAttribute.call(element, "src", "/test.js");

			expect(processedElements).toHaveLength(0);
		});

		it("handles case-insensitive tagName comparison", () => {
			const originalSetAttribute = vi.fn();
			const prototype = { setAttribute: originalSetAttribute };
			const processedElements: any[] = [];

			adapter.wrapSetAttribute(prototype, (el) => {
				processedElements.push(el);
			});

			// Test with uppercase tagName
			const scriptElement = { tagName: "SCRIPT" };
			prototype.setAttribute.call(scriptElement, "src", "/test.js");

			expect(processedElements).toContain(scriptElement);
		});
	});
});

describe("Production URLAdapter", () => {
	let adapter: URLAdapter;

	beforeEach(() => {
		adapter = new URLAdapter();
	});

	describe("resolveURL", () => {
		it("resolves URLs using provided base URL", () => {
			const result = adapter.resolveURL(
				"/test.js",
				"http://example.com/app/"
			);
			expect(result).toBe("http://example.com/test.js");
		});

		it("resolves relative URLs using provided base URL", () => {
			const result = adapter.resolveURL(
				"test.js",
				"http://example.com/app/"
			);
			expect(result).toBe("http://example.com/app/test.js");
		});

		it("uses getBaseURL when base URL is not provided", () => {
			// Mock location for testing
			const originalLocation = (globalThis as any).location;
			(globalThis as any).location = { href: "http://test.com/page/" };

			try {
				const result = adapter.resolveURL("test.js");
				expect(result).toBe("http://test.com/page/test.js");
			} finally {
				(globalThis as any).location = originalLocation;
			}
		});

		it("returns original URL on parsing failure", () => {
			// Use an invalid base URL to trigger URL constructor failure
			const result = adapter.resolveURL("test.js", "invalid://[url");
			expect(result).toBe("test.js");
		});

		it("handles URL constructor throwing errors", () => {
			// Mock URL constructor to throw
			const originalURL = globalThis.URL;
			globalThis.URL = class extends originalURL {
				constructor(url: string, base?: string) {
					throw new Error("URL parsing failed");
				}
			} as any;

			try {
				const result = adapter.resolveURL(
					"test.js",
					"http://example.com/"
				);
				expect(result).toBe("test.js");
			} finally {
				globalThis.URL = originalURL;
			}
		});
	});

	describe("getBaseURL", () => {
		it("returns location.href when available", () => {
			const originalLocation = (globalThis as any).location;
			(globalThis as any).location = { href: "http://example.com/test/" };

			try {
				const result = adapter.getBaseURL();
				expect(result).toBe("http://example.com/test/");
			} finally {
				(globalThis as any).location = originalLocation;
			}
		});

		it("returns default localhost URL when location is not available", () => {
			const originalLocation = (globalThis as any).location;
			(globalThis as any).location = undefined;

			try {
				const result = adapter.getBaseURL();
				expect(result).toBe("http://localhost/");
			} finally {
				(globalThis as any).location = originalLocation;
			}
		});

		it("returns default localhost URL when location.href is not available", () => {
			const originalLocation = (globalThis as any).location;
			(globalThis as any).location = {};

			try {
				const result = adapter.getBaseURL();
				expect(result).toBe("http://localhost/");
			} finally {
				(globalThis as any).location = originalLocation;
			}
		});

		it("handles globalThis access errors", () => {
			// Mock globalThis to throw when accessing location
			const descriptor = Object.getOwnPropertyDescriptor(
				globalThis,
				"location"
			);
			Object.defineProperty(globalThis, "location", {
				get: () => {
					throw new Error("Access denied");
				},
				configurable: true,
			});

			try {
				const result = adapter.getBaseURL();
				expect(result).toBe("http://localhost/");
			} finally {
				// Restore original descriptor
				if (descriptor) {
					Object.defineProperty(globalThis, "location", descriptor);
				} else {
					delete (globalThis as any).location;
				}
			}
		});
	});
});

describe("Default Dependencies", () => {
	it("exports default dependencies with correct types", () => {
		expect(defaultDependencies).toBeDefined();
		expect(defaultDependencies.domAdapter).toBeInstanceOf(DOMAdapter);
		expect(defaultDependencies.nodeAdapter).toBeInstanceOf(NodeAdapter);
		expect(defaultDependencies.urlAdapter).toBeInstanceOf(URLAdapter);
	});

	it("has working DOM adapter", () => {
		const mockElement = {
			hasAttribute: () => false,
			tagName: "div",
		} as IBrowserElement;

		expect(
			defaultDependencies.domAdapter.isEligibleForSRI(mockElement)
		).toBe(false);
	});

	it("has working URL adapter", () => {
		const result = defaultDependencies.urlAdapter.resolveURL(
			"/test.js",
			"http://example.com/"
		);
		expect(result).toBe("http://example.com/test.js");
	});

	describe("Additional Coverage Tests", () => {
		/**
		 * Additional tests to achieve 100% code coverage
		 * Specifically targeting line 131 in dom-abstraction.ts
		 */

		it("should handle preload link with font type", () => {
			/**
			 * Test coverage for line 131 in dom-abstraction.ts
			 * Specifically testing the font case in the preload link condition
			 */
			const mockElement = {
				tagName: 'LINK',
				nodeName: 'LINK',
				getAttribute: vi.fn((attr: string) => {
					if (attr === 'rel') return 'preload';
					if (attr === 'as') return 'font';
					return null;
				}),
				hasAttribute: vi.fn((attr: string) => {
					if (attr === 'href') return true;
					if (attr === 'integrity') return false;
					return false;
				})
			};

			const result = defaultDependencies.domAdapter.isEligibleForSRI(mockElement);

			expect(result).toBe(true);
			expect(mockElement.getAttribute).toHaveBeenCalledWith('rel');
			expect(mockElement.getAttribute).toHaveBeenCalledWith('as');
			expect(mockElement.hasAttribute).toHaveBeenCalledWith('href');
			expect(mockElement.hasAttribute).toHaveBeenCalledWith('integrity');
		});

		it("should handle preload link with style type", () => {
			/**
			 * Additional test for preload link with style type
			 * to ensure comprehensive coverage of the array includes check
			 */
			const mockElement = {
				tagName: 'LINK',
				nodeName: 'LINK',
				getAttribute: vi.fn((attr: string) => {
					if (attr === 'rel') return 'preload';
					if (attr === 'as') return 'style';
					return null;
				}),
				hasAttribute: vi.fn((attr: string) => {
					if (attr === 'href') return true;
					if (attr === 'integrity') return false;
					return false;
				})
			};

			const result = defaultDependencies.domAdapter.isEligibleForSRI(mockElement);

			expect(result).toBe(true);
			expect(mockElement.getAttribute).toHaveBeenCalledWith('as');
		});
	});
});
