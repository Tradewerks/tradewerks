import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { compress, grabFrame } from "../receiptCapture";

const MB = 1024 * 1024;

function fileOfSize(bytes: number, name: string, type: string) {
	return new File([new Uint8Array(bytes)], name, { type });
}

function blobOfSize(bytes: number) {
	return new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });
}

/** Encoded sizes keyed by the quality the code asks for, in request order. */
function mockCanvas(sizes: Array<number | null>) {
	const asked: number[] = [];
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
		drawImage: vi.fn(),
	} as unknown as CanvasRenderingContext2D);
	vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
		cb: BlobCallback,
		_type?: string,
		quality?: unknown
	) {
		asked.push(quality as number);
		const size = sizes[asked.length - 1] ?? sizes[sizes.length - 1];
		cb(size === null || size === undefined ? null : blobOfSize(size));
	} as typeof HTMLCanvasElement.prototype.toBlob);
	return asked;
}

function mockDecode(ok: boolean) {
	globalThis.createImageBitmap = vi.fn(() =>
		ok
			? Promise.resolve({
					width: 3000,
					height: 4000,
					close: vi.fn(),
				} as unknown as ImageBitmap)
			: Promise.reject(new Error("unsupported format"))
	) as typeof createImageBitmap;
}

beforeEach(() => {
	// lib.dom types ImageCapture as required on Window, so `delete` will not type.
	Reflect.deleteProperty(window, "ImageCapture");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("compress", () => {
	test("passes a non-image through untouched", async () => {
		mockDecode(true);
		const pdf = fileOfSize(64, "invoice.pdf", "application/pdf");
		expect(await compress(pdf)).toBe(pdf);
	});

	test("drops quality until the encode fits under the upload cap", async () => {
		mockDecode(true);
		const asked = mockCanvas([6 * MB, 3 * MB]);
		const out = await compress(fileOfSize(8 * MB, "IMG_1.jpg", "image/jpeg"));

		expect(out.type).toBe("image/jpeg");
		expect(out.size).toBe(3 * MB);
		// Quality falls before pixels do — the receipt keeps its resolution.
		expect(asked.length).toBe(2);
		expect(asked[1]).toBeLessThan(asked[0]);
	});

	test("keeps a gallery original that is already smaller than the re-encode", async () => {
		mockDecode(true);
		mockCanvas([900]);
		const small = fileOfSize(400, "receipt.jpg", "image/jpeg");
		expect(await compress(small)).toBe(small);
	});

	test("returns the original bytes when a JPEG cannot be decoded", async () => {
		mockDecode(false);
		const jpeg = fileOfSize(1024, "receipt.jpg", "image/jpeg");
		expect(await compress(jpeg)).toBe(jpeg);
	});

	test("fails loudly on a HEIC it cannot convert, rather than at upload", async () => {
		mockDecode(false);
		await expect(
			compress(fileOfSize(1024, "IMG_2.HEIC", "image/heic"))
		).rejects.toThrow(/could not be read/i);
	});

	test("converts a decodable HEIC to JPEG even when the result is bigger", async () => {
		mockDecode(true);
		mockCanvas([2 * MB]);
		const out = await compress(fileOfSize(1024, "IMG_3.heic", "image/heic"));
		expect(out.type).toBe("image/jpeg");
		expect(out.name).toBe("IMG_3.jpg");
	});
});

describe("grabFrame", () => {
	const video = { videoWidth: 1200, videoHeight: 1600 } as HTMLVideoElement;
	const track = {} as MediaStreamTrack;

	test("prefers takePhoto, which returns the full sensor resolution", async () => {
		const takePhoto = vi.fn(() => Promise.resolve(blobOfSize(2 * MB)));
		// A class, not vi.fn: an arrow-function mock is not constructible, and the
		// code under test reaches ImageCapture through `new`.
		window.ImageCapture = class {
			takePhoto = takePhoto;
			grabFrame = vi.fn();
		} as unknown as typeof window.ImageCapture;
		const toBlob = mockCanvas([1024]);

		const out = await grabFrame(video, track);
		expect(takePhoto).toHaveBeenCalled();
		expect(out.size).toBe(2 * MB);
		// The preview frame is never touched when the sensor answers.
		expect(toBlob.length).toBe(0);
	});

	test("falls back to the preview frame when takePhoto refuses", async () => {
		window.ImageCapture = class {
			takePhoto = vi.fn(() => Promise.reject(new Error("NotSupportedError")));
			grabFrame = vi.fn();
		} as unknown as typeof window.ImageCapture;
		mockCanvas([1024]);

		const out = await grabFrame(video, track);
		expect(out.type).toBe("image/jpeg");
		expect(out.size).toBe(1024);
	});

	test("throws while the preview has no dimensions yet", async () => {
		mockCanvas([1024]);
		await expect(
			grabFrame({ videoWidth: 0, videoHeight: 0 } as HTMLVideoElement, null)
		).rejects.toThrow(/not ready/i);
	});
});
