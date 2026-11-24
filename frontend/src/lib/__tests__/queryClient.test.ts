import { MutationCache, QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "../apiErrors";
import { createMutationCache, queryClient, shouldRetry } from "../queryClient";
import { useToastStore } from "../../stores/toastStore";

const httpError = (status: number) => Object.assign(new Error("http"), { response: { status } });

describe("shouldRetry", () => {
	it("does not retry a 404 or 409", () => {
		expect(shouldRetry(0, httpError(404))).toBe(false);
		expect(shouldRetry(0, httpError(409))).toBe(false);
		expect(shouldRetry(0, new ConflictError("moved", "t"))).toBe(false);
		expect(shouldRetry(0, Object.assign(new Error("x"), { status: 400 }))).toBe(false);
	});

	it("retries a network error twice", () => {
		const net = new Error("Network Error");
		expect(shouldRetry(0, net)).toBe(true);
		expect(shouldRetry(1, net)).toBe(true);
		expect(shouldRetry(2, net)).toBe(false);
		expect(shouldRetry(0, httpError(500))).toBe(true);
	});

	it("is wired as the query default, with mutations never retried", () => {
		const defaults = queryClient.getDefaultOptions();
		expect(defaults.queries?.retry).toBe(shouldRetry);
		expect(defaults.mutations?.retry).toBe(false);
	});
});

describe("global mutation errors", () => {
	afterEach(() => useToastStore.setState({ toasts: [] }));

	const run = async (meta: Record<string, unknown> | undefined, error: Error) => {
		const push = vi.spyOn(useToastStore.getState(), "push");
		const qc = new QueryClient({ mutationCache: createMutationCache() });
		await qc
			.getMutationCache()
			.build(qc, {
				mutationFn: () => Promise.reject(error),
				meta,
			})
			.execute(undefined)
			.catch(() => undefined);
		const calls = push.mock.calls.length;
		const first = push.mock.calls[0];
		push.mockRestore();
		return { calls, first };
	};

	it("mutation errors raise one toast unless meta.silentError", async () => {
		const loud = await run(undefined, new Error("Quote is locked"));
		expect(loud.calls).toBe(1);
		expect(loud.first?.[0]).toBe("error");
		expect(loud.first?.[1]).toBe("Quote is locked");

		expect((await run({ silentError: true }, new Error("x"))).calls).toBe(0);
		expect((await run(undefined, new ConflictError("moved", "t"))).calls).toBe(0);
	});

	it("builds a MutationCache", () => {
		expect(createMutationCache()).toBeInstanceOf(MutationCache);
	});
});
