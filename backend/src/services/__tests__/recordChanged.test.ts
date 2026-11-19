import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const { emitToOrg, getSocket, dbMock } = vi.hoisted(() => ({
	emitToOrg: vi.fn(),
	getSocket: vi.fn(() => {
		throw new Error("Socket.io not initialized");
	}),
	dbMock: {
		log: {
			create: vi.fn(
				async ({ data }: { data: Record<string, unknown> }) => ({
					id: "log-1",
					...data,
				}),
			),
		},
		technician: { findUnique: vi.fn() },
		dispatcher: { findUnique: vi.fn() },
		client: { findUnique: vi.fn() },
	},
}));

vi.mock("../socketService.js", () => ({ emitToOrg, getSocket }));
vi.mock("../../db.js", () => ({ db: dbMock }));

import {
	changeBufferMiddleware,
	recordChanged,
	runWithChangeBuffer,
} from "../recordChanged.js";
import { logActivity } from "../logger.js";

const ORG = "org-1";

const fakeRes = (statusCode = 200, writableEnded = true) => {
	const res = new EventEmitter() as EventEmitter & {
		statusCode: number;
		writableEnded: boolean;
	};
	res.statusCode = statusCode;
	res.writableEnded = writableEnded;
	return res;
};

// Runs `body` inside the middleware's request context, then returns the res
// so the test decides when (and with which status) the response finishes.
const inRequest = async (
	body: () => Promise<void> | void,
	statusCode = 200,
	writableEnded = true,
) => {
	const res = fakeRes(statusCode, writableEnded);
	let done!: Promise<void>;
	const next: NextFunction = () => {
		done = Promise.resolve(body());
	};
	changeBufferMiddleware({} as Request, res as unknown as Response, next);
	await done;
	return res;
};

const recordEmits = () =>
	emitToOrg.mock.calls.filter(([, event]) => event === "record:changed");

