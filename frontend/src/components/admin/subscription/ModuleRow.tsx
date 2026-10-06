import { useEffect, useRef } from "react";
import { Loader2, Lock } from "lucide-react";
import type { DisablePreview } from "../../../api/entitlements";
import { joinLabels, stateLabel, type Module } from "../../../lib/moduleGroups";
import ToggleSwitch from "../../ui/ToggleSwitch";
import TurnOffPanel from "./TurnOffPanel";

export default function ModuleRow({
	module,
	relations,
	canManage,
	busy,
	preview,
	error,
	onToggle,
	onConfirmOff,
	onClosePanel,
}: {
	module: Module;
	relations: { requires: string[]; missing: string[]; usedBy: string[] };
	canManage: boolean;
	busy: boolean;
	preview: DisablePreview | null;
	error: string | null;
	onToggle: () => void;
	onConfirmOff: () => void;
	onClosePanel: () => void;
}) {
	const control = useRef<HTMLDivElement>(null);
	const on = module.state === "on";
	const inSubscription = module.state !== "not_in_plan";
	const needsFirst = !on && inSubscription && relations.missing.length > 0;
	const relationId = `module-relation-${module.key}`;

	// The focused element unmounts when the panel closes on confirm or on a change
	// from elsewhere, and when the switch gives way to the spinner; without this
	// focus falls to <body>.
	const hadPanel = useRef(false);
	const wasBusy = useRef(false);
	useEffect(() => {
		const released = (hadPanel.current && !preview) || (wasBusy.current && !busy);
		if (released && document.activeElement === document.body) {
			control.current?.querySelector("button")?.focus();
		}
		hadPanel.current = !!preview;
		wasBusy.current = busy;
	}, [preview, busy]);

	const closePanel = () => {
		onClosePanel();
		control.current?.querySelector("button")?.focus();
	};

	return (
		<li className="py-3">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0">
					<span className="block text-sm font-medium text-text-primary">
						{module.label}
					</span>
					<span className="block text-xs text-text-muted">
						{module.description}
					</span>
					{(relations.requires.length > 0 ||
						relations.usedBy.length > 0) && (
						<span
							id={relationId}
							className="mt-0.5 block text-xs text-text-tertiary"
						>
							{relations.requires.length > 0 && (
								<>
									Requires{" "}
									{joinLabels(
										relations.requires
									)}
									.
									{needsFirst &&
										` Turn on ${joinLabels(relations.missing)} first.`}
								</>
							)}
							{relations.requires.length > 0 &&
								relations.usedBy.length > 0 &&
								" "}
							{relations.usedBy.length > 0 && (
								<>
									Used by{" "}
									{joinLabels(
										relations.usedBy
									)}
									.
								</>
							)}
						</span>
					)}
					{error && (
						<span
							role="alert"
							className="mt-1 block text-xs text-error-text"
						>
							{error}
						</span>
					)}
				</div>
				<div ref={control} className="mt-0.5 flex shrink-0 items-center">
					{!inSubscription ? (
						<span className="inline-flex items-center gap-1 text-xs text-text-tertiary">
							<Lock size={12} aria-hidden />
							{stateLabel(module)}
						</span>
					) : !canManage ? (
						<span className="text-xs text-text-secondary">
							{stateLabel(module)}
						</span>
					) : busy ? (
						<span
							role="status"
							className="inline-flex h-5 w-9 items-center justify-center"
						>
							<Loader2
								size={14}
								aria-hidden
								className="animate-spin text-text-tertiary"
							/>
							<span className="sr-only">
								Updating {module.label}
							</span>
						</span>
					) : (
						<ToggleSwitch
							checked={on}
							onChange={onToggle}
							disabled={needsFirst}
							ariaLabel={module.label}
							ariaDescribedBy={
								needsFirst ? relationId : undefined
							}
						/>
					)}
				</div>
			</div>
			{preview && (
				<TurnOffPanel
					module={module}
					preview={preview}
					pending={busy}
					onConfirm={onConfirmOff}
					onClose={closePanel}
				/>
			)}
		</li>
	);
}
