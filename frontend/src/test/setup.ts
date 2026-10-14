import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// Cleanup after each test
afterEach(() => {
	cleanup();
});

// Mock environment variables
vi.stubEnv("VITE_BACKEND_URL", "http://localhost:3000");

// jsdom implements no ResizeObserver, and a component that constructs one in an
// effect throws on mount rather than degrading — which is what took out every
// StockHistorySection test. Components measure through it (overflow checks, chip
// fit); a no-op means they render at their unmeasured fallback, which is the state
// jsdom can actually describe. Anything needing real geometry belongs in a browser
// test.
Object.defineProperty(globalThis, "ResizeObserver", {
	writable: true,
	value: class {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
});

// Mock window.matchMedia
Object.defineProperty(window, "matchMedia", {
	writable: true,
	value: vi.fn().mockImplementation((query) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	})),
});

// Fail fast on anything that reaches the network. Every suite mocks its data
// layer (a hook module or an api module); a request that escapes to XHR/fetch
// is a mock gap. Without this it surfaced as an unhandled rejection from the
// HTTP stack long after the test that caused it had passed, blamed on nothing.
// The stub throws at the call site so the code under test sees an immediate
// rejection, and afterEach fails the test that made the call by name.
const unmockedNetworkCalls: string[] = [];
const unmockedNetworkCall = (method: string, url: unknown): Error => {
	const call = `${method.toUpperCase()} ${String(url)}`;
	unmockedNetworkCalls.push(call);
	return new Error(`Unmocked network call: ${call}`);
};

XMLHttpRequest.prototype.open = function open(method: string, url: string | URL) {
	throw unmockedNetworkCall(method, url);
} as typeof XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.send = function send() {
	throw unmockedNetworkCall("SEND", "(XMLHttpRequest)");
};
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
	const url =
		typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	throw unmockedNetworkCall(init?.method ?? "GET", url);
}) as typeof fetch;

afterEach(() => {
	if (unmockedNetworkCalls.length === 0) return;
	const calls = unmockedNetworkCalls.splice(0);
	throw new Error(
		`Unmocked network call(s) during this test — mock the hook or api module:\n  ${calls.join("\n  ")}`,
	);
});

// Module gating is opt-in per test: by default entitlements read as "not loaded",
// which the permission hooks treat as permissive, so no test needs a QueryClient
// or a network mock just because a component checks a permission.
vi.mock("../hooks/useEntitlements", async (importOriginal) => ({
	...(await importOriginal<typeof import("../hooks/useEntitlements")>()),
	useEntitlements: () => ({ data: undefined, isLoading: false }),
	useModule: () => "on",
	useModuleOn: () => true,
}));
