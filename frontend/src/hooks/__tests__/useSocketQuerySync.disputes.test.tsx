import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

const { handlers } = vi.hoisted(() => ({
	handlers: new Map<string, (event: unknown) => void>(),
}));

vi.mock("../../lib/socket", () => ({
	socket: {
		on: (event: string, fn: (e: unknown) => void) => handlers.set(event, fn),
		off: (event: string) => handlers.delete(event),
	},
}));

import { useSocketQuerySync } from "../useSocketQuerySync";

const mount = () => {
	const qc = new QueryClient();
	const spy = vi.spyOn(qc, "invalidateQueries");
	renderHook(() => useSocketQuerySync(), {
		wrapper: ({ children }: { children: React.ReactNode }) => (
			<QueryClientProvider client={qc}>{children}</QueryClientProvider>
		),
	});
	return spy;
};

describe("dispute activity keeps open-dispute lists live", () => {
	test.each(["quote.dispute_opened", "quote.dispute_resolved", "invoice.dispute_opened", "invoice.dispute_resolved"])(
		"%s invalidates the open-disputes prefix",
		(event_type) => {
			const spy = mount();
			handlers.get("activity-event")!({ event_type });
			expect(spy).toHaveBeenCalledWith({ queryKey: ["disputes", "open"] });
		},
	);

	test("an unrelated activity event does not", () => {
		const spy = mount();
		handlers.get("activity-event")!({ event_type: "quote.updated" });
		expect(spy).not.toHaveBeenCalledWith({ queryKey: ["disputes", "open"] });
	});
});
