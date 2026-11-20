import { beforeEach, describe, expect, it, vi } from "vitest";

const { cancelJob } = vi.hoisted(() => ({ cancelJob: vi.fn() }));

vi.mock("../../controllers/jobsController.js", () => ({ cancelJob }));
vi.mock("../../controllers/jobVisitsController.js", () => ({
	assignTechniciansToVisit: vi.fn(),
	insertJobVisit: vi.fn(),
	updateJobVisit: vi.fn(),
}));
vi.mock("../../controllers/jobNotesController.js", () => ({ insertJobNote: vi.fn() }));

import { updateJobStatus } from "../tools/scheduling.js";
import { AgentErrorCodes, AgentToolError, type AgentContext } from "../types.js";

const JOB = "7a9e4b21-5c3d-4f8a-9b1e-2c4d6e8f0a1b";
const ctx: AgentContext = {
	userId: "user-1",
	role: "dispatcher",
	organizationId: "org-1",
	permissions: ["edit_jobs"],
	actorType: "dispatcher",
	surface: "assistant",
	userName: "Dana Reyes",
};
const run = (input: unknown) =>
	updateJobStatus.handler({
		input: updateJobStatus.input.parse(input),
		ctx,
		db: {} as never,
	});

beforeEach(() => vi.clearAllMocks());

describe("update_job_status", () => {
	it("is a cancel: edit_jobs only, and only Cancelled with a reason", () => {
		expect(updateJobStatus.title).toBe("Cancel a job");
		expect(updateJobStatus.permissions).toEqual(["edit_jobs"]);
		expect(updateJobStatus.input.safeParse({ job_id: JOB, status: "Completed" }).success).toBe(false);
		expect(
			updateJobStatus.input.safeParse({ job_id: JOB, status: "Cancelled", cancellation_reason: "  " })
				.success,
		).toBe(false);
	});

	it("Cancelled calls cancelJob with the reason", async () => {
		cancelJob.mockResolvedValue({
			err: "",
			item: { id: JOB, job_number: "J-0013", status: "Cancelled" },
		});

		const result = await run({ job_id: JOB, status: "Cancelled", cancellation_reason: "Client moved" });

		expect(cancelJob).toHaveBeenCalledWith(
			JOB,
			"Client moved",
			"org-1",
			expect.objectContaining({ dispatcherId: "user-1" }),
		);
		expect(result).toEqual({ id: JOB, job_number: "J-0013", status: "Cancelled" });
	});

	it("maps a FORBIDDEN refusal by its code, not its wording", async () => {
		cancelJob.mockResolvedValue({ err: "Nope.", code: "FORBIDDEN" });

		const err = await run({ job_id: JOB, status: "Cancelled", cancellation_reason: "x" }).catch((e) => e);

		expect(err).toBeInstanceOf(AgentToolError);
		expect(err.code).toBe(AgentErrorCodes.FORBIDDEN);
	});
});
