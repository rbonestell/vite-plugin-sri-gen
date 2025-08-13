/**
 * Test Mock Implementations for DOM Abstraction Layer
 * 
 * This module provides mock implementations of the DOM abstraction interfaces
 * for use in unit tests, combining Vitest spies with behavioral simulation.
 * 
 * Hybrid approach:
 * - Uses vi.fn() for call tracking and standard Vitest assertions
 * - Maintains complex behavioral logic for DOM simulation
 * - Provides both spy verification and stateful element behavior
 */

import { vi } from 'vitest';
import type { 
	IBrowserElement, 
	IBrowserHTMLLinkElement, 
	IBrowserHTMLScriptElement, 
	IDOMAdapter, 
	INodeAdapter, 
	IURLAdapter,
	IRuntimeDependencies
} from '../../src/dom-abstraction';

/**
 * Mock browser element for testing
 */
export class MockElement implements IBrowserElement {
	private attributes: Map<string, string> = new Map();
	
	constructor(
		public readonly tagName: string,
		public readonly nodeName: string = tagName.toUpperCase(),
		initialAttributes: Record<string, string> = {}
	) {
		Object.entries(initialAttributes).forEach(([name, value]) => {
			this.attributes.set(name, value);
		});
	}
	
	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}
	
	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}
	
	getAttribute(name: string): string | null {
		return this.attributes.get(name) || null;
	}
	
	// Helper for tests to inspect attributes
	getAllAttributes(): Record<string, string> {
		const result: Record<string, string> = {};
		this.attributes.forEach((value, key) => {
			result[key] = value;
		});
		return result;
	}
}

/**
 * Mock link element for testing
 */
export class MockLinkElement extends MockElement implements IBrowserHTMLLinkElement {
	constructor(initialAttributes: Record<string, string> = {}) {
		super('link', 'LINK', initialAttributes);
	}
	
	get rel(): string {
		return this.getAttribute('rel') || '';
	}
	
	set rel(value: string) {
		this.setAttribute('rel', value);
	}
	
	get href(): string {
		return this.getAttribute('href') || '';
	}
	
	set href(value: string) {
		this.setAttribute('href', value);
	}
	
	get as(): string | undefined {
		return this.getAttribute('as') || undefined;
	}
	
	set as(value: string | undefined) {
		if (value !== undefined) {
			this.setAttribute('as', value);
		}
	}
}

/**
 * Mock script element for testing
 */
export class MockScriptElement extends MockElement implements IBrowserHTMLScriptElement {
	constructor(initialAttributes: Record<string, string> = {}) {
		super('script', 'SCRIPT', initialAttributes);
	}
	
	get src(): string {
		return this.getAttribute('src') || '';
	}
	
	set src(value: string) {
		this.setAttribute('src', value);
	}
}

/**
 * Mock DOM adapter for testing with Vitest spy integration
 */
export class MockDOMAdapter implements IDOMAdapter {
	public shouldFailSetIntegrity: boolean = false;
	
	// Vitest spies for call tracking with implementation
	public setIntegrityAttributes = vi.fn(this._setIntegrityAttributesImpl.bind(this));
	public isEligibleForSRI = vi.fn(this._isEligibleForSRIImpl.bind(this));
	public getElementURL = vi.fn(this._getElementURLImpl.bind(this));
	
	// Type predicate methods with manual tracking (spies don't work with type predicates)
	private _linkElementCalls: any[] = [];
	private _scriptElementCalls: any[] = [];
	
	isHTMLLinkElement(element: any): element is IBrowserHTMLLinkElement {
		this._linkElementCalls.push(element);
		return element instanceof MockLinkElement || element?.tagName?.toLowerCase() === 'link';
	}
	
	isHTMLScriptElement(element: any): element is IBrowserHTMLScriptElement {
		this._scriptElementCalls.push(element);
		return element instanceof MockScriptElement || element?.tagName?.toLowerCase() === 'script';
	}
	
