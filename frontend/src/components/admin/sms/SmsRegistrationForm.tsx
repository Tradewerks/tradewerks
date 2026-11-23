import { useId, useState, type ReactNode } from "react";
import { Loader2, X } from "lucide-react";
import Dropdown from "../../ui/Dropdown";
import FullPopup from "../../ui/FullPopup";
import { FormErrorBanner } from "../../ui/forms/FormErrorBanner";
import { INPUT } from "../../followups/shared";
import { US_STATES } from "../../../lib/usStates";
import { errorMessage } from "../../../util/util";
import { useSaveSmsRegistration, useSubmitSmsRegistration } from "../../../hooks/useSmsAccount";
import type { SmsRegistration, SmsRegistrationDraft } from "../../../api/smsAccount";
import {
	SMS_ENTITY_TYPES,
	SMS_VERTICALS,
	fieldErrors,
	type SmsRegistrationValues,
} from "./registrationSchema";

const CA_PROVINCES = [
	["AB", "Alberta"],
	["BC", "British Columbia"],
	["MB", "Manitoba"],
	["NB", "New Brunswick"],
	["NL", "Newfoundland and Labrador"],
	["NS", "Nova Scotia"],
	["NT", "Northwest Territories"],
	["NU", "Nunavut"],
	["ON", "Ontario"],
	["PE", "Prince Edward Island"],
	["QC", "Quebec"],
	["SK", "Saskatchewan"],
	["YT", "Yukon"],
] as const;

function initialValues(d: SmsRegistrationDraft | null): SmsRegistrationValues {
	const a = d?.address ?? {};
	return {
		legal_name: d?.legal_name ?? "",
		dba: d?.dba ?? "",
		ein: d?.ein ?? "",
		entity_type: (d?.entity_type ?? "") as SmsRegistrationValues["entity_type"],
		vertical: d?.vertical ?? "CONSTRUCTION",
		address: {
			street: a.street ?? "",
			street_secondary: a.street_secondary ?? "",
			city: a.city ?? "",
			region: a.region ?? "",
			postal_code: a.postal_code ?? "",
			iso_country: a.iso_country === "CA" ? "CA" : "US",
		},
		website: d?.website ?? "",
		support_email: d?.support_email ?? "",
		support_phone: d?.support_phone ?? "",
		rep_name: d?.rep_name ?? "",
		rep_title: d?.rep_title ?? "",
		rep_email: d?.rep_email ?? "",
		rep_phone: d?.rep_phone ?? "",
		sole_prop_mobile: d?.sole_prop_mobile ?? "",
		privacy_url: d?.privacy_url ?? "",
		terms_url: d?.terms_url ?? "",
		area_code: d?.area_code ?? "",
	};
}

/** Drops empty optional fields so the server sees them as absent. */
function toPayload(v: SmsRegistrationValues): SmsRegistration {
	const trimmed = (s?: string) => (s?.trim() ? s.trim() : undefined);
	return {
		...v,
		dba: trimmed(v.dba),
		ein: trimmed(v.ein),
		sole_prop_mobile: trimmed(v.sole_prop_mobile),
		address: { ...v.address, street_secondary: trimmed(v.address.street_secondary) },
	} as SmsRegistration;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
	return (
		<fieldset className="border-t border-border-subtle px-5 py-4 first:border-t-0">
			<legend className="contents">
				<span className="block text-xs font-semibold uppercase tracking-wide text-text-tertiary">
					{title}
				</span>
			</legend>
			{hint && <p className="mt-0.5 text-xs text-text-muted">{hint}</p>}
			<div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
				{children}
			</div>
		</fieldset>
	);
}

