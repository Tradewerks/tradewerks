import { describe, it, expect, vi } from "vitest";

vi.mock("../../db.js", () => ({ db: {} }));

import { provisionOrganization, type Tx } from "../provisionOrganization.js";

function fakeTx(planModules: string[]) {
	const tx = {
		organization: {
			create: vi.fn().mockResolvedValue({ id: "org1", timezone: "UTC" }),
		},
		org_entitlement: { create: vi.fn().mockResolvedValue({}) },
		organization_role: {
			createMany: vi.fn().mockResolvedValue({}),
			create: vi.fn().mockResolvedValue({ id: "role1" }),
		},
		dispatcher: {
			create: vi.fn().mockResolvedValue({ id: "d1", email: "a@b.c" }),
		},
		plan_version: {
			findUnique: vi.fn().mockResolvedValue({ modules: planModules }),
		},
		customer_notification_setting: {
			createMany: vi.fn().mockResolvedValue({}),
		},
	};
	return tx;
}

const input = (businessType: string) => ({
	org: { name: "O", email: "o@o.test" },
	admin: { name: "A", email: "a@b.c", password: "x" },
	businessType,
	planVersionId: "pv",
	source: "signup" as const,
});

describe("new-org customer message defaults", () => {
	it("a newly provisioned org with customer_comms on has email enabled for visit_confirmed, visit_reminder, visit_rescheduled and visit_cancelled, and nothing else", async () => {
		const tx = fakeTx(["customer_comms"]);
		await provisionOrganization(tx as unknown as Tx, input("hvac"));
		const rows =
			tx.customer_notification_setting.createMany.mock.calls[0][0].data;
		expect(rows.map((r: { event: string }) => r.event).sort()).toEqual([
			"visit_cancelled",
			"visit_confirmed",
			"visit_reminder",
			"visit_rescheduled",
		]);
		for (const r of rows) {
			expect(r.organization_id).toBe("org1");
			expect(r.email_enabled).toBe(true);
			expect(r.sms_enabled).toBe(false);
		}
		expect(
			rows.find((r: { event: string }) => r.event === "visit_reminder")
				.config,
		).toEqual({ lead_hours: [24] });
	});

	it("writes no setting rows when customer_comms is off at provisioning", async () => {
		const notInPlan = fakeTx(["quotes"]);
		await provisionOrganization(notInPlan as unknown as Tx, input("hvac"));
		expect(
			notInPlan.customer_notification_setting.createMany,
		).not.toHaveBeenCalled();

		const notChosen = fakeTx(["customer_comms"]);
		await provisionOrganization(
			notChosen as unknown as Tx,
			input("general"),
		);
		expect(
			notChosen.customer_notification_setting.createMany,
		).not.toHaveBeenCalled();
	});

	it("existing orgs get no setting rows", async () => {
		const { readdirSync, readFileSync } = await import("fs");
		const dir = new URL("../../../prisma/migrations/", import.meta.url);
		const touching = readdirSync(dir).filter((d) => {
			try {
				return /INSERT INTO "customer_notification_setting"/i.test(
					readFileSync(new URL(`${d}/migration.sql`, dir), "utf8"),
				);
			} catch {
				return false;
			}
		});
		expect(touching).toEqual([]);
	});
});
