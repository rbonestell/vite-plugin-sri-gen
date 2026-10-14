// Unit tests must never reach the network: a real request can outlive the
// test timeout on a slow CI runner. Tests that exercise fetching mock it.
globalThis.fetch = (async () => {
	throw new Error("Network access is disabled in unit tests");
}) as typeof fetch;
