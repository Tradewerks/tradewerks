/**
 * The held purchase belongs to the job it was created for. Reused after the
 * technician changes their mind it keeps the first job's allocation, so the receipt
 * bills a customer who never received the part.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import StartPurchaseButton from "../StartPurchaseButton";

const createMutate = vi.fn();
const uploadMutate = vi.fn();
const deleteMutate = vi.fn();

vi.mock("../../../../hooks/useFieldPurchases", () => ({
	useCreateFieldPurchase: () => ({ mutateAsync: createMutate, isPending: false }),
	useUploadReceipt: () => ({ mutateAsync: uploadMutate, isPending: false }),
	useDeleteFieldPurchase: () => ({ mutateAsync: deleteMutate, isPending: false }),
	useMyPurchaseAuthority: () => ({
		data: { grant: { is_active: true } },
		isLoading: false,
	}),
}));

vi.mock("../../../../hooks/useJobs", () => ({
	useMyJobsQuery: () => ({
		data: [
			{ job_id: "job-a", job_name: "Job A", visit_id: "visit-a" },
			{ job_id: "job-b", job_name: "Job B", visit_id: "visit-b" },
		],
		isLoading: false,
		isError: false,
	}),
}));

vi.mock("../../../../hooks/usePermission", () => ({ usePermission: () => true }));

const photo = () => new File([new Uint8Array(8)], "receipt.jpg", { type: "image/jpeg" });

vi.mock("../receiptCapture", () => ({
	captureFrom: vi.fn(async () => ({ file: photo() })),
}));

// The camera is not what this is about: the stub hands the shot straight over.
vi.mock("../ReceiptScanner", () => ({
	default: ({ onAccept }: { onAccept: (f: File) => void | Promise<void> }) => (
		<button type="button" onClick={() => void onAccept(photo())}>
			stub-accept
		</button>
	),
}));

const openJobChooser = async () => {
	const user = userEvent.setup();
	render(
		<MemoryRouter>
			<StartPurchaseButton job={null} />
		</MemoryRouter>
	);
	await user.click(screen.getByRole("button", { name: /record a field purchase/i }));
	await user.click(screen.getByRole("button", { name: "stub-accept" }));
	await screen.findByRole("button", { name: /job a/i });
	return user;
};

beforeEach(() => {
	vi.clearAllMocks();
	createMutate.mockImplementation(async (input: { allocations: { job_id: string }[] }) => ({
		id: `fp-${input.allocations[0]!.job_id}`,
	}));
	uploadMutate.mockResolvedValue({});
	deleteMutate.mockResolvedValue(undefined);
});

describe("changing the job after a failed upload", () => {
	test("creates a new purchase for the job that was actually picked", async () => {
		uploadMutate.mockRejectedValueOnce(new Error("offline"));
		const user = await openJobChooser();

		await user.click(screen.getByRole("button", { name: /job a/i }));
		await screen.findByText(/offline/i);
		await user.click(screen.getByRole("button", { name: /job b/i }));

		await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(2));
		expect(createMutate.mock.calls[1]![0]).toEqual({
			allocations: [{ job_id: "job-b", job_visit_id: "visit-b" }],
		});
		expect(uploadMutate).toHaveBeenLastCalledWith(
			expect.objectContaining({ id: "fp-job-b" })
		);
	});

	// The reason `startedRef` exists: a retry on the same job must not leave a
	// second empty draft behind it.
	test("reuses the same purchase when the same job is picked again", async () => {
		uploadMutate.mockRejectedValueOnce(new Error("offline"));
		const user = await openJobChooser();

		await user.click(screen.getByRole("button", { name: /job a/i }));
		await screen.findByText(/offline/i);
		await user.click(screen.getByRole("button", { name: /job a/i }));

		await waitFor(() => expect(uploadMutate).toHaveBeenCalledTimes(2));
		expect(createMutate).toHaveBeenCalledTimes(1);
		expect(deleteMutate).not.toHaveBeenCalled();
	});

	test("deletes the abandoned draft", async () => {
		uploadMutate.mockRejectedValueOnce(new Error("offline"));
		const user = await openJobChooser();

		await user.click(screen.getByRole("button", { name: /job a/i }));
		await screen.findByText(/offline/i);
		await user.click(screen.getByRole("button", { name: /job b/i }));

		await waitFor(() => expect(deleteMutate).toHaveBeenCalledWith("fp-job-a"));
	});

	// Fire and forget: a technician standing at a counter waits on the retry, never
	// on tidying up the row they abandoned.
	test("still creates the new purchase when the cleanup delete fails", async () => {
		uploadMutate.mockRejectedValueOnce(new Error("offline"));
		deleteMutate.mockRejectedValue(new Error("cleanup failed"));
		const user = await openJobChooser();

		await user.click(screen.getByRole("button", { name: /job a/i }));
		await screen.findByText(/offline/i);
		await user.click(screen.getByRole("button", { name: /job b/i }));

		await waitFor(() =>
			expect(uploadMutate).toHaveBeenLastCalledWith(
				expect.objectContaining({ id: "fp-job-b" })
			)
		);
		expect(screen.queryByText(/cleanup failed/i)).toBeNull();
	});
});
