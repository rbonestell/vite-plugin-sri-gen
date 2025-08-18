import { vi, type MockedFunction } from "vitest";
import type { BundleLogger } from "../../src/internal";
import { createConsoleMock } from "./logger-mock";

type BundleEntry = { code?: any; source?: any };
type Bundle = Record<string, BundleEntry>;

export interface MockBundleLogger extends BundleLogger {
	info: MockedFunction<(message: string) => void>;
	warn: MockedFunction<(message: string) => void>;
	error: MockedFunction<(message: string, error?: Error) => void>;
}

/**
 * Creates a mock BundleLogger with vitest mocked functions
 */
export function createMockBundleLogger(): MockBundleLogger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	};
}

/**
 * Creates a mock plugin context with mocked logger methods
 */
export function createMockPluginContext(): {
	warn: MockedFunction<(message: string) => void>;
	info: MockedFunction<(message: string) => void>;
	error: MockedFunction<(message: string, error?: Error) => void>;
	meta?: { watchMode: boolean };
	debug?: MockedFunction<() => void>;
} {
	return {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		meta: { watchMode: false },
		debug: vi.fn(),
	};
}

/**
 * Creates a mock bundle from files for testing
 */
export function mockBundle(files: Record<string, string | BundleEntry>): Bundle {
	return Object.fromEntries(
		Object.entries(files).map(([k, v]) => [
			k,
			typeof v === "string" ? { code: v } : v,
		])
	) as Bundle;
}

/**
 * Creates a spy on console methods and returns cleanup function
 * @deprecated Use the new logger-mock.ts utilities instead for better test isolation
 */
export function spyOnConsole() {
	// Use the new console mock system for consistent behavior
	const consoleMock = createConsoleMock();
	
	return {
		spies: {
			warn: consoleMock.mocks.warn,
			error: consoleMock.mocks.error,
			info: consoleMock.mocks.info,
		},
		cleanup: () => {
			consoleMock.restore();
		},
	};
}