	private _isEligibleForSRIImpl(element: IBrowserElement): boolean {
		if (!element.hasAttribute) return false;
		
		const tagName = element.tagName?.toLowerCase() || element.nodeName?.toLowerCase();
		
		if (tagName === 'script') {
			return element.hasAttribute('src') && !element.hasAttribute('integrity');
		}
		
		if (tagName === 'link') {
			const rel = element.getAttribute('rel');
			return (
				(rel === 'stylesheet' || rel === 'modulepreload' || 
				 (rel === 'preload' && ['script', 'style', 'font'].includes(element.getAttribute('as') || ''))) &&
				element.hasAttribute('href') && 
				!element.hasAttribute('integrity')
			);
		}
		
		return false;
	}
	
	private _setIntegrityAttributesImpl(
		element: IBrowserElement, 
		integrity: string, 
		crossorigin?: string
	): void {
		try {
			if (this.shouldFailSetIntegrity) {
				throw new Error('Mock setAttribute failure for testing');
			}
			
			element.setAttribute('integrity', integrity);
			if (crossorigin) {
				element.setAttribute('crossorigin', crossorigin);
			}
		} catch {
			// Silently ignore setAttribute errors to prevent runtime failures
		}
	}
	
	private _getElementURLImpl(element: IBrowserElement): string | null {
		const tagName = element.tagName?.toLowerCase() || element.nodeName?.toLowerCase();
		
		if (tagName === 'script') {
			return element.getAttribute('src');
		}
		
		if (tagName === 'link') {
			return element.getAttribute('href'); 
		}
		
		return null;
	}
	
	// Enhanced call clearing with both spy and manual tracking
	clearCallLog(): void {
		this.setIntegrityAttributes.mockClear();
		this.isEligibleForSRI.mockClear();
		this.getElementURL.mockClear();
		this._linkElementCalls = [];
		this._scriptElementCalls = [];
	}
	
	// Helper methods for type predicate call verification
	getLinkElementCalls(): any[] {
		return [...this._linkElementCalls];
	}
	
	getScriptElementCalls(): any[] {
		return [...this._scriptElementCalls];
	}
	
	/**
	 * @deprecated Use expect(mockAdapter.setIntegrityAttributes).toHaveBeenCalledWith() instead
	 */
	getIntegrityCallsForElement(element: IBrowserElement): Array<{
		element: IBrowserElement;
		integrity: string;
		crossorigin?: string;
	}> {
		return this.setIntegrityAttributes.mock.calls
			.filter(call => call[0] === element)
			.map(call => ({
				element: call[0],
				integrity: call[1],
				crossorigin: call[2]
			}));
	}
}

/**
 * Mock node adapter for testing with Vitest spy integration
 */
export class MockNodeAdapter implements INodeAdapter {
	public mockPrototypes: Map<any, Record<string, Function>> = new Map();
	
	// Vitest spies for call tracking with implementation
	public wrapNodeInsertion = vi.fn(this._wrapNodeInsertionImpl.bind(this));
	public wrapSetAttribute = vi.fn(this._wrapSetAttributeImpl.bind(this));
	
	// Private implementation methods
	private _wrapNodeInsertionImpl(
		prototype: any, 
		methodName: string, 
		callback: (element: IBrowserElement) => void
	): void {
		// Actually mock the method for testing
		if (!this.mockPrototypes.has(prototype)) {
			this.mockPrototypes.set(prototype, {});
		}
		
		const mocks = this.mockPrototypes.get(prototype)!;
		const original = prototype[methodName] || function() {};
		
		mocks[methodName] = original;
		prototype[methodName] = function (...args: any[]) {
			const result = original.apply(this, args);
			
			// Process inserted elements
			args.forEach(arg => {
				if (arg && typeof arg === 'object' && arg.tagName) {
					callback(arg as IBrowserElement);
				}
			});
			
			return result;
		};
	}
	
