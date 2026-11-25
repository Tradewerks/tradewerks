import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSelectedClient } from "../useClients";

const { getClientById, toastError } = vi.hoisted(() => ({
	getClientById: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("../../api/clients", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../api/clients")>()),
	getClientById,
}));
vi.mock("../../components/ui/useToast", () => ({ useToast: () => ({ error: toastError }) }));

const wrap = (qc: QueryClient) =>
	function W({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
	};
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
	getClientById.mockReset().mockRejectedValue(new Error("boom"));
	toastError.mockReset();
});

describe("useSelectedClient", () => {
	it("tells the user once when the load fails while the form is open", async () => {
		const { rerender } = renderHook(({ open }) => useSelectedClient("c1", open), {
			initialProps: { open: true },
			wrapper: wrap(newClient()),
		});
		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		rerender({ open: true });
		expect(toastError).toHaveBeenCalledTimes(1);
	});

	it("stays quiet while the form is closed, then tells on open", async () => {
		const qc = newClient();
		const { rerender } = renderHook(({ open }) => useSelectedClient("c1", open), {
			initialProps: { open: false },
			wrapper: wrap(qc),
		});
		await waitFor(() => expect(getClientById).toHaveBeenCalled());
		await new Promise((r) => setTimeout(r, 20));
		expect(toastError).not.toHaveBeenCalled();
		rerender({ open: true });
		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
	});

	it("does not re-toast an error already cached when the form mounts", async () => {
		const qc = newClient();
		await qc.prefetchQuery({ queryKey: ["clients", "c1"], queryFn: () => getClientById("c1") });
		expect(qc.getQueryState(["clients", "c1"])?.error).toBeTruthy();
		getClientById.mockClear();
		renderHook(() => useSelectedClient("c1", true), { wrapper: wrap(qc) });
		await new Promise((r) => setTimeout(r, 30));
		expect(toastError).not.toHaveBeenCalled();
	});
});
