import { createElement, useCallback, useRef, useState } from "react";
import { Edit, KeyRound, RotateCcw, Trash2, UserCheck, UserX } from "lucide-react";
import type { DetailMenuGroup, DetailMenuItem } from "../detail/DetailHeader";
import { NO_PERMISSION } from "../lifecycle/actionBuilder";

export type TechnicianActionId =
	| "edit"
	| "reset-password"
	| "reset-mfa"
	| "deactivate"
	| "reactivate"
	| "delete";
export type ArmedConfirm = Exclude<TechnicianActionId, "edit"> | null;

export interface TechnicianActionContext {
	name: string;
	canManage: boolean;
	mfaEnabled: boolean;
	activeVisitCount: number;
	deactivated: boolean;
	armed: ArmedConfirm;
	pending: {
		resetPassword: boolean;
		resetMfa: boolean;
		delete: boolean;
		toggleActive: boolean;
	};
	on: Record<TechnicianActionId, () => void>;
}

const icon = (C: typeof Edit) => createElement(C, { size: 14, "aria-hidden": true });

/**
 * Every item in every state (§6): a dispatcher who sees why delete is shut
 * learns the rule; one who sees a shorter menu learns nothing.
 */
export function technicianMenuGroups(ctx: TechnicianActionContext): DetailMenuGroup[] {
	const perm = ctx.canManage ? undefined : NO_PERMISSION;
	const plural = ctx.activeVisitCount === 1 ? "visit" : "visits";

	const items: DetailMenuItem[] = [
		{
			id: "edit",
			label: "Edit Technician",
			icon: icon(Edit),
			disabled: !!perm,
			disabledReason: perm,
			onSelect: ctx.on.edit,
		},
		{
			id: "reset-password",
			label: ctx.pending.resetPassword
				? "Sending…"
				: ctx.armed === "reset-password"
					? "Press again to send reset email"
					: "Reset Password",
			icon: icon(KeyRound),
			disabled: !!perm || ctx.pending.resetPassword,
			disabledReason: perm,
			keepOpen: true,
			onSelect: ctx.on["reset-password"],
		},
		{
			id: "reset-mfa",
			label: ctx.pending.resetMfa
				? "Resetting…"
				: ctx.armed === "reset-mfa"
					? "Press again to reset MFA"
					: "Reset MFA",
			icon: icon(RotateCcw),
			disabled: !!perm || !ctx.mfaEnabled || ctx.pending.resetMfa,
			disabledReason:
				perm ??
				(ctx.mfaEnabled
					? undefined
					: "MFA isn't enabled for this technician."),
			keepOpen: true,
			onSelect: ctx.on["reset-mfa"],
		},
		ctx.deactivated
			? {
					id: "reactivate",
					label: ctx.pending.toggleActive ? "Reactivating…" : "Reactivate",
					icon: icon(UserCheck),
					disabled: !!perm || ctx.pending.toggleActive,
					disabledReason: perm,
					onSelect: ctx.on.reactivate,
				}
			: {
					id: "deactivate",
					label: ctx.pending.toggleActive
						? "Deactivating…"
						: ctx.armed === "deactivate"
							? "Press again: signs out, removes from scheduling"
							: "Deactivate",
					icon: icon(UserX),
					disabled: !!perm || ctx.activeVisitCount > 0 || ctx.pending.toggleActive,
					disabledReason:
						perm ??
						(ctx.activeVisitCount > 0
							? `${ctx.name} has ${ctx.activeVisitCount} active ${plural}. Complete or reassign them first.`
							: undefined),
					keepOpen: true,
					onSelect: ctx.on.deactivate,
				},
		{
			id: "delete",
			label: ctx.pending.delete
				? "Deleting…"
				: ctx.armed === "delete"
					? "Press again to delete"
					: "Delete Technician",
			icon: icon(Trash2),
			intent: "destructive",
			disabled: !!perm || ctx.activeVisitCount > 0 || ctx.pending.delete,
			disabledReason:
				perm ??
				(ctx.activeVisitCount > 0
					? `${ctx.name} has ${ctx.activeVisitCount} active ${plural}. Complete or reassign them first.`
					: undefined),
			keepOpen: true,
			onSelect: ctx.on.delete,
		},
	];

	return [{ id: "technician", label: "Technician", items }];
}

/** What the page's live region reads when an item arms: the menu label alone
 * ("Press again to delete") doesn't say who it acts on out of context. */
export function armedAnnouncement(armed: ArmedConfirm, name: string): string {
	if (armed === "reset-password") return `Press again to send ${name} a password reset email`;
	if (armed === "reset-mfa") return `Press again to reset MFA for ${name}`;
	if (armed === "delete") return `Press again to delete ${name}`;
	if (armed === "deactivate") return `Press again to deactivate ${name}`;
	return "";
}

// A double-click or key-repeat lands its second activation well inside this, so
// the first press can't arm and fire in one gesture.
export const ARM_GUARD_MS = 400;

/** First activation arms, a second one after ARM_GUARD_MS fires. */
export function useArmedConfirm() {
	const [armed, setArmed] = useState<ArmedConfirm>(null);
	const armedAt = useRef(0);
	const confirm = useCallback(
		(id: Exclude<ArmedConfirm, null>, run: () => Promise<void>) => () => {
			if (armed !== id) {
				armedAt.current = Date.now();
				setArmed(id);
				return;
			}
			if (Date.now() - armedAt.current < ARM_GUARD_MS) return;
			setArmed(null);
			void run();
		},
		[armed]
	);
	const disarm = useCallback(() => setArmed(null), []);
	return { armed, confirm, disarm };
}
