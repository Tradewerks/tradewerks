import { describe, expect, it, vi } from "vitest";
import { AxiosError, type AxiosResponse } from "axios";
import * as gateModule from "../taxReviewGate";
import {
	GATED_ACTION_LABEL,
	isQbTaxReviewError,
	isQbTaxZeroError,
	withTaxReviewGate,
	type TaxReviewGate,
} from "../taxReviewGate";
import type { LifecycleAction } from "../../lifecycle/types";

const act = (id: string, over: Partial<LifecycleAction> = {}): LifecycleAction => ({
	id,
	label: id,
	intent: "primary",
	disabled: false,
	onSelect: vi.fn(),
	...over,
});

const gate = (over: Partial<TaxReviewGate> = {}): TaxReviewGate => ({
	needsAck: true,
	canAck: true,
	pending: false,
	acknowledge: vi.fn().mockResolvedValue(undefined),
	onError: vi.fn(),
	...over,
});

const flush = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

describe("withTaxReviewGate", () => {
	it("relabels only enabled send/issue actions", () => {
		const send = act("send");
		const issue = act("issue");
		const disabled = act("send", { disabled: true });
		const hidden = act("issue", { disabled: true, hidden: true });
		const other = act("void");
		const out = withTaxReviewGate([send, issue, disabled, hidden, other], gate());
		expect(out[0].label).toBe(GATED_ACTION_LABEL.send);
		expect(out[1].label).toBe(GATED_ACTION_LABEL.issue);
		expect(out[2]).toBe(disabled);
		expect(out[3]).toBe(hidden);
		expect(out[4]).toBe(other);
	});

	it("acknowledges and then runs the original action", async () => {
		const send = act("send");
		const g = gate();
		withTaxReviewGate([send], g)[0].onSelect();
		expect(send.onSelect).not.toHaveBeenCalled();
		await flush();
		expect(g.acknowledge).toHaveBeenCalledOnce();
		expect(send.onSelect).toHaveBeenCalledOnce();
	});

	it("stops the action and reports the server message when the ack fails", async () => {
		const send = act("send");
		const g = gate({
			acknowledge: vi.fn().mockRejectedValue(
				new AxiosError(
					"Request failed",
					"ERR_BAD_REQUEST",
					undefined,
					undefined,
					{
						status: 403,
						data: { error: { message: "Not allowed" } },
					} as AxiosResponse
				)
			),
		});
		withTaxReviewGate([send], g)[0].onSelect();
		await flush();
		expect(send.onSelect).not.toHaveBeenCalled();
		expect(g.onError).toHaveBeenCalledWith("Not allowed");
	});

	it("returns the same array without the ack permission", () => {
		const actions = [act("send")];
		expect(withTaxReviewGate(actions, gate({ canAck: false }))).toBe(actions);
	});

	it("returns the same array when no ack is needed", () => {
		const actions = [act("send")];
		expect(withTaxReviewGate(actions, gate({ needsAck: false }))).toBe(actions);
	});

	it("disables gated actions while the ack mutation is pending across re-renders", () => {
		const send = act("send");
		const issue = act("issue");
		const other = act("void");
		const out = withTaxReviewGate([send, issue, other], gate({ pending: true }));
		for (const a of out.slice(0, 2)) {
			expect(a.disabled).toBe(true);
			expect(a.disabledReason).toBe("Acknowledging the tax review…");
		}
		expect(out[0].label).toBe(GATED_ACTION_LABEL.send);
		expect(out[1].label).toBe(GATED_ACTION_LABEL.issue);
		expect(out[2]).toBe(other);
	});

	it("ignores re-entry while the acknowledgement is pending", async () => {
		const send = act("send");
		const g = gate();
		const wrapped = withTaxReviewGate([send], g)[0];
		wrapped.onSelect();
		wrapped.onSelect();
		await flush();
		expect(g.acknowledge).toHaveBeenCalledOnce();
		expect(send.onSelect).toHaveBeenCalledOnce();
	});
});

describe("tax refusal errors", () => {
	const axios409 = (code: string) =>
		new AxiosError("Conflict", "ERR_BAD_REQUEST", undefined, undefined, {
			status: 409,
			data: { error: { code, message: "x", details: {} } },
		} as AxiosResponse);

	it("recognises QB_TAX_ZERO and QB_TAX_REVIEW", () => {
		expect(isQbTaxZeroError(axios409("QB_TAX_ZERO"))).toBe(true);
		expect(isQbTaxZeroError(axios409("QB_TAX_REVIEW"))).toBe(false);
		expect(isQbTaxZeroError(new Error("x"))).toBe(false);
		expect(isQbTaxReviewError(axios409("QB_TAX_REVIEW"))).toBe(true);
		expect(isQbTaxReviewError(axios409("QB_TAX_ZERO"))).toBe(false);
	});

	it("no longer exports a taxability block gate", () => {
		const exported = Object.keys(gateModule);
		expect(exported).not.toContain("withTaxBlockGate");
		expect(exported).not.toContain("isTaxBlockedError");
		expect(exported).not.toContain("TAX_BLOCK_LABEL");
		expect(exported).not.toContain("TAX_BLOCK_NO_PERMISSION");
	});
});
