import { vi, beforeEach, afterEach } from "vitest";

/**
 * Shared logger mock utility for unit tests
 * 
 * This module provides a comprehensive mocking solution for all console and logger
 * methods used throughout the test suite to prevent stdout pollution during testing.
 */

export interface LoggerMock {
  log: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
}

export interface ConsoleMockManager {
  /** The mocked console methods */
  mocks: LoggerMock;
  /** Restore all console methods to their original state */
  restore: () => void;
  /** Clear all mock call history */
  clearHistory: () => void;
}

/**
 * Creates a comprehensive console mock that intercepts all console output
 * Use this in tests to prevent stdout pollution
 */
export function createConsoleMock(): ConsoleMockManager {
  // Store original console methods
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  // Create mocked functions
  const mocks: LoggerMock = {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  // Apply mocks to console
  console.log = mocks.log;
  console.info = mocks.info;
  console.warn = mocks.warn;
  console.error = mocks.error;
  console.debug = mocks.debug;

  return {
    mocks,
    restore: () => {
      console.log = originalConsole.log;
      console.info = originalConsole.info;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
      console.debug = originalConsole.debug;
    },
    clearHistory: () => {
      mocks.log.mockClear();
      mocks.info.mockClear();
      mocks.warn.mockClear();
      mocks.error.mockClear();
      mocks.debug.mockClear();
    },
  };
}

/**
 * Global console mock instance for use across test files
 * Call setupGlobalConsoleMock() in your test setup to activate
 */
let globalConsoleMock: ConsoleMockManager | null = null;

/**
 * Sets up global console mocking for an entire test file
 * Call this in your beforeEach or at the top level of your test file
 */
export function setupGlobalConsoleMock(): ConsoleMockManager {
  if (globalConsoleMock) {
    globalConsoleMock.clearHistory();
    return globalConsoleMock;
  }

  globalConsoleMock = createConsoleMock();
  return globalConsoleMock;
}

/**
 * Cleans up global console mocking
 * Call this in your afterEach or at the end of your test file
 */
export function teardownGlobalConsoleMock(): void {
  if (globalConsoleMock) {
    globalConsoleMock.restore();
    globalConsoleMock = null;
  }
}

/**
 * Gets the current global console mock (if active)
 */
export function getGlobalConsoleMock(): ConsoleMockManager | null {
  return globalConsoleMock;
}

/**
 * Utility function to temporarily mock console for a specific test
 */
export function withMockedConsole<T>(testFn: (mocks: LoggerMock) => T | Promise<T>): T | Promise<T> {
  const mock = createConsoleMock();
  try {
    return testFn(mock.mocks);
  } finally {
    mock.restore();
  }
}

/**
 * Auto-setup for use with vitest beforeEach/afterEach
 * Import and call this to automatically set up console mocking for the entire test file
 */
export function autoSetupConsoleMock() {
  beforeEach(() => {
    setupGlobalConsoleMock();
  });

  afterEach(() => {
    teardownGlobalConsoleMock();
  });
}