function Field({
	label,
	error,
	hint,
	wide,
	children,
}: {
	label: string;
	error?: string;
	hint?: string;
	wide?: boolean;
	children: (p: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
}) {
	const id = useId();
	const msgId = `${id}-msg`;
	return (
		<div className={wide ? "sm:col-span-2" : undefined}>
			<label
				htmlFor={id}
				className="mb-1 block text-xs font-medium text-text-secondary"
			>
				{label}
			</label>
			{children({
				id,
				describedBy: error || hint ? msgId : undefined,
				invalid: !!error,
			})}
			{error ? (
				<p id={msgId} className="mt-1 text-xs text-error-text">
					{error}
				</p>
			) : (
				hint && (
					<p id={msgId} className="mt-1 text-xs text-text-muted">
						{hint}
					</p>
				)
			)}
		</div>
	);
}

export default function SmsRegistrationForm({
	draft,
	onClose,
}: {
	draft: SmsRegistrationDraft | null;
	onClose: () => void;
}) {
	const [values, setValues] = useState(() => initialValues(draft));
	const [attempted, setAttempted] = useState(false);
	const save = useSaveSmsRegistration();
	const submit = useSubmitSmsRegistration();
	const busy = save.isPending || submit.isPending;
	const errors = attempted ? fieldErrors(values) : {};
	const serverError = submit.error ?? save.error;

	const set = (key: keyof SmsRegistrationValues, v: string) =>
		setValues((prev) => ({ ...prev, [key]: v }));
	const setAddr = (key: keyof SmsRegistrationValues["address"], v: string) =>
		setValues((prev) => ({ ...prev, address: { ...prev.address, [key]: v } }));

	const text = (
		key: Exclude<keyof SmsRegistrationValues, "address" | "entity_type">,
		label: string,
		opts: {
			hint?: string;
			wide?: boolean;
			type?: string;
			placeholder?: string;
			inputMode?: "tel" | "numeric" | "email" | "url";
		} = {}
	) => (
		<Field label={label} error={errors[key]} hint={opts.hint} wide={opts.wide}>
			{({ id, describedBy, invalid }) => (
				<input
					id={id}
					type={opts.type ?? "text"}
					inputMode={opts.inputMode}
					placeholder={opts.placeholder}
					value={values[key] ?? ""}
					onChange={(e) => set(key, e.target.value)}
					aria-invalid={invalid}
					aria-describedby={describedBy}
					className={`${INPUT} ${invalid ? "!border-error" : ""}`}
				/>
			)}
		</Field>
	);

	const addr = (
		key: "street" | "street_secondary" | "city" | "postal_code",
		label: string,
		wide = false
	) => (
		<Field label={label} error={errors[`address.${key}`]} wide={wide}>
			{({ id, describedBy, invalid }) => (
				<input
					id={id}
					value={values.address[key] ?? ""}
					onChange={(e) => setAddr(key, e.target.value)}
					aria-invalid={invalid}
					aria-describedby={describedBy}
					className={`${INPUT} ${invalid ? "!border-error" : ""}`}
				/>
			)}
		</Field>
	);

	const regions =
		values.address.iso_country === "CA"
			? CA_PROVINCES.map(([code, name]) => ({ code, name }))
			: US_STATES;

	const onSaveDraft = async () => {
		try {
			await save.mutateAsync(toPayload(values));
			onClose();
		} catch {
			// Shown by the banner.
		}
	};

	const onSubmit = async () => {
		setAttempted(true);
		if (Object.keys(fieldErrors(values)).length) return;
		try {
			await submit.mutateAsync(toPayload(values));
			onClose();
		} catch {
			// Shown by the banner.
		}
	};

	return (
		<FullPopup
			isModalOpen
			onClose={onClose}
			size="lg"
			content={
				<div className="flex min-h-0 flex-col">
					<div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
						<div>
							<h2 className="text-sm font-semibold text-text-primary">
								Set up text messaging
							</h2>
							<p className="mt-0.5 text-xs text-text-muted">
								US carriers require every business
								that texts customers to register. We
								file this with the carriers for you;
								use the details on your tax records.
							</p>
						</div>
						<button
							type="button"
							onClick={onClose}
							aria-label="Close"
							className="rounded p-1 text-text-muted transition-colors duration-150 hover:bg-surface-raised hover:text-text-primary"
						>
							<X size={16} />
						</button>
					</div>

					<form
						noValidate
						className="min-h-0 flex-1 overflow-y-auto"
						onSubmit={(e) => {
							e.preventDefault();
							void onSubmit();
						}}
					>
						<Section title="Business">
							{text("legal_name", "Legal business name", {
								hint: "Exactly as it appears on your EIN letter",
							})}
							{text("dba", "Name customers know you by", {
								hint: "Optional. Shown at the start of each text",
							})}
							<Field
								label="Business type"
								error={errors.entity_type}
							>
								{({ id, describedBy, invalid }) => (
									<Dropdown
										id={id}
										aria-describedby={
											describedBy
										}
										error={invalid}
										value={
											values.entity_type
										}
										placeholder="Choose a type"
										onChange={(v) =>
											set(
												"entity_type",
												v
											)
										}
										entries={SMS_ENTITY_TYPES.map(
											(t) => (
												<option
													key={
														t
													}
													value={
														t
													}
												>
													{
														t
													}
												</option>
											)
										)}
									/>
								)}
							</Field>
							<Field
								label="Industry"
								error={errors.vertical}
							>
								{({ id, describedBy, invalid }) => (
									<Dropdown
										id={id}
										aria-describedby={
											describedBy
										}
										error={invalid}
										value={
											values.vertical
										}
										onChange={(v) =>
											set(
												"vertical",
												v
											)
										}
										entries={SMS_VERTICALS.map(
											(t) => (
												<option
													key={
														t.value
													}
													value={
														t.value
													}
												>
													{
														t.label
													}
												</option>
											)
										)}
									/>
								)}
							</Field>
							{text("ein", "EIN", {
								placeholder: "12-3456789",
								inputMode: "numeric",
								hint: "Leave empty if you have no EIN and register as a sole proprietor below",
							})}
							{text("website", "Website", {
								placeholder: "https://",
								inputMode: "url",
							})}
						</Section>

						<Section title="Business address">
							{addr("street", "Street", true)}
							{addr(
								"street_secondary",
								"Suite or unit (optional)"
							)}
							{addr("city", "City")}
							<Field
								label="Country"
								error={
									errors[
										"address.iso_country"
									]
								}
							>
								{({ id, describedBy }) => (
									<Dropdown
										id={id}
										aria-describedby={
											describedBy
										}
										value={
											values
												.address
												.iso_country
										}
										onChange={(v) =>
											setValues(
												(
													prev
												) => ({
													...prev,
													address: {
														...prev.address,
														iso_country:
															v as
																| "US"
																| "CA",
														region: "",
													},
												})
											)
										}
										entries={[
											<option
												key="US"
												value="US"
											>
												United
												States
											</option>,
											<option
												key="CA"
												value="CA"
											>
												Canada
											</option>,
										]}
									/>
								)}
							</Field>
							<Field
								label={
									values.address
										.iso_country ===
									"CA"
										? "Province"
										: "State"
								}
								error={errors["address.region"]}
							>
								{({ id, describedBy, invalid }) => (
									<Dropdown
										id={id}
										aria-describedby={
											describedBy
										}
										error={invalid}
										value={
											values
												.address
												.region
										}
										placeholder="Choose one"
										onChange={(v) =>
											setAddr(
												"region",
												v
											)
										}
										entries={regions.map(
											(r) => (
												<option
													key={
														r.code
													}
													value={
														r.code
													}
												>
													{
														r.name
													}
												</option>
											)
										)}
									/>
								)}
							</Field>
							{addr(
								"postal_code",
								values.address.iso_country === "CA"
									? "Postal code"
									: "ZIP code"
							)}
						</Section>

						<Section
							title="Customer contact"
							hint="Where customers can reach you about a text."
						>
							{text("support_email", "Support email", {
								type: "email",
								inputMode: "email",
							})}
							{text("support_phone", "Support phone", {
								type: "tel",
								inputMode: "tel",
							})}
						</Section>

						<Section
							title="Authorized representative"
							hint="The person carriers may contact to confirm this registration."
						>
							{text("rep_name", "Full name")}
							{text("rep_title", "Job title", {
								placeholder: "Owner, CEO, GM…",
							})}
							{text("rep_email", "Email", {
								type: "email",
								inputMode: "email",
							})}
							{text("rep_phone", "Phone", {
								type: "tel",
								inputMode: "tel",
							})}
						</Section>

						<Section
							title="Sole proprietor"
							hint="Only if you have no EIN. Carriers text this mobile number a code; reply to it to finish registration."
						>
							{text(
								"sole_prop_mobile",
								"Owner's mobile number",
								{ type: "tel", inputMode: "tel" }
							)}
						</Section>

						<Section title="Policies and number">
							{text(
								"privacy_url",
								"Privacy policy page",
								{
									placeholder: "https://",
									inputMode: "url",
									hint: "Must say you don't share mobile numbers for marketing",
								}
							)}
							{text("terms_url", "Terms page", {
								placeholder: "https://",
								inputMode: "url",
							})}
							{text("area_code", "Preferred area code", {
								placeholder: "512",
								inputMode: "numeric",
								hint: "We get a local number here, or elsewhere in your state if none is free",
							})}
						</Section>

						<div className="sticky bottom-0 flex flex-col gap-3 border-t border-border-subtle bg-surface px-5 py-3">
							<FormErrorBanner
								message={
									serverError
										? errorMessage(
												serverError,
												"Couldn't save your details."
											)
										: null
								}
							/>
							{attempted &&
								Object.keys(errors).length > 0 && (
									<p
										role="alert"
										className="text-xs text-error-text"
									>
										Fix the highlighted
										fields to submit.
									</p>
								)}
							<div className="flex items-center justify-end gap-2">
								<button
									type="button"
									onClick={onClose}
									className="h-8 rounded-md px-3 text-xs font-medium text-text-secondary transition-colors duration-150 hover:bg-surface-raised hover:text-text-primary"
								>
									Cancel
								</button>
								<button
									type="button"
									disabled={busy}
									onClick={() =>
										void onSaveDraft()
									}
									className="h-8 rounded-md border border-border bg-base px-3 text-xs font-medium text-text-primary transition-colors duration-150 hover:border-border-strong hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
								>
									Save draft
								</button>
								<button
									type="submit"
									disabled={busy}
									className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-on-primary transition-colors duration-150 hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
								>
									{submit.isPending && (
										<Loader2
											size={12}
											className="animate-spin"
										/>
									)}
									Submit registration
								</button>
							</div>
						</div>
					</form>
				</div>
			}
		/>
	);
}
