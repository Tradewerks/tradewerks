import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Code2, Info, Loader2, Monitor, RotateCcw, Smartphone, X } from "lucide-react";
import FullPopup from "../ui/FullPopup";
import { renderTemplate, extractVariables } from "../../lib/renderTemplate";
import { smsSegments } from "../../lib/smsSegments";
import { EmailTemplateCategoryLabels, type EmailTemplateCategory } from "../../types/followups";
import type { EmailTemplate, TemplatePreviewContext } from "../../types/emailTemplates";
import { LABEL, INPUT, TEXTAREA } from "./shared";

// Friendly labels + grouping for the known template variables. Unknown tokens
// (anything the org adds to the HTML) still get a field, labelled by their raw name.
const VAR_META: Record<string, { label: string; group: "brand" | "content"; hint?: string }> = {
	"brand.name": { label: "Company name", group: "brand" },
	"brand.logo_url": {
		label: "Logo URL",
		group: "brand",
		hint: "Auto-filled from your uploaded company logo",
	},
	"brand.color": { label: "Brand color", group: "brand" },
	"brand.address": { label: "Address", group: "brand" },
	"brand.phone": { label: "Phone", group: "brand" },
	"brand.website": { label: "Website", group: "brand" },
	"brand.reply_to": {
		label: "Reply-to email",
		group: "brand",
		hint: "Customer messages only; blank when the organization has no valid email",
	},
	"brand.review_url": {
		label: "Review link",
		group: "brand",
		hint: "Review requests only; set in Admin → Customer messages",
	},
	client_name: { label: "Client name", group: "content" },
	anchor_type: { label: "Anchor type", group: "content" },
	unsubscribe_url: {
		label: "Unsubscribe link",
		group: "content",
		hint: "Filled per recipient at send time",
	},
	"visit.date": { label: "Visit date", group: "content", hint: "Visit reminders only" },
	"visit.window": { label: "Arrival window", group: "content", hint: "Visit reminders only" },
	"visit.address": { label: "Visit address", group: "content", hint: "Visit reminders only" },
	"visit.job_title": { label: "Job title", group: "content", hint: "Visit reminders only" },
	"visit.name": { label: "Visit name", group: "content", hint: "Visit messages only" },
	"visit.description": {
		label: "Visit description",
		group: "content",
		hint: "Visit messages only; may be long, so keep it out of texts",
	},
	"visit.tech_names": {
		label: "Technician names",
		group: "content",
		hint: "Visit reminders only",
	},
	"visit.tech_first_name": {
		label: "First technician",
		group: "content",
		hint: "Visit reminders only",
	},
	"visit.eta": {
		label: "Arrival estimate",
		group: "content",
		hint: "On-my-way messages only; blank when no estimate is available",
	},
	"tech.name": {
		label: "Driving technician",
		group: "content",
		hint: "Visit reminders only",
	},
	"tech.title": {
		label: "Technician title",
		group: "content",
		hint: "Visit reminders only",
	},
	"tech.photo_url": {
		label: "Technician photo",
		group: "content",
		hint: "Email only; blank when the technician has no photo",
	},
	"link.visit": {
		label: "Appointment link",
		group: "content",
		hint: "Customer visit messages only; filled per recipient at send time",
	},
};

// Preview-only stand-ins; real values come from the visit at send time.
const VISIT_SAMPLES: Record<string, string> = {
	"visit.date": "Tuesday, November 17",
	"visit.window": "between 8:00 AM and 10:00 AM",
	"visit.address": "123 Main St",
	"visit.job_title": "Furnace tune-up",
	"visit.name": "Annual furnace tune-up",
	"visit.description": "Cleaned the burners and replaced the filter.",
	"visit.tech_names": "Ann and Bob",
	"visit.tech_first_name": "Ann",
	"visit.eta": "3:30 PM",
	"tech.name": "Ann Lee",
	"tech.title": "Lead Technician",
};

