import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", async () => {
	const { createFakeDb } = await import("../../routes/__tests__/harness.js");
	return { db: createFakeDb() };
});
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn(async () => undefined),
	buildChanges: vi.fn(() => ({ content: { old: "a", new: "b" } })),
}));
vi.mock("../../services/wasabiService.js", () => ({
	signImageUrl: vi.fn(async (u: string | null) => (u ? `${u}?signed=1` : null)),
	deleteFile: vi.fn(async () => undefined),
	isOwnBucketUrl: () => true,
}));
vi.mock("../notificationsController.js", () => ({
	createNotification: vi.fn(),
	notifyDispatchers: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../services/socketService.js", () => ({ getSocket: vi.fn(() => ({ emit: vi.fn() })), emitToOrg: vi.fn() }));

import { db } from "../../db.js";
import { deleteFile } from "../../services/wasabiService.js";
import { logActivity } from "../../services/logger.js";
import { updateJobNote, deleteJobNote } from "../jobNotesController.js";
import type { FakeDb } from "../../routes/__tests__/harness.js";

const fake = db as unknown as FakeDb;

const RAW = "https://s3.us-east-1.wasabisys.com/bucket/job-notes-photos/";
const KEEP_ID = "11111111-1111-4111-8111-111111111111";
const GONE_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
	vi.clearAllMocks();
	fake.job_note.findFirst.mockResolvedValue({ id: "note-1", job_id: "job-1", visit_id: null, content: "a", photos: [] });
	fake.job_note.update.mockResolvedValue({});
	fake.job_note_photo.deleteMany.mockResolvedValue({ count: 1 });
	fake.job_note_photo.createMany.mockResolvedValue({ count: 0 });
});

describe("updateJobNote — removed photos are deleted from storage after commit (review P3 / F10)", () => {
	it("deletes the Wasabi objects of photos that were dropped, keeps the ones still referenced", async () => {
		fake.job_note_photo.findMany.mockResolvedValue([
			{ id: KEEP_ID, photo_url: `${RAW}keep.jpg` },
			{ id: GONE_ID, photo_url: `${RAW}gone.jpg` },
		]);

		const result = await updateJobNote(
			"job-1",
			"note-1",
			{ content: "b", photos: [{ id: KEEP_ID, photo_url: `${RAW}keep.jpg?signed=1`, photo_label: "Before" }] },
			"org-1",
			{ dispatcherId: "disp-1" },
		);

		expect(result.err).toBe("");
		expect(fake.job_note_photo.deleteMany.mock.calls[0][0]).toEqual({ where: { id: { in: [GONE_ID] } } });
		expect(deleteFile).toHaveBeenCalledTimes(1);
		expect(deleteFile).toHaveBeenCalledWith(`${RAW}gone.jpg`);
	});

	it("swallows storage errors so the note update still succeeds", async () => {
		fake.job_note_photo.findMany.mockResolvedValue([{ id: GONE_ID, photo_url: `${RAW}gone.jpg` }]);
		vi.mocked(deleteFile).mockRejectedValueOnce(new Error("wasabi down"));

		const result = await updateJobNote("job-1", "note-1", { photos: [] }, "org-1", { dispatcherId: "disp-1" });
		await new Promise((r) => setImmediate(r));

		expect(result.err).toBe("");
		expect(deleteFile).toHaveBeenCalledWith(`${RAW}gone.jpg`);
	});

	it("does not touch storage when photos are not part of the update", async () => {
		const result = await updateJobNote("job-1", "note-1", { content: "b" }, "org-1", { dispatcherId: "disp-1" });
		expect(result.err).toBe("");
		expect(fake.job_note_photo.findMany).not.toHaveBeenCalled();
		expect(deleteFile).not.toHaveBeenCalled();
	});
});

describe("deleteJobNote — stamps the parent breadcrumb (review P2-7 / L2)", () => {
	it("logs job_note.deleted with _parent_type/_parent_id pointing at the job", async () => {
		fake.job_note.delete.mockResolvedValue({});
		const result = await deleteJobNote("job-1", "note-1", "org-1", { techId: "tech-1" });
		expect(result.err).toBe("");
		expect(vi.mocked(logActivity).mock.calls[0][0]).toMatchObject({
			event_type: "job_note.deleted",
			entity_type: "job_note",
			entity_id: "note-1",
			organization_id: "org-1",
			changes: {
				job_id: { old: "job-1", new: null },
				_parent_type: { old: null, new: "job" },
				_parent_id: { old: null, new: "job-1" },
			},
		});
	});
});
