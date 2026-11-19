import { describe, it, expect, vi, beforeEach, type MockInstance } from "vitest";
import { render, screen, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AxiosError, type AxiosResponse } from "axios";
import type { ReactNode } from "react";

vi.mock("../../../api/axiosClient", () => ({
	api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import { api } from "../../../api/axiosClient";
import VisitConflictDialog from "../VisitConflictDialog";
import { useUpdateJobVisitMutation } from "../../../hooks/useJobs";
import { ConflictError, isConflict } from "../../../lib/apiErrors";

const mockPut = api.put as unknown as MockInstance;

beforeEach(() => vi.clearAllMocks());

describe("VisitConflictDialog", () => {
	it("shows the conflict copy and calls onReload when Reload is pressed", () => {
		const onReload = vi.fn();
		const onClose = vi.fn();
		render(<VisitConflictDialog open onReload={onReload} onClose={onClose} />);

		expect(screen.getByText("Someone else changed this visit")).toBeTruthy();
		expect(
			screen.getByText(
				"Your change was not saved. Reload to see the latest version, then make your change again.",
			),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Reload" }));
		expect(onReload).toHaveBeenCalledTimes(1);
		expect(onClose).not.toHaveBeenCalled();
	});

	it("renders nothing while closed", () => {
		render(<VisitConflictDialog open={false} onReload={vi.fn()} onClose={vi.fn()} />);
		expect(screen.queryByText("Someone else changed this visit")).toBeNull();
	});
});

describe("useUpdateJobVisitMutation", () => {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
		>
			{children}
		</QueryClientProvider>
	);

	it("useUpdateJobVisitMutation rejects with ConflictError on a 409 response", async () => {
		const current = "2026-11-18T10:06:00.000Z";
		mockPut.mockRejectedValue(
			new AxiosError("Request failed with status code 409", "ERR_BAD_REQUEST", undefined, undefined, {
				status: 409,
				data: {
					success: false,
					data: { current_updated_at: current },
					error: { code: "CONFLICT", message: "This visit was changed by someone else." },
				},
			} as AxiosResponse),
		);
		const { result } = renderHook(() => useUpdateJobVisitMutation(), { wrapper });

		let caught: unknown;
		await result.current
			.mutateAsync({
				id: "v1",
				data: { name: "x", expected_updated_at: "2026-11-18T10:00:00.000Z" },
			})
			.catch((e: unknown) => {
				caught = e;
			});

		expect(caught).toBeInstanceOf(ConflictError);
		expect(isConflict(caught)).toBe(true);
		expect((caught as ConflictError).status).toBe(409);
		expect((caught as ConflictError).currentUpdatedAt).toBe(current);
		expect(mockPut).toHaveBeenCalledWith("/job-visits/v1", {
			name: "x",
			expected_updated_at: "2026-11-18T10:00:00.000Z",
		});
		await waitFor(() => expect(result.current.isError).toBe(true));
	});

	it("leaves other failures as plain errors", async () => {
		mockPut.mockRejectedValue(
			new AxiosError("Request failed with status code 400", "ERR_BAD_REQUEST", undefined, undefined, {
				status: 400,
				data: { success: false, data: null, error: { code: "VALIDATION_ERROR", message: "bad" } },
			} as AxiosResponse),
		);
		const { result } = renderHook(() => useUpdateJobVisitMutation(), { wrapper });

		let caught: unknown;
		await result.current.mutateAsync({ id: "v1", data: { name: "x" } }).catch((e: unknown) => {
			caught = e;
		});

		expect(isConflict(caught)).toBe(false);
	});
});