	private _wrapSetAttributeImpl(
		prototype: any,
		callback: (element: IBrowserElement) => void
	): void {
		// Actually mock the method for testing
		if (!this.mockPrototypes.has(prototype)) {
			this.mockPrototypes.set(prototype, {});
		}
		
		const mocks = this.mockPrototypes.get(prototype)!;
		const original = prototype.setAttribute || function() {};
		
		// Only wrap if not already wrapped
		if (!mocks.setAttribute) {
			mocks.setAttribute = original;
			prototype.setAttribute = function (name: string, value: string) {
				const result = original.call(this, name, value);
				
				// Check if this is a URL-changing attribute
				const isURLAttr = (
					(name === 'src' && this.tagName?.toLowerCase() === 'script') ||
					(name === 'href' && this.tagName?.toLowerCase() === 'link') ||
					(name === 'rel' || name === 'as')
				);
				
				if (isURLAttr && this.tagName) {
					callback(this as IBrowserElement);
				}
				
				return result;
			};
		}
	}
	
	// Enhanced test helpers with Vitest integration
	clearCallLog(): void {
		this.wrapNodeInsertion.mockClear();
		this.wrapSetAttribute.mockClear();
	}
	
	restorePrototypes(): void {
		this.mockPrototypes.forEach((mocks, prototype) => {
			Object.entries(mocks).forEach(([methodName, original]) => {
				prototype[methodName] = original;
			});
		});
		this.mockPrototypes.clear();
	}
}

/**
 * Mock URL adapter for testing with Vitest spy integration
 */
export class MockURLAdapter implements IURLAdapter {
	public baseURL: string = 'http://localhost/';
	public shouldFailResolve: boolean = false;
	
	// Vitest spies for call tracking with implementation
	public resolveURL = vi.fn(this._resolveURLImpl.bind(this));
	public getBaseURL = vi.fn(this._getBaseURLImpl.bind(this));
	
	// Private implementation methods
	private _resolveURLImpl(url: string, baseURL?: string): string {
		const base = baseURL || this.baseURL;
		
		if (this.shouldFailResolve) {
			return url; // Return original on failure
		}
		
		try {
			return new URL(url, base).href;
		} catch {
			return url; // Return original on parse failure
		}
	}
	
	private _getBaseURLImpl(): string {
		return this.baseURL;
	}
	
	// Enhanced test helpers with Vitest integration
	setBaseURL(url: string): void {
		this.baseURL = url;
	}
	
	clearCallLog(): void {
		this.resolveURL.mockClear();
		this.getBaseURL.mockClear();
	}
	
	/**
	 * @deprecated Use expect(mockAdapter.resolveURL).toHaveBeenCalledWith() instead
	 */
	getResolveURLCalls(): Array<{ url: string; baseURL?: string; result: string }> {
		return this.resolveURL.mock.calls.map((call, index) => ({
			url: call[0],
			baseURL: call[1],
			result: this.resolveURL.mock.results[index]?.value || call[0]
		}));
	}
}

/**
 * Factory function to create test runtime dependencies
 */
export function createTestDependencies(): IRuntimeDependencies & {
	mocks: {
		domAdapter: MockDOMAdapter;
		nodeAdapter: MockNodeAdapter;
		urlAdapter: MockURLAdapter;
	}
	} {
	const domAdapter = new MockDOMAdapter();
	const nodeAdapter = new MockNodeAdapter();
	const urlAdapter = new MockURLAdapter();
	
	return {
		domAdapter,
		nodeAdapter,
		urlAdapter,
		mocks: {
			domAdapter,
			nodeAdapter,
			urlAdapter
		}
	};
}

/**
 * Helper function to create mock elements for tests
 */
export function createMockElements() {
	return {
		createScript: (attributes: Record<string, string> = {}) => 
			new MockScriptElement(attributes),
		
		createLink: (attributes: Record<string, string> = {}) => 
			new MockLinkElement(attributes),
		
		createElement: (tagName: string, attributes: Record<string, string> = {}) => 
			new MockElement(tagName, tagName.toUpperCase(), attributes)
	};
}