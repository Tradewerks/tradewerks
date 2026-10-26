import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosError, AxiosHeaders } from "axios";
import NotePhotoPicker from "../NotePhotoPicker";

const mutateAsync = vi.fn();

vi.mock("../../../hooks/useJobs", () => ({
	useUploadNotePhotoMutation: () => ({ mutateAsync, isPending: false }),
}));

vi.mock("../../inventory/ImageCarousel", () => ({
	default: () => <div data-testid="carousel" />,
}));

const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement;

/** A File whose reported size is `bytes` without allocating that much memory. */
const fakeFile = (name: string, type: string, bytes: number): File => {
	const f = new File(["x"], name, { type });
	Object.defineProperty(f, "size", { value: bytes });
	return f;
};

const pick = (file: File) => {
	const input = fileInput();
	Object.defineProperty(input, "files", { value: [file], configurable: true });
	fireEvent.change(input);
};

beforeEach(() => {
	vi.clearAllMocks();
	mutateAsync.mockResolvedValue({ url: "https://cdn/preview.jpg", raw_url: "notes/raw.jpg" });
});

describe("NotePhotoPicker (07-F9)", () => {
	it("restricts the accept list to the types the backend allows", () => {
		render(<NotePhotoPicker jobId="job-1" photos={[]} onPhotosChange={vi.fn()} />);
		expect(fileInput()).toHaveAttribute("accept", "image/jpeg,image/png,image/webp");
	});

	it("rejects unsupported types client-side without uploading", async () => {
		render(<NotePhotoPicker jobId="job-1" photos={[]} onPhotosChange={vi.fn()} />);
		pick(fakeFile("scan.pdf", "application/pdf", 1024));
		expect(await screen.findByRole("alert")).toHaveTextContent(/Unsupported file type.*JPEG, PNG, or WebP/);
		expect(mutateAsync).not.toHaveBeenCalled();
		expect(screen.queryByText("Photo Type")).toBeNull();
	});

	it("rejects files over 5 MB client-side with a clear message", async () => {
		render(<NotePhotoPicker jobId="job-1" photos={[]} onPhotosChange={vi.fn()} />);
		pick(fakeFile("huge.jpg", "image/jpeg", 5 * 1024 * 1024 + 1));
		expect(await screen.findByRole("alert")).toHaveTextContent(/too large.*Maximum size is 5 MB/);
		expect(mutateAsync).not.toHaveBeenCalled();
	});

	it("accepts a 5 MB webp exactly at the limit and uploads it", async () => {
		render(<NotePhotoPicker jobId="job-1" photos={[]} onPhotosChange={vi.fn()} />);
		pick(fakeFile("ok.webp", "image/webp", 5 * 1024 * 1024));
		await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
		expect(mutateAsync.mock.calls[0][0]).toMatchObject({ jobId: "job-1" });
		expect(await screen.findByText("Photo Type")).toBeInTheDocument();
	});

	it("pre-fills the name from the file name and attaches the edited name", async () => {
		const onPhotosChange = vi.fn();
		render(<NotePhotoPicker jobId="job-1" photos={[]} onPhotosChange={onPhotosChange} />);
		pick(fakeFile("IMG_1234.jpg", "image/jpeg", 10));

		const name = await screen.findByLabelText("Photo name");
		expect(name).toHaveValue("IMG_1234");
		fireEvent.change(name, { target: { value: "  Condenser coil " } });
		fireEvent.click(await screen.findByText("Attach Photo →"));

		expect(onPhotosChange.mock.calls[0][0][0]).toMatchObject({ photo_label: "Before", photo_name: "Condenser coil" });
	});

	it("surfaces the server's error message when the upload fails", async () => {
		const headers = new AxiosHeaders();
		mutateAsync.mockRejectedValueOnce(
			new AxiosError("Request failed with status code 400", "ERR_BAD_REQUEST", { headers }, null, {
				status: 400,
				statusText: "Bad Request",
				headers,
				config: { headers },
				data: { success: false, data: null, error: { code: "VALIDATION_ERROR", message: "Image exceeds 5MB" } },
			}),
		);
		render(<NotePhotoPicker jobId="job-1" photos={[]} onPhotosChange={vi.fn()} />);
		pick(fakeFile("a.png", "image/png", 10));
		expect(await screen.findByRole("alert")).toHaveTextContent("Image exceeds 5MB");
	});

	it("falls back to the thrown Error's message, then a generic string", async () => {
		mutateAsync.mockRejectedValueOnce(new Error("Upload failed: storage unavailable"));
		const { unmount } = render(<NotePhotoPicker jobId="job-1" photos={[]} onPhotosChange={vi.fn()} />);
		pick(fakeFile("a.png", "image/png", 10));
		expect(await screen.findByRole("alert")).toHaveTextContent("Upload failed: storage unavailable");
		unmount();

		mutateAsync.mockRejectedValueOnce("weird");
		render(<NotePhotoPicker jobId="job-1" photos={[]} onPhotosChange={vi.fn()} />);
		pick(fakeFile("a.png", "image/png", 10));
		expect(await screen.findByRole("alert")).toHaveTextContent("Upload failed. Please try again.");
	});

	it("defaults capture to the rear camera and can be switched off", () => {
		const { unmount } = render(<NotePhotoPicker jobId="job-1" photos={[]} onPhotosChange={vi.fn()} />);
		expect(fileInput()).toHaveAttribute("capture", "environment");
		unmount();
		render(<NotePhotoPicker jobId="job-1" photos={[]} onPhotosChange={vi.fn()} capture={false} />);
		expect(fileInput()).not.toHaveAttribute("capture");
	});
});
