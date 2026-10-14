import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ReceiptScanner from "../ReceiptScanner";

const grabFrame = vi.hoisted(() => vi.fn());
vi.mock("../receiptCapture", () => ({ grabFrame }));

const photo = () => new File([new Uint8Array(32)], "receipt.jpg", { type: "image/jpeg" });

function fakeCamera() {
	const track = {
		stop: vi.fn(),
		addEventListener: vi.fn(),
		applyConstraints: vi.fn(() => Promise.resolve()),
		getSettings: () => ({}),
	};
	const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: { getUserMedia: vi.fn(() => Promise.resolve(stream)) },
	});
	HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
}

beforeEach(() => {
	grabFrame.mockReset();
	grabFrame.mockResolvedValue(photo());
	URL.createObjectURL = vi.fn(() => "blob:receipt");
	URL.revokeObjectURL = vi.fn();
	// The default: jsdom has no camera, which is also the desktop dispatcher case.
	Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

afterEach(() => {
	vi.restoreAllMocks();
});

async function pickFromGallery(container: HTMLElement) {
	const input = container.querySelector("input[type=file]") as HTMLInputElement;
	await userEvent.upload(input, photo());
}

describe("ReceiptScanner without a camera", () => {
	test("explains why and makes choosing a photo the primary way out", async () => {
		render(<ReceiptScanner onAccept={vi.fn()} onClose={vi.fn()} />);

		expect(await screen.findByText(/camera/i)).toHaveTextContent(
			/choose a photo instead/i
		);
		expect(screen.getByRole("button", { name: "Choose a photo" })).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Take photo" })
		).not.toBeInTheDocument();
	});

	test("a gallery pick still lands on the review step", async () => {
		const { container } = render(
			<ReceiptScanner onAccept={vi.fn()} onClose={vi.fn()} />
		);
		await pickFromGallery(container);

		expect(await screen.findByText("Check the photo")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /retake/i })).toBeInTheDocument();
	});
});

describe("ReceiptScanner review step", () => {
	test("hands the accepted photo up and never uploads before the tech confirms", async () => {
		const onAccept = vi.fn((_file: File) => Promise.resolve());
		const { container } = render(
			<ReceiptScanner onAccept={onAccept} onClose={vi.fn()} />
		);
		await pickFromGallery(container);

		expect(onAccept).not.toHaveBeenCalled();
		await userEvent.click(await screen.findByRole("button", { name: /use photo/i }));
		await waitFor(() => expect(onAccept).toHaveBeenCalledTimes(1));
		expect(onAccept.mock.calls[0][0]).toBeInstanceOf(File);
	});

	test("a failed upload keeps the photo in hand with the reason shown", async () => {
		const onAccept = vi.fn(() =>
			Promise.reject(new Error("Receipt already submitted"))
		);
		const { container } = render(
			<ReceiptScanner onAccept={onAccept} onClose={vi.fn()} />
		);
		await pickFromGallery(container);
		await userEvent.click(await screen.findByRole("button", { name: /use photo/i }));

		expect(await screen.findByText("Receipt already submitted")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /retake/i })).toBeInTheDocument();
	});

	test("retake goes back to the capture step", async () => {
		const { container } = render(
			<ReceiptScanner onAccept={vi.fn()} onClose={vi.fn()} />
		);
		await pickFromGallery(container);
		await userEvent.click(await screen.findByRole("button", { name: /retake/i }));

		expect(screen.queryByText("Check the photo")).not.toBeInTheDocument();
	});

	test("the confirm label follows the entry point", async () => {
		const { container } = render(
			<ReceiptScanner
				onAccept={vi.fn()}
				onClose={vi.fn()}
				confirmLabel="Start purchase"
			/>
		);
		await pickFromGallery(container);
		expect(
			await screen.findByRole("button", { name: /start purchase/i })
		).toBeInTheDocument();
	});
});

describe("ReceiptScanner with a camera", () => {
	test("the shutter captures a frame and moves to review", async () => {
		fakeCamera();
		render(<ReceiptScanner onAccept={vi.fn()} onClose={vi.fn()} />);

		const shutter = await screen.findByRole("button", { name: "Take photo" });
		await waitFor(() => expect(shutter).toBeEnabled());
		await userEvent.click(shutter);

		expect(grabFrame).toHaveBeenCalledTimes(1);
		expect(await screen.findByText("Check the photo")).toBeInTheDocument();
	});

	test("a frame grab failure stays on the camera with the reason", async () => {
		fakeCamera();
		grabFrame.mockRejectedValue(new Error("The camera is not ready yet — try again."));
		render(<ReceiptScanner onAccept={vi.fn()} onClose={vi.fn()} />);

		const shutter = await screen.findByRole("button", { name: "Take photo" });
		await waitFor(() => expect(shutter).toBeEnabled());
		await userEvent.click(shutter);

		expect(await screen.findByText(/not ready yet/i)).toBeInTheDocument();
		expect(screen.queryByText("Check the photo")).not.toBeInTheDocument();
	});
});