beforeEach(() => {
	emitToOrg.mockReset();
	dbMock.log.create.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("record:changed buffer", () => {
	it("buffers inside a request and emits nothing until res finish", async () => {
		const res = await inRequest(() => {
			recordChanged(ORG, "visit", "v1", "j1");
		});
		expect(recordEmits()).toHaveLength(0);
		res.emit("finish");
		expect(recordEmits()).toEqual([
			[ORG, "record:changed", { type: "visit", id: "v1", jobId: "j1" }],
		]);
	});

	it("flushes deduped events once on finish with status 200", async () => {
		const res = await inRequest(() => {
			recordChanged(ORG, "visit", "v1");
			recordChanged(ORG, "visit", "v1", "j1");
			recordChanged(ORG, "job", "j1");
			recordChanged(ORG, "job", "j1");
		});
		res.emit("finish");
		expect(recordEmits()).toEqual([
			[ORG, "record:changed", { type: "visit", id: "v1", jobId: "j1" }],
			[ORG, "record:changed", { type: "job", id: "j1" }],
		]);
		res.emit("finish");
		expect(recordEmits()).toHaveLength(2);
	});

	it.each([404, 409, 500])(
		"does not flush when the response status is 4xx/5xx (%i)",
		async (status) => {
			const res = await inRequest(() => {
				recordChanged(ORG, "job", "j1");
			}, status);
			res.emit("finish");
			expect(recordEmits()).toHaveLength(0);
		},
	);

	it("close without finish after res.end with 200 still emits, once", async () => {
		const res = await inRequest(() => {
			recordChanged(ORG, "job", "j1");
		});
		res.emit("close");
		res.emit("finish");
		expect(recordEmits()).toEqual([
			[ORG, "record:changed", { type: "job", id: "j1" }],
		]);
	});

	it("close without res.end hands buffered events to the timed path, once", async () => {
		vi.useFakeTimers();
		const res = await inRequest(
			() => {
				recordChanged(ORG, "job", "j1");
			},
			200,
			false,
		);
		res.emit("close");
		res.emit("finish");
		expect(recordEmits()).toHaveLength(0);
		vi.advanceTimersByTime(300);
		expect(recordEmits()).toEqual([
			[ORG, "record:changed", { type: "job", id: "j1" }],
		]);
		vi.advanceTimersByTime(1000);
		expect(recordEmits()).toHaveLength(1);
	});

	it("an event recorded after an abort-before-end emits after 300ms", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let late!: Promise<void>;
		const res = await inRequest(
			() => {
				late = gate.then(() => recordChanged(ORG, "visit", "v7"));
			},
			200,
			false,
		);
		res.emit("close");
		release();
		await late;
		vi.advanceTimersByTime(299);
		expect(recordEmits()).toHaveLength(0);
		vi.advanceTimersByTime(1);
		expect(recordEmits()).toEqual([
			[ORG, "record:changed", { type: "visit", id: "v7" }],
		]);
	});

	it.each([
		[200, 1],
		[500, 0],
	])(
		"late fire-and-forget after a %i response emits %i time(s) via the timed path",
		async (status, expected) => {
			vi.useFakeTimers();
			let release!: () => void;
			const gate = new Promise<void>((r) => (release = r));
			let late!: Promise<void>;
			const res = await inRequest(() => {
				late = gate.then(() => recordChanged(ORG, "quote", "q1"));
			}, status);
			res.emit("finish");
			release();
			await late;
			expect(recordEmits()).toHaveLength(0);
			vi.advanceTimersByTime(300);
			expect(recordEmits()).toHaveLength(expected);
		},
	);

	it("outside a request, coalesces repeats and emits once after 300ms", () => {
		vi.useFakeTimers();
		recordChanged(ORG, "visit", "v1");
		vi.advanceTimersByTime(100);
		recordChanged(ORG, "visit", "v1");
		recordChanged(ORG, "job", "j9");
		vi.advanceTimersByTime(199);
		expect(recordEmits()).toHaveLength(0);
		vi.advanceTimersByTime(1);
		expect(recordEmits()).toEqual([
			[ORG, "record:changed", { type: "visit", id: "v1" }],
			[ORG, "record:changed", { type: "job", id: "j9" }],
		]);
		vi.advanceTimersByTime(1000);
		expect(recordEmits()).toHaveLength(2);
	});

	it("runWithChangeBuffer flushes after fn resolves, not before", async () => {
		const result = await runWithChangeBuffer(async () => {
			recordChanged(ORG, "invoice", "i1");
			expect(recordEmits()).toHaveLength(0);
			return 7;
		});
		expect(result).toBe(7);
		expect(recordEmits()).toEqual([
			[ORG, "record:changed", { type: "invoice", id: "i1" }],
		]);
	});

	it("runWithChangeBuffer discards the buffer when fn rejects", async () => {
		await expect(
			runWithChangeBuffer(async () => {
				recordChanged(ORG, "invoice", "i1");
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(recordEmits()).toHaveLength(0);
	});
});

describe("logActivity → record:changed", () => {
	const base = {
		action: "updated",
		organization_id: ORG,
		actor_type: "system",
	};

	it('logActivity for entity_type job_visit enqueues {type:"visit", id}', async () => {
		const res = await inRequest(async () => {
			await logActivity({
				...base,
				event_type: "job_visit.updated",
				entity_type: "job_visit",
				entity_id: "v1",
				changes: {
					_parent_type: { old: null, new: "job" },
					_parent_id: { old: null, new: "j1" },
				},
			});
			await logActivity({
				...base,
				event_type: "job_visit.updated",
				entity_type: "job_visit",
				entity_id: "v2",
			});
		});
		res.emit("finish");
		expect(recordEmits()).toEqual([
			[ORG, "record:changed", { type: "visit", id: "v1", jobId: "j1" }],
			[ORG, "record:changed", { type: "visit", id: "v2" }],
		]);
	});

	it("logActivity for quote_line_item enqueues the parent quote id, and skips when the breadcrumb is missing", async () => {
		const res = await inRequest(async () => {
			await logActivity({
				...base,
				event_type: "quote_line_item.deleted",
				entity_type: "quote_line_item",
				entity_id: "li1",
				changes: {
					_parent_type: { old: null, new: "quote" },
					_parent_id: { old: null, new: "q1" },
				},
			});
			await logActivity({
				...base,
				event_type: "quote_line_item.updated",
				entity_type: "quote_line_item",
				entity_id: "li2",
				changes: { quantity: { old: 1, new: 2 } },
			});
		});
		res.emit("finish");
		expect(recordEmits()).toEqual([
			[ORG, "record:changed", { type: "quote", id: "q1" }],
		]);
	});

	it("skips a child row whose _parent_type disagrees with its record type", async () => {
		const res = await inRequest(async () => {
			await logActivity({
				...base,
				event_type: "quote_line_item.deleted",
				entity_type: "quote_line_item",
				entity_id: "li1",
				changes: {
					_parent_type: { old: null, new: "job" },
					_parent_id: { old: null, new: "j1" },
				},
			});
		});
		res.emit("finish");
		expect(recordEmits()).toHaveLength(0);
	});

	it("a customer_message.* log on job_visit enqueues nothing; job_visit.updated still does", async () => {
		const res = await inRequest(async () => {
			for (const status of ["sent", "failed", "unknown"]) {
				await logActivity({
					...base,
					action: status,
					event_type: `customer_message.${status}`,
					entity_type: "job_visit",
					entity_id: "v1",
				});
			}
			await logActivity({
				...base,
				event_type: "job_visit.updated",
				entity_type: "job_visit",
				entity_id: "v2",
			});
		});
		res.emit("finish");
		expect(recordEmits()).toEqual([
			[ORG, "record:changed", { type: "visit", id: "v2" }],
		]);
	});

	it("ignores unmapped entity types and rows without an org", async () => {
		const res = await inRequest(async () => {
			await logActivity({
				...base,
				event_type: "vehicle.updated",
				entity_type: "vehicle",
				entity_id: "veh1",
			});
			await logActivity({
				...base,
				organization_id: null,
				event_type: "job.updated",
				entity_type: "job",
				entity_id: "j1",
			});
		});
		res.emit("finish");
		expect(recordEmits()).toHaveLength(0);
	});

	it("a socket that is not initialized never throws out of logActivity", async () => {
		emitToOrg.mockImplementation(() => {
			throw new Error("Socket.io not initialized");
		});
		vi.useFakeTimers();
		await expect(
			logActivity({
				...base,
				event_type: "job.updated",
				entity_type: "job",
				entity_id: "j1",
			}),
		).resolves.toBeUndefined();
		expect(() => vi.advanceTimersByTime(300)).not.toThrow();
		expect(emitToOrg).toHaveBeenCalledTimes(1);

		const res = await inRequest(async () => {
			await logActivity({
				...base,
				event_type: "job.updated",
				entity_type: "job",
				entity_id: "j2",
			});
		});
		expect(() => res.emit("finish")).not.toThrow();
	});
});
