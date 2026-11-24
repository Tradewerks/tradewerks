import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const api = vi.hoisted(() => ({ rescheduleOccurrence: vi.fn() }));
vi.mock("../../api/recurringPlans", () => api);

import { useRescheduleOccurrenceMutation } from "../useRecurringPlans";
import { useToastStore } from "../../stores/toastStore";

function run(response: Record<string, unknown>) {
	api.rescheduleOccurrence.mockResolvedValue({ id: "o1", ...response });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	const { result } = renderHook(() => useRescheduleOccurrenceMutation(), { wrapper });
	return act(async () => {
		await result.current.mutateAsync({
			occurrenceId: "o1",
			jobId: "j1",
			input: { new_start_at: "2026-11-26T19:00:00.000Z", scope: "future" },
		});
	});
}

const messages = () => useToastStore.getState().toasts.map((t) => String(t.message));

describe("useRescheduleOccurrenceMutation", () => {
	it("tells the dispatcher how many scheduled visits kept their time", async () => {
		useToastStore.setState({ toasts: [] });
		await run({ kept_visits: 2 });
		await waitFor(() =>
			expect(messages()).toContain("2 visits already scheduled kept their time"),
		);
	});

	it("says nothing when no scheduled visit was kept", async () => {
		useToastStore.setState({ toasts: [] });
		await run({ kept_visits: 0 });
		expect(messages()).toEqual([]);
	});
});
