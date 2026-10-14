import { useEffect, useState } from "react";
import Drawer from "../../components/ui/Drawer";
import { FormErrorBanner } from "../../components/ui/forms/FormErrorBanner";
import { LIMIT_KEYS, LIMIT_LABELS } from "../limits";
import { fromDraft, sameContents, toDraft, type Draft } from "../tierForm";
import { primaryButton, smallButton } from "./orgDetailUi";
import { noteReady } from "../notes";
import { toggled } from "../../lib/toggled";
import type { CatalogModule, TierContents } from "../types";

const input =
	"h-8 w-full rounded-md border border-border bg-surface px-2 text-sm text-text-primary placeholder:text-text-tertiary";
const heading = "text-xs font-medium uppercase tracking-wide text-text-tertiary";

export default function TierContentsForm({
	open,
	mode,
	title,
	catalog,
	initial,
	pending,
	error,
	onSubmit,
	onClose,
}: {
	open: boolean;
	mode: "create" | "version";
	title: string;
	catalog: CatalogModule[];
	initial: TierContents | null;
	pending: boolean;
	error: string | null;
	onSubmit: (v: TierContents & { note: string; key?: string; label?: string }) => void;
	onClose: () => void;
}) {
	const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
	const [note, setNote] = useState("");
	const [key, setKey] = useState("");
	const [label, setLabel] = useState("");

	// Reset on content, not identity: parents rebuild `initial` each render, and a reset
	// mid-save would wipe the edits the server is about to judge.
	const initialKey = JSON.stringify(initial);
	useEffect(() => {
		if (!open) return;
		setDraft(toDraft(JSON.parse(initialKey) as TierContents | null));
		setNote("");
		setKey("");
		setLabel("");
	}, [open, initialKey]);

	const parsed = fromDraft(draft);
	const unchanged = mode === "version" && sameContents(initial, parsed.contents);
	const ready =
		!!parsed.contents &&
		!unchanged &&
		noteReady(note) &&
		(mode === "version" || (key.trim().length >= 2 && label.trim().length >= 1));

	const toggle = (k: string) => setDraft((d) => ({ ...d, modules: toggled(d.modules, k) }));
	const groups = [
		{ title: "Paid features", items: catalog.filter((m) => m.kind === "plan_gated") },
		{ title: "Optional modules", items: catalog.filter((m) => m.kind === "optional") },
	];
	const submit = () =>
		parsed.contents &&
		onSubmit({
			...parsed.contents,
			note: note.trim(),
			...(mode === "create" && { key: key.trim(), label: label.trim() }),
		});

	return (
		<Drawer
			isOpen={open}
			onClose={onClose}
			title={title}
			footer={
				<div className="flex justify-end gap-2">
					<button
						type="button"
						className={smallButton}
						onClick={onClose}
					>
						Cancel
					</button>
					<button
						type="button"
						disabled={!ready || pending}
						onClick={submit}
						className={primaryButton}
					>
						{mode === "create"
							? "Create tier"
							: "Save new version"}
					</button>
				</div>
			}
		>
			<div className="space-y-4">
				{error && <FormErrorBanner message={error} />}
				{mode === "create" && (
					<div className="grid grid-cols-2 gap-3">
						<label className="space-y-1 text-sm">
							<span className={heading}>Key</span>
							<input
								className={input}
								value={key}
								onChange={(e) =>
									setKey(e.target.value)
								}
								placeholder="pro_plus"
							/>
						</label>
						<label className="space-y-1 text-sm">
							<span className={heading}>Label</span>
							<input
								className={input}
								value={label}
								onChange={(e) =>
									setLabel(e.target.value)
								}
								placeholder="Pro Plus"
							/>
						</label>
					</div>
				)}
				{groups.map((g) => (
					<fieldset key={g.title} className="space-y-1">
						<legend className={heading}>{g.title}</legend>
						{g.items.map((m) => (
							<label
								key={m.key}
								className="flex items-center gap-2 text-sm text-text-primary"
							>
								<input
									type="checkbox"
									checked={draft.modules.has(
										m.key
									)}
									onChange={() =>
										toggle(m.key)
									}
								/>
								{m.label}
							</label>
						))}
					</fieldset>
				))}
				<fieldset className="space-y-2">
					<legend className={heading}>
						Limits (blank = unlimited)
					</legend>
					<div className="grid grid-cols-2 gap-3">
						{LIMIT_KEYS.map((k) => (
							<label
								key={k}
								className="space-y-1 text-sm"
							>
								<span className="text-xs text-text-secondary">
									{LIMIT_LABELS[k]}
								</span>
								<input
									className={input}
									inputMode="numeric"
									aria-label={LIMIT_LABELS[k]}
									placeholder="Unlimited"
									value={draft.limits[k]}
									onChange={(e) =>
										setDraft((d) => ({
											...d,
											limits: {
												...d.limits,
												[k]: e
													.target
													.value,
											},
										}))
									}
								/>
							</label>
						))}
					</div>
					{parsed.error && (
						<p className="text-xs text-error-text">
							{parsed.error}
						</p>
					)}
					{unchanged && (
						<p className="text-xs text-text-tertiary">
							Change a module or a limit to save a new
							version.
						</p>
					)}
				</fieldset>
				<label className="block space-y-1 text-sm">
					<span className={heading}>
						Note (required, kept in history)
					</span>
					<textarea
						className={`${input} h-20 py-1`}
						value={note}
						onChange={(e) => setNote(e.target.value)}
						placeholder="Why this version exists"
					/>
				</label>
			</div>
		</Drawer>
	);
}
