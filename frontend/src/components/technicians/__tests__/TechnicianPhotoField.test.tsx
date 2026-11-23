import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TechnicianPhotoField from "../TechnicianPhotoField";

const upload = { mutateAsync: vi.fn(), isPending: false };
const remove = { mutateAsync: vi.fn(), isPending: false };
let tech: { name: string; photo_url: string | null } = { name: "Ann Lee", photo_url: null };

vi.mock("../../../hooks/useTechnicians", () => ({
	useTechnicianByIdQuery: () => ({ data: tech, isLoading: false }),
	useUploadTechnicianPhotoMutation: () => upload,
	useDeleteTechnicianPhotoMutation: () => remove,
}));

const pick = (file: File) => {
	const input = screen.getByLabelText("Technician photo") as HTMLInputElement;
	Object.defineProperty(input, "files", { value: [file], configurable: true });
	fireEvent.change(input);
};

beforeEach(() => {
	vi.clearAllMocks();
	tech = { name: "Ann Lee", photo_url: null };
	upload.mutateAsync.mockResolvedValue("https://signed/ann.jpg");
	remove.mutateAsync.mockResolvedValue(undefined);
});

describe("TechnicianPhotoField", () => {
	it("uploads a chosen image for the technician", async () => {
		render(<TechnicianPhotoField technicianId="t1" />);
		expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
		const file = new File(["x"], "me.jpg", { type: "image/jpeg" });
		pick(file);
		await waitFor(() =>
			expect(upload.mutateAsync).toHaveBeenCalledWith({ id: "t1", file })
		);
	});

	it("rejects a non-image without uploading", async () => {
		render(<TechnicianPhotoField technicianId="t1" />);
		pick(new File(["x"], "cv.pdf", { type: "application/pdf" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/JPEG, PNG, or WebP/);
		expect(upload.mutateAsync).not.toHaveBeenCalled();
	});

	it("shows the current photo and removes it", async () => {
		tech = { name: "Ann Lee", photo_url: "https://signed/ann.jpg" };
		render(<TechnicianPhotoField technicianId="t1" />);
		expect(screen.getByRole("img", { name: "Ann Lee" })).toHaveAttribute(
			"src",
			"https://signed/ann.jpg"
		);
		fireEvent.click(screen.getByRole("button", { name: /Remove/ }));
		await waitFor(() => expect(remove.mutateAsync).toHaveBeenCalledWith("t1"));
	});
});
