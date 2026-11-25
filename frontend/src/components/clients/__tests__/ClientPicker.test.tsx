import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ClientPicker from "../ClientPicker";

const { getClientsPage, getClientById, toastError } = vi.hoisted(() => ({
	getClientsPage: vi.fn(),
	getClientById: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("../../../api/clients", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../api/clients")>()),
	getClientsPage,
	getClientById,
}));
vi.mock("../../ui/useToast", () => ({ useToast: () => ({ error: toastError }) }));

const row = (id: string, name: string) => ({ id, name, is_active: true });

function setup(props: Partial<React.ComponentProps<typeof ClientPicker>> = {}) {
	const onChange = vi.fn();
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<ClientPicker value="" onChange={onChange} {...props} />
		</QueryClientProvider>,
	);
	return { onChange, input: screen.getByLabelText("Client") };
}

beforeEach(() => {
	toastError.mockReset();
	getClientsPage.mockReset().mockResolvedValue({
		rows: [row("c1", "Acme Heating"), row("c2", "Bolt Air")],
		total: 2,
		page: 1,
		limit: 20,
	});
	getClientById.mockReset().mockImplementation((id: string) =>
		Promise.resolve({ id, name: id === "c1" ? "Acme Heating" : "Other", address: "1 Main" }),
	);
});

describe("ClientPicker", () => {
	it("fetches nothing until the field is focused", async () => {
		const { input } = setup();
		await new Promise((r) => setTimeout(r, 20));
		expect(getClientsPage).not.toHaveBeenCalled();
		fireEvent.focus(input);
		await waitFor(() => expect(getClientsPage).toHaveBeenCalledTimes(1));
		expect(getClientsPage.mock.calls[0][0]).toMatchObject({ page: 1, limit: 20, sort: "name" });
	});

	it("searches the server for what is typed and reports the pick with the full client", async () => {
		const onPick = vi.fn();
		const { onChange, input } = setup({ onPick });
		fireEvent.focus(input);
		fireEvent.change(input, { target: { value: "acm" } });
		await waitFor(() =>
			expect(getClientsPage).toHaveBeenLastCalledWith(
				expect.objectContaining({ q: "acm" }),
			),
		);
		fireEvent.click(await screen.findByText("Bolt Air"));
		expect(onChange).toHaveBeenCalledWith("c2");
		await waitFor(() => expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "c2" })));
	});

	it("shows the name of a client set from outside", async () => {
		const { input } = setup({ value: "c1" });
		await waitFor(() => expect((input as HTMLInputElement).value).toBe("Acme Heating"));
	});

	it("a slow fetch for an earlier pick does not prefill over a later pick", async () => {
		let releaseFirst!: (c: unknown) => void;
		getClientById.mockImplementation((id: string) =>
			id === "c1"
				? new Promise((r) => (releaseFirst = r))
				: Promise.resolve({ id, name: "Bolt Air", address: "2 Side" }),
		);
		const onPick = vi.fn();
		const { input } = setup({ onPick });
		fireEvent.focus(input);
		fireEvent.click(await screen.findByText("Acme Heating"));
		fireEvent.focus(input);
		fireEvent.click(await screen.findByText("Bolt Air"));
		await waitFor(() => expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "c2" })));
		releaseFirst({ id: "c1", name: "Acme Heating", address: "1 Main" });
		await new Promise((r) => setTimeout(r, 20));
		expect(onPick).toHaveBeenCalledTimes(1);
	});

	it("tells the user when the full client cannot be loaded", async () => {
		getClientById.mockRejectedValue(new Error("boom"));
		const onPick = vi.fn();
		const { input } = setup({ onPick });
		fireEvent.focus(input);
		fireEvent.click(await screen.findByText("Acme Heating"));
		await waitFor(() => expect(toastError).toHaveBeenCalledWith("boom"));
		expect(onPick).not.toHaveBeenCalled();
	});
});