// The standard variables offered as one-click "insert" chips in the HTML editor.
const INSERTABLE_VARS = [
	"client_name",
	"brand.name",
	"brand.logo_url",
	"brand.color",
	"brand.address",
	"brand.phone",
	"brand.website",
	"brand.reply_to",
	"unsubscribe_url",
	...Object.keys(VISIT_SAMPLES),
];

/** Flatten the preview context into the flat, dotted-key value map the form edits. */
function flattenContext(ctx: TemplatePreviewContext): Record<string, string> {
	return {
		"brand.name": ctx.brand.name ?? "",
		"brand.logo_url": ctx.brand.logo_url ?? "",
		"brand.color": ctx.brand.color ?? "",
		"brand.address": ctx.brand.address ?? "",
		"brand.phone": ctx.brand.phone ?? "",
		"brand.website": ctx.brand.website ?? "",
		"brand.reply_to": ctx.brand.reply_to ?? "",
		client_name: ctx.samples.client_name ?? "",
		anchor_type: ctx.samples.anchor_type ?? "",
		unsubscribe_url: "https://example.com/unsubscribe",
		"link.visit": "https://example.com/app/c/sample",
		...VISIT_SAMPLES,
	};
}

/** Rebuild the nested render model ({ brand: {...}, client_name, ... }) from flat keys. */
function buildModel(values: Record<string, string>): Record<string, unknown> {
	const model: Record<string, unknown> = {};
	for (const [path, value] of Object.entries(values)) {
		const keys = path.split(".");
		let cur = model;
		keys.forEach((key, i) => {
			if (i === keys.length - 1) {
				cur[key] = value;
			} else {
				if (typeof cur[key] !== "object" || cur[key] === null)
					cur[key] = {};
				cur = cur[key] as Record<string, unknown>;
			}
		});
	}
	return model;
}

interface TemplateEditorModalProps {
	template: EmailTemplate;
	context?: TemplatePreviewContext;
	readOnly: boolean;
	isPending: boolean;
	onClose: () => void;
	onSave: (data: {
		name: string;
		subject: string;
		html: string;
		text: string;
		sms_body?: string;
	}) => Promise<void>;
	onReset: () => Promise<void>;
	/** Shows the text-message body field (customer-message templates only). */
	withSms?: boolean;
	categoryLabel?: string;
}

