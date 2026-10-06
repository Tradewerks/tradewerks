/**
 * Runtime smoke test for the followups feature against a REAL Postgres (the dev
 * sandbox), exercising the actual Prisma queries the scheduler + webhook run —
 * not mocks. Run with:
 *   DATABASE_URL=postgresql://hvac_user:hvac_pass@localhost:5433/hvac_db npx tsx scripts/followupsSmoke.ts
 * EMAIL_DISABLED is true, so sends are logged + recorded with a synthetic MessageID.
 */
import { db } from "../src/db.js";
import { runDueFollowups } from "../src/services/followupScheduler.js";
import { handlePostmarkWebhook } from "../src/services/postmarkWebhook.js";

function assert(cond: unknown, msg: string): void {
	if (!cond) throw new Error("ASSERT FAILED: " + msg);
	console.log("  ✓ " + msg);
}

async function main() {
	const tag = "smoke-" + Math.floor(Date.now() / 1000);

	// ── Seed ────────────────────────────────────────────────────────────────
	const org = await db.organization.create({
		data: { name: tag + "-org", brand_color: "#123456" },
	});
	const client = await db.client.create({
		data: { name: tag + "-client", address: "1 Test St", coords: {}, organization_id: org.id },
	});
	const contact = await db.contact.create({
		data: { name: "Primary", email: tag + "@example.com", organization_id: org.id },
	});
	await db.client_contact.create({
		data: { client_id: client.id, contact_id: contact.id, is_primary: true },
	});
	const sequence = await db.followup_sequence.create({
		data: {
			organization_id: org.id,
			name: tag + "-seq",
			trigger_type: "manual",
			stop_on_open: true,
			steps: {
				create: [
					{ step_order: 1, category: "followup", delay_amount: 0, delay_unit: "days", condition: "always" },
					{ step_order: 2, category: "followup", delay_amount: 3, delay_unit: "days", condition: "if_previous_not_opened" },
				],
			},
		},
	});
	const enrollment = await db.followup_enrollment.create({
		data: {
			organization_id: org.id,
			sequence_id: sequence.id,
			client_id: client.id,
			recipient_email: contact.email!,
			status: "active",
			current_step_order: 0,
			next_send_at: new Date(Date.now() - 60_000), // due now
		},
	});

	console.log("\n[1] Scheduler sends step 1 and advances (2-step sequence → not completed)");
	await runDueFollowups();
	let e = await db.followup_enrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
	const sends = await db.followup_send.findMany({ where: { enrollment_id: enrollment.id } });
	assert(sends.length === 1, "one followup_send row recorded");
	assert(sends[0].status === "sent", "send status is 'sent'");
	assert(!!sends[0].postmark_message_id, "send has a message id (synthetic in disabled mode)");
	assert(e.current_step_order === 1, "enrollment advanced to step 1");
	assert(e.status === "active" && !!e.next_send_at, "still active with step 2 scheduled");

	console.log("\n[2] Open webhook marks opened + completes (stop_on_open)");
	const req: any = {
		body: { RecordType: "Open", MessageID: sends[0].postmark_message_id, ReceivedAt: new Date().toISOString() },
		query: {},
		headers: {},
	};
	const res: any = { status: () => res, json: () => res };
	await handlePostmarkWebhook(req, res);
	const send = await db.followup_send.findUniqueOrThrow({ where: { id: sends[0].id } });
	e = await db.followup_enrollment.findUniqueOrThrow({ where: { id: enrollment.id } });
	assert(!!send.opened_at, "send.opened_at set by webhook");
	assert(send.open_count === 1, "open_count incremented");
	assert(e.status === "completed", "enrollment completed on open (stop_on_open)");
	assert(e.stop_reason === "recipient_opened", "stop_reason recorded");

	console.log("\n[3] A completed enrollment is no longer due");
	const before = await db.followup_send.count({ where: { enrollment_id: enrollment.id } });
	await runDueFollowups();
	const after = await db.followup_send.count({ where: { enrollment_id: enrollment.id } });
	assert(before === after, "no further sends after completion");

	// ── Cleanup ───────────────────────────────────────────────────────────────
	await db.followup_send.deleteMany({ where: { enrollment_id: enrollment.id } });
	await db.followup_enrollment.deleteMany({ where: { sequence_id: sequence.id } });
	await db.followup_step.deleteMany({ where: { sequence_id: sequence.id } });
	await db.followup_sequence.delete({ where: { id: sequence.id } });
	await db.client_contact.deleteMany({ where: { client_id: client.id } });
	await db.contact.delete({ where: { id: contact.id } });
	await db.client.delete({ where: { id: client.id } });
	await db.organization.delete({ where: { id: org.id } });

	console.log("\n✅ Followups runtime smoke test PASSED");
	await db.$disconnect();
}

main().catch(async (err) => {
	console.error("\n❌ SMOKE TEST FAILED:", err);
	await db.$disconnect();
	process.exit(1);
});
