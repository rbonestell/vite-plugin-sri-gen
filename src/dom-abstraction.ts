/**
 * DOM Abstraction Layer for Testable Browser API Interactions
 * 
 * This module provides abstraction interfaces and implementations for browser APIs
 * to enable proper dependency injection and testing without global overrides.
 */

/**
 * Browser Element interface abstraction
 */
export interface IBrowserElement {
	hasAttribute(name: string): boolean;
	setAttribute(name: string, value: string): void;
	getAttribute(name: string): string | null;
	readonly tagName: string;
	readonly nodeName: string;
}

/**
 * Browser Link element abstraction
 */
export interface IBrowserHTMLLinkElement extends IBrowserElement {
	rel: string;
	href: string;
	as?: string;
}

/**
 * Browser Script element abstraction  
 */
export interface IBrowserHTMLScriptElement extends IBrowserElement {
	src: string;
}

/**
 * DOM manipulation interface for runtime operations
 */
export interface IDOMAdapter {
	/**
	 * Check if element is a Link element
	 */
	isHTMLLinkElement(element: any): element is IBrowserHTMLLinkElement;
	
	/**
	 * Check if element is a Script element  
	 */
	isHTMLScriptElement(element: any): element is IBrowserHTMLScriptElement;
	
	/**
	 * Check if element is eligible for SRI based on type and attributes
	 */
	isEligibleForSRI(element: IBrowserElement): boolean;
	
	/**
	 * Set integrity and crossorigin attributes on an element
	 */
	setIntegrityAttributes(
		element: IBrowserElement, 
		integrity: string, 
		crossorigin?: string
	): void;
	
	/**
	 * Get URL from element (src for scripts, href for links)
	 */
	getElementURL(element: IBrowserElement): string | null;
}

/**
 * Node insertion interface for runtime hook patching
 */
export interface INodeAdapter {
	/**
	 * Wrap node insertion methods to add SRI attributes
	 */
	wrapNodeInsertion(
		prototype: any, 
		methodName: string, 
		callback: (element: IBrowserElement) => void
	): void;
	
	/**
	 * Wrap setAttribute method to add SRI attributes on URL changes
	 */
	wrapSetAttribute(
		prototype: any,
		callback: (element: IBrowserElement) => void  
	): void;
}

/**
 * URL parsing interface for runtime operations
 */
export interface IURLAdapter {
	/**
	 * Resolve relative URL to absolute using base URL
	 */
	resolveURL(url: string, baseURL?: string): string;
	
	/**
	 * Get current page base URL
	 */
	getBaseURL(): string;
}

/**
 * DOM adapter implementation using real browser APIs
 */
export class DOMAdapter implements IDOMAdapter {
	isHTMLLinkElement(element: any): element is IBrowserHTMLLinkElement {
		return typeof HTMLLinkElement !== "undefined" && element instanceof HTMLLinkElement;
	}
	
	isHTMLScriptElement(element: any): element is IBrowserHTMLScriptElement {
		return typeof HTMLScriptElement !== "undefined" && element instanceof HTMLScriptElement;
	}
	
	isEligibleForSRI(element: IBrowserElement): boolean {
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
	
	setIntegrityAttributes(
		element: IBrowserElement, 
		integrity: string, 
		crossorigin?: string
	): void {
		try {
			element.setAttribute('integrity', integrity);
			if (crossorigin) {
				element.setAttribute('crossorigin', crossorigin);
			}
		} catch {
			// Silently ignore setAttribute errors to prevent runtime failures
		}
	}
	
	getElementURL(element: IBrowserElement): string | null {
		const tagName = element.tagName?.toLowerCase() || element.nodeName?.toLowerCase();
		
		if (tagName === 'script') {
			return element.getAttribute('src');
		}
		
		if (tagName === 'link') {
			return element.getAttribute('href'); 
		}
		
		return null;
	}
}

/**
 * Node adapter implementation for node operations
 */
export class NodeAdapter implements INodeAdapter {
	wrapNodeInsertion(
		prototype: any, 
		methodName: string, 
		callback: (element: IBrowserElement) => void
	): void {
		if (!prototype || !prototype[methodName]) return;
		
		const original = prototype[methodName];
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
	
	wrapSetAttribute(
		prototype: any,
		callback: (element: IBrowserElement) => void
	): void {
		if (!prototype || !prototype.setAttribute) return;
		
		const original = prototype.setAttribute;
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

/**
 * URL adapter implementation for URL operations
 */  
export class URLAdapter implements IURLAdapter {
	resolveURL(url: string, baseURL?: string): string {
		try {
			const base = baseURL || this.getBaseURL();
			return new URL(url, base).href;
		} catch {
			return url; // Return original on parse failure
		}
	}
	
	getBaseURL(): string {
		try {
			return (globalThis as any).location?.href || 'http://localhost/';
		} catch {
			return 'http://localhost/';
		}
	}
}

/**
 * Runtime dependency container for browser API adapters
 */
export interface IRuntimeDependencies {
	domAdapter: IDOMAdapter;
	nodeAdapter: INodeAdapter; 
	urlAdapter: IURLAdapter;
}

/**
 * Default runtime dependencies using browser APIs
 */
export const defaultDependencies: IRuntimeDependencies = {
	domAdapter: new DOMAdapter(),
	nodeAdapter: new NodeAdapter(),
	urlAdapter: new URLAdapter()
};