export default function TemplateEditorModal({
	template,
	context,
	readOnly,
	isPending,
	onClose,
	onSave,
	onReset,
	withSms = false,
	categoryLabel,
}: TemplateEditorModalProps) {
	const [name, setName] = useState(template.name);
	const [subject, setSubject] = useState(template.subject);
	const [html, setHtml] = useState(template.html);
	const [text, setText] = useState(template.text ?? "");
	const [sms, setSms] = useState(template.sms_body ?? "");
	const [values, setValues] = useState<Record<string, string>>(() =>
		context ? flattenContext(context) : {}
	);
	// If the preview context resolves after the modal opened, seed the form once.
	const seeded = useRef(!!context);
	useEffect(() => {
		if (context && !seeded.current) {
			setValues(flattenContext(context));
			seeded.current = true;
		}
	}, [context]);

	const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
	const [previewMode, setPreviewMode] = useState<"html" | "text">("html");
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [resetting, setResetting] = useState(false);
	const htmlRef = useRef<HTMLTextAreaElement>(null);
	const previewRef = useRef<HTMLIFrameElement>(null);
	const [previewHeight, setPreviewHeight] = useState(560);

	// Variables the template actually references (subject + HTML + text), deduped in order.
	const templateVars = useMemo(
		() => extractVariables(`${subject}\n${html}\n${text}${withSms ? `\n${sms}` : ""}`),
		[subject, html, text, sms, withSms]
	);

	// The render model: every referenced variable, prefilled from context where known.
	const model = useMemo(() => {
		const merged: Record<string, string> = {};
		for (const key of templateVars) merged[key] = values[key] ?? "";
		return buildModel({ ...values, ...merged });
	}, [values, templateVars]);

	const renderedSubject = useMemo(
		() => renderTemplate(subject, model, { escape: false }),
		[subject, model]
	);
	const renderedHtml = useMemo(() => renderTemplate(html, model), [html, model]);
	const renderedText = useMemo(
		() => renderTemplate(text, model, { escape: false }),
		[text, model]
	);

	const renderedSms = useMemo(
		() => renderTemplate(sms, model, { escape: false }),
		[sms, model]
	);
	const smsInfo = useMemo(() => smsSegments(renderedSms), [renderedSms]);

	// Debounce the doc fed to the iframe so fast typing doesn't thrash reloads.
	const [previewDoc, setPreviewDoc] = useState(renderedHtml);
	useEffect(() => {
		const id = setTimeout(() => setPreviewDoc(renderedHtml), 120);
		return () => clearTimeout(id);
	}, [renderedHtml]);

	// Size the preview to its content so the email is never clipped — the pane
	// (desktop) or the modal body (mobile) scrolls instead.
	const measurePreview = useCallback(() => {
		try {
			const doc = previewRef.current?.contentDocument;
			const h = doc?.body?.scrollHeight;
			if (h && h > 200) setPreviewHeight(h + 8);
		} catch {
			/* cross-origin guard — never happens for srcDoc, but stay safe */
		}
	}, []);

	// Re-measure after the doc changes or the preview width toggles (a width change
	// reflows the email taller without reloading the iframe, so onLoad won't fire).
	useEffect(() => {
		const id = setTimeout(measurePreview, 60);
		return () => clearTimeout(id);
	}, [device, previewDoc, measurePreview]);

	const setValue = (key: string, value: string) =>
		setValues((prev) => ({ ...prev, [key]: value }));

	const insertVariable = (token: string) => {
		if (readOnly) return;
		const el = htmlRef.current;
		const snippet = `{{${token}}}`;
		if (!el) {
			setHtml((prev) => prev + snippet);
			return;
		}
		const start = el.selectionStart ?? html.length;
		const end = el.selectionEnd ?? html.length;
		setHtml(html.slice(0, start) + snippet + html.slice(end));
		requestAnimationFrame(() => {
			el.focus();
			const pos = start + snippet.length;
			el.setSelectionRange(pos, pos);
		});
	};

	const handleSave = async () => {
		setError(null);
		if (!subject.trim()) return setError("Subject is required.");
		if (!html.trim()) return setError("Template HTML is required.");
		try {
			await onSave({
				name: name.trim() || template.name,
				subject,
				html,
				text,
				...(withSms ? { sms_body: sms } : {}),
			});
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to save template.");
		}
	};

	const handleReset = async () => {
		if (
			!window.confirm(
				"Reset this template to the built-in default? Your changes will be lost."
			)
		)
			return;
		setError(null);
		setResetting(true);
		try {
			await onReset();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to reset template.");
			setResetting(false);
		}
	};

	const brandVars = templateVars.filter((v) => (VAR_META[v]?.group ?? "content") === "brand");
	const contentVars = templateVars.filter(
		(v) => (VAR_META[v]?.group ?? "content") === "content"
	);

	const renderField = (key: string) => {
		const meta = VAR_META[key];
		const isColor = key === "brand.color";
		const isLogo = key === "brand.logo_url";
		const value = values[key] ?? "";
		return (
			<div key={key}>
				<label className={LABEL} title={key}>
					{meta?.label ?? key}
				</label>
				<div className="flex items-center gap-2">
					{isColor && (
						<input
							type="color"
							value={
								/^#[0-9a-fA-F]{6}$/.test(value)
									? value
									: "#1e3a5f"
							}
							onChange={(e) =>
								setValue(key, e.target.value)
							}
							className="h-[34px] w-10 flex-shrink-0 cursor-pointer rounded border border-border bg-base"
							aria-label={`${meta?.label ?? key} color picker`}
						/>
					)}
					<input
						type="text"
						value={value}
						onChange={(e) => setValue(key, e.target.value)}
						className={INPUT}
						placeholder={isLogo ? "https://…" : `{{${key}}}`}
					/>
				</div>
				{meta?.hint && (
					<p className="mt-1 flex items-center gap-1 text-[11px] text-text-muted">
						<Info size={11} /> {meta.hint}
					</p>
				)}
			</div>
		);
	};

	const content = (
		<div className="flex h-[88vh] max-h-[88vh] flex-col">
			{/* Header */}
			<div className="flex flex-shrink-0 items-center justify-between border-b border-border px-4 py-3 sm:px-5">
				<div className="flex items-center gap-2">
					<h2 className="text-lg font-bold text-text-primary sm:text-xl">
						{readOnly ? "Preview" : "Edit"} Template
					</h2>
					<span className="rounded-full border border-border bg-surface px-2 py-0.5 text-xs font-medium text-text-tertiary">
						{categoryLabel ??
							EmailTemplateCategoryLabels[
								template.category as EmailTemplateCategory
							]}
					</span>
				</div>
				<button
					onClick={onClose}
					className="rounded p-1.5 text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary"
					disabled={isPending}
				>
					<X size={18} />
				</button>
			</div>

			{/* Body: editor (left) + live preview (right). On mobile it stacks and the
			    whole body scrolls; on desktop each pane scrolls independently. */}
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
				{/* Editor pane */}
				<div className="w-full flex-shrink-0 space-y-4 border-b border-border p-4 sm:p-5 lg:w-[44%] lg:border-b-0 lg:border-r lg:overflow-y-auto">
					<div>
						<label className={LABEL}>Template name</label>
						<input
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							className={INPUT}
							disabled={readOnly || isPending}
						/>
					</div>

					<div>
						<label className={LABEL}>Subject line</label>
						<input
							type="text"
							value={subject}
							onChange={(e) => setSubject(e.target.value)}
							className={INPUT}
							disabled={readOnly || isPending}
							placeholder="e.g. Following up, {{client_name}}"
						/>
					</div>

					<div>
						<label className={LABEL}>Plain-text version</label>
						<p className="mb-1.5 text-[11px] text-text-muted">
							Shown by email apps that don't render HTML.
							Tweak the wording here; leave it blank to
							auto-generate from the HTML.
						</p>
						<textarea
							value={text}
							onChange={(e) => setText(e.target.value)}
							className={`${TEXTAREA} min-h-[150px] resize-y text-sm leading-relaxed`}
							disabled={readOnly || isPending}
							placeholder={
								"Hi {{client_name}},\n\nAdd your message here…"
							}
						/>
					</div>

					{withSms && (
						<div>
							<label
								className={LABEL}
								htmlFor="template-sms-body"
							>
								Text message
							</label>
							<p className="mb-1.5 text-[11px] text-text-muted">
								Keep it short. Customers are asked
								to reply STOP on their first text;
								that line is added for you.
							</p>
							<textarea
								id="template-sms-body"
								value={sms}
								onChange={(e) =>
									setSms(e.target.value)
								}
								className={`${TEXTAREA} min-h-[90px] resize-y text-sm leading-relaxed`}
								disabled={readOnly || isPending}
								placeholder={
									"{{brand.name}}: Your appointment is …"
								}
							/>
							<p
								className="mt-1 text-[11px] text-text-muted"
								aria-live="polite"
								data-testid="sms-segment-count"
							>
								≈ {smsInfo.length} characters ·{" "}
								{smsInfo.segments}{" "}
								{smsInfo.segments === 1
									? "segment"
									: "segments"}{" "}
								· {smsInfo.encoding}. Estimated from
								the sample values above.
								{smsInfo.encoding === "UCS-2" &&
									" (a symbol outside the standard set shortens each segment)"}
							</p>
						</div>
					)}

					{/* Variables form — the primary editing surface, drives the live preview */}
					<div>
						<label className={LABEL}>
							Content &amp; branding
						</label>
						<p className="mb-2 text-[11px] text-text-muted">
							Change any value to see the preview update
							live. These are the same variables
							substituted when the email is sent.
						</p>
						{templateVars.length === 0 ? (
							<p className="rounded-md border border-dashed border-border px-3 py-3 text-center text-xs text-text-muted">
								This template references no
								variables yet.
							</p>
						) : (
							<div className="space-y-3">
								{brandVars.length > 0 && (
									<div className="space-y-2">
										<p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
											Branding
										</p>
										{brandVars.map(
											renderField
										)}
									</div>
								)}
								{contentVars.length > 0 && (
									<div className="space-y-2">
										<p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
											Content
										</p>
										{contentVars.map(
											renderField
										)}
									</div>
								)}
							</div>
						)}
					</div>

					{/* Advanced: raw HTML editor, collapsed by default */}
					<div className="rounded-md border border-border-subtle">
						<button
							type="button"
							onClick={() => setShowAdvanced((v) => !v)}
							aria-expanded={showAdvanced}
							className="flex w-full items-center justify-between px-3 py-2.5 text-xs font-semibold text-text-primary transition-colors hover:bg-surface-raised/40"
						>
							<span className="flex items-center gap-1.5">
								<Code2
									size={13}
									className="text-text-muted"
								/>
								Advanced — edit HTML
							</span>
							<ChevronDown
								size={15}
								className={`text-text-muted transition-transform ${showAdvanced ? "rotate-180" : ""}`}
							/>
						</button>
						{showAdvanced && (
							<div className="space-y-2 border-t border-border-subtle p-3">
								{!readOnly && (
									<div className="flex flex-wrap gap-1.5">
										{(withSms
											? [
													...INSERTABLE_VARS,
													"link.visit",
												]
											: INSERTABLE_VARS
										).map((v) => (
											<button
												key={
													v
												}
												type="button"
												onClick={() =>
													insertVariable(
														v
													)
												}
												className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[11px] text-text-secondary transition-colors hover:border-primary hover:text-primary"
												title={`Insert {{${v}}}`}
											>
												{`{{${v}}}`}
											</button>
										))}
									</div>
								)}
								<textarea
									ref={htmlRef}
									value={html}
									onChange={(e) =>
										setHtml(
											e.target
												.value
										)
									}
									className={`${TEXTAREA} min-h-[280px] resize-y font-mono text-xs leading-relaxed`}
									spellCheck={false}
									disabled={
										readOnly ||
										isPending
									}
								/>
								<p className="text-[11px] text-text-muted">
									Full HTML control. Use{" "}
									<span className="font-mono">
										{"{{variable}}"}
									</span>{" "}
									tokens; they appear in the
									form above.
								</p>
							</div>
						)}
					</div>
				</div>

				{/* Preview pane */}
				<div className="flex w-full flex-shrink-0 flex-col bg-surface-inset lg:min-h-0 lg:flex-1 lg:overflow-hidden">
					<div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2">
						<div className="min-w-0 flex-1">
							<span className="text-[11px] uppercase tracking-wider text-text-muted">
								Subject
							</span>
							<p
								className="truncate text-sm font-medium text-text-primary"
								title={renderedSubject}
							>
								{renderedSubject || (
									<span className="text-text-muted">
										(empty)
									</span>
								)}
							</p>
						</div>
						<div className="flex flex-shrink-0 items-center gap-1.5">
							<div className="flex items-center gap-0.5 rounded-md border border-border bg-base p-0.5">
								<button
									type="button"
									onClick={() =>
										setPreviewMode(
											"html"
										)
									}
									className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
										previewMode ===
										"html"
											? "bg-surface-raised text-text-primary"
											: "text-text-muted hover:text-text-primary"
									}`}
								>
									HTML
								</button>
								<button
									type="button"
									onClick={() =>
										setPreviewMode(
											"text"
										)
									}
									className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
										previewMode ===
										"text"
											? "bg-surface-raised text-text-primary"
											: "text-text-muted hover:text-text-primary"
									}`}
								>
									Text
								</button>
							</div>
							{previewMode === "html" && (
								<div className="flex items-center gap-1 rounded-md border border-border bg-base p-0.5">
									<button
										type="button"
										onClick={() =>
											setDevice(
												"desktop"
											)
										}
										title="Desktop width"
										className={`rounded p-1.5 transition-colors ${
											device ===
											"desktop"
												? "bg-surface-raised text-text-primary"
												: "text-text-muted hover:text-text-primary"
										}`}
									>
										<Monitor
											size={14}
										/>
									</button>
									<button
										type="button"
										onClick={() =>
											setDevice(
												"mobile"
											)
										}
										title="Mobile width"
										className={`rounded p-1.5 transition-colors ${
											device ===
											"mobile"
												? "bg-surface-raised text-text-primary"
												: "text-text-muted hover:text-text-primary"
										}`}
									>
										<Smartphone
											size={14}
										/>
									</button>
								</div>
							)}
						</div>
					</div>
					<div className="p-4 lg:min-h-0 lg:flex-1 lg:overflow-auto">
						{previewMode === "html" ? (
							<div
								className="mx-auto transition-all"
								style={{
									width:
										device === "mobile"
											? 375
											: "100%",
									maxWidth: "100%",
								}}
							>
								<iframe
									ref={previewRef}
									title="Email preview"
									srcDoc={previewDoc}
									sandbox="allow-same-origin"
									onLoad={measurePreview}
									style={{
										height: previewHeight,
									}}
									className="w-full rounded-md border border-border bg-white"
								/>
							</div>
						) : (
							<pre className="mx-auto max-w-[640px] overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-white p-5 font-mono text-[12.5px] leading-relaxed text-[#111827]">
								{renderedText.trim() ||
									"(no plain-text body — auto-generated from HTML at send time)"}
							</pre>
						)}
					</div>
				</div>
			</div>

			{/* Footer */}
			<div className="flex flex-shrink-0 items-center justify-between gap-2 border-t border-border bg-base px-4 py-2.5">
				<div className="flex min-w-0 items-center gap-3">
					{!readOnly && template.is_customized && (
						<button
							type="button"
							onClick={handleReset}
							disabled={isPending || resetting}
							className="inline-flex items-center gap-1.5 text-xs font-medium text-text-tertiary transition-colors hover:text-text-primary disabled:opacity-50"
						>
							{resetting ? (
								<Loader2
									size={12}
									className="animate-spin"
								/>
							) : (
								<RotateCcw size={12} />
							)}
							Reset to default
						</button>
					)}
					{error && (
						<p className="truncate text-xs text-error-text">
							{error}
						</p>
					)}
				</div>
				<div className="flex flex-shrink-0 items-center gap-2">
					<button
						onClick={onClose}
						disabled={isPending}
						className="inline-flex h-8 items-center rounded-md border border-border bg-transparent px-3 text-sm font-medium text-text-tertiary transition-colors hover:border-border-strong hover:bg-surface hover:text-text-primary"
					>
						{readOnly ? "Close" : "Cancel"}
					</button>
					{!readOnly && (
						<button
							onClick={handleSave}
							disabled={isPending}
							className="inline-flex h-8 items-center gap-1.5 rounded-md bg-confirm px-4 text-sm font-semibold text-on-primary transition-colors hover:bg-confirm-hover disabled:cursor-not-allowed disabled:opacity-50"
						>
							{isPending && (
								<Loader2
									size={12}
									className="animate-spin"
								/>
							)}
							Save Template
						</button>
					)}
				</div>
			</div>
		</div>
	);

	return <FullPopup content={content} isModalOpen={true} onClose={onClose} size="xl" />;
}
