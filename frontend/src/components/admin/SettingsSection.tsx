import { useRef, useState, useEffect, type ReactNode } from "react";
import { Upload, Trash2, Building2, Loader2 } from "lucide-react";
import {
	useOrgSettings,
	useUploadOrgLogo,
	useDeleteOrgLogo,
	useUpdateOrgSettings,
	useOrgCosting,
	useUpdateOrgCosting,
} from "../../hooks/useOrg";
import type {
	OrgSettings,
	OrgSettingsUpdate,
	RestockMode,
	MeasurementSystem,
} from "../../api/org";
import AddressForm from "../../components/ui/AddressForm";
import type { GeocodeResult } from "../../types/location";
import TaxSettingsSection from "./TaxSettingsSection";
import { usePermission } from "../../hooks/usePermission";

// ── Layout primitive ─────────────────────────────────────────────────────────

interface SettingRowProps {
	title: string;
	description?: string;
	action?: ReactNode;
	children: ReactNode;
}

function SettingRow({ title, description, action, children }: SettingRowProps) {
	return (
		<div className="pt-2 pb-8">
			<div className="mb-4 flex items-center justify-between">
				<div>
					<h3 className="text-sm font-semibold text-text-primary">
						{title}
					</h3>
					{description && (
						<p className="mt-0.5 text-xs text-text-muted">
							{description}
						</p>
					)}
				</div>
				{action}
			</div>
			{children}
		</div>
	);
}

// ── Organization settings ─────────────────────────────────────────────────────

const inputBase =
	"w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text-primary placeholder:text-faint outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary-border";

const DEFAULT_BRAND_COLOR = "#1e3a5f";
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

interface RadioOption<T extends string> {
	value: T;
	label: string;
	description: string;
}

function SettingRadioGroup<T extends string>({
	name,
	legend,
	help,
	options,
	value,
	onChange,
}: {
	name: string;
	legend: string;
	help: string;
	options: readonly RadioOption<T>[];
	value: T | undefined;
	onChange: (next: T) => void;
}) {
	const helpId = `${name}-help`;
	return (
		<fieldset aria-describedby={helpId}>
			<legend className="mb-1 block text-xs font-medium text-text-tertiary">{legend}</legend>
			<p id={helpId} className="mb-2 text-xs text-text-muted">
				{help}
			</p>
			<div className="space-y-2">
				{options.map((opt) => (
					<label
						key={opt.value}
						className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 transition-colors focus-within:ring-1 focus-within:ring-primary-border ${
							value === opt.value
								? "border-primary bg-primary-bg-subtle"
								: "border-border-subtle hover:bg-surface"
						}`}
					>
						<input
							type="radio"
							name={name}
							value={opt.value}
							checked={value === opt.value}
							onChange={() => onChange(opt.value)}
							className="mt-0.5 accent-(--color-primary)"
						/>
						<span>
							<span className="block text-xs font-medium text-text-primary">
								{opt.label}
							</span>
							<span className="block text-xs text-text-muted">{opt.description}</span>
						</span>
					</label>
				))}
			</div>
		</fieldset>
	);
}

const RESTOCK_MODE_HELP =
	"Sets which restock path technicians and dispatch see first. Never limits what anyone can do — that's set in Roles.";
const RESTOCK_MODE_OPTIONS = [
	{
		value: "tech_self_serve",
		label: "Technician self-serve",
		description:
			"Techs see Fill to Standard first and restock their own vehicles from the warehouse",
	},
	{
		value: "dispatch_prepared",
		label: "Dispatch prepared",
		description:
			"Techs see Request Restock first; requests lead the vehicle's tabs for dispatch",
	},
] as const satisfies readonly RadioOption<RestockMode>[];

const MEASUREMENT_SYSTEM_HELP =
	"Puts your region's units first in the unit picker. Never converts quantities or hides a unit.";
const MEASUREMENT_SYSTEM_OPTIONS = [
	{ value: "imperial", label: "Imperial", description: "ft, lb, gal lead the unit picker" },
	{ value: "metric", label: "Metric", description: "m, kg, L lead the unit picker" },
] as const satisfies readonly RadioOption<MeasurementSystem>[];

function OrgSettingsSection() {
	const fileInputRef = useRef<HTMLInputElement>(null);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Seed from the server once; a logo upload/remove also refetches ["org"], and
	// reseeding then would wipe unsaved edits. Saves reseed from their own response.
	const seededRef = useRef(false);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const [logoImgError, setLogoImgError] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saveSuccess, setSaveSuccess] = useState(false);
	const [nameError, setNameError] = useState<string | null>(null);
	const [brandColorError, setBrandColorError] = useState<string | null>(null);
	// Kept as text, not a number: an in-progress "1" or a cleared field are both
	// valid states the numeric form value cannot hold.
	const [threshold, setThreshold] = useState("");
	const [thresholdError, setThresholdError] = useState<string | null>(null);

	const { data: org, isLoading } = useOrgSettings();
	const uploadMutation = useUploadOrgLogo();
	const deleteMutation = useDeleteOrgLogo();
	const updateMutation = useUpdateOrgSettings();

	const [form, setForm] = useState<OrgSettingsUpdate>({
		name: "",
		phone: "",
		address: "",
		coords: null,
		email: "",
		website: "",
		mfa_required: false,
		brand_color: DEFAULT_BRAND_COLOR,
	});

	const seedFrom = (source: OrgSettings) => {
		setForm({
			name: source.name,
			phone: source.phone ?? "",
			address: source.address ?? "",
			coords: source.coords ?? null,
			email: source.email ?? "",
			website: source.website ?? "",
			restock_mode: source.restock_mode,
			measurement_system: source.measurement_system,
			mfa_required: source.mfa_required,
			brand_color: source.brand_color ?? DEFAULT_BRAND_COLOR,
		});
		setThreshold(source.field_purchase_second_signoff_threshold ?? "");
	};

	useEffect(() => {
		if (!org) return;
		setLogoImgError(false);
		if (seededRef.current) return;
		seededRef.current = true;
		seedFrom(org);
	}, [org]);

	useEffect(() => {
		return () => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		};
	}, []);

	const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		setUploadError(null);
		try {
			await uploadMutation.mutateAsync(file);
		} catch {
			setUploadError(
				"Upload failed. Ensure the file is a JPEG, PNG, or WebP under 5MB."
			);
		}
		if (fileInputRef.current) fileInputRef.current.value = "";
	};

	const handleRemove = async () => {
		setDeleteError(null);
		try {
			await deleteMutation.mutateAsync();
		} catch {
			setDeleteError("Failed to remove logo. Please try again.");
		}
	};

	const handleAddressChange = (result: GeocodeResult) => {
		setForm((prev) => ({ ...prev, address: result.address, coords: result.coords }));
	};

	const handleAddressClear = () => {
		setForm((prev) => ({ ...prev, address: "", coords: null }));
	};

	const handleSave = async (e: React.FormEvent) => {
		e.preventDefault();
		setSaveError(null);
		setSaveSuccess(false);
		setNameError(null);
		setBrandColorError(null);
		setThresholdError(null);

		if (!form.name?.trim()) {
			setNameError("Organization name is required.");
			return;
		}

		if (form.brand_color && !HEX_COLOR_RE.test(form.brand_color)) {
			setBrandColorError("Enter a valid 6-digit hex color, e.g. #1e3a5f.");
			return;
		}

		const trimmedThreshold = threshold.trim();
		const parsedThreshold =
			trimmedThreshold === "" ? null : Number(trimmedThreshold);
		if (
			parsedThreshold !== null &&
			(!Number.isFinite(parsedThreshold) || parsedThreshold < 0)
		) {
			setThresholdError("Enter an amount of 0 or more, or leave blank to disable.");
			return;
		}

		try {
			// A null server color shows as the default in the picker; sending it back
			// untouched would log a spurious null → default change.
			const omitBrandColor =
				org?.brand_color == null && form.brand_color === DEFAULT_BRAND_COLOR;
			const saved = await updateMutation.mutateAsync({
				name: form.name.trim(),
				phone: form.phone || null,
				address: form.address || null,
				coords: form.coords || null,
				email: form.email || null,
				website: form.website || null,
				...(form.restock_mode ? { restock_mode: form.restock_mode } : {}),
				...(form.measurement_system
					? { measurement_system: form.measurement_system }
					: {}),
				mfa_required: !!form.mfa_required,
				...(omitBrandColor ? {} : { brand_color: form.brand_color || null }),
				field_purchase_second_signoff_threshold: parsedThreshold,
			});
			seedFrom(saved);
			setSaveSuccess(true);
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			saveTimerRef.current = setTimeout(() => setSaveSuccess(false), 3000);
		} catch {
			setSaveError("Failed to save changes. Please try again.");
		}
	};

	return (
		<div className="rounded-lg border border-border-subtle bg-base">
			{/* Logo */}
			<div className="border-b border-border-subtle px-5 py-5">
				<p className="mb-3 text-xs font-medium text-text-tertiary">Logo</p>
				<div className="flex items-center gap-5">
					{isLoading ? (
						<div className="h-12 w-12 flex-shrink-0 animate-pulse rounded-md bg-surface" />
					) : org?.logo_url && !logoImgError ? (
						<img
							src={org.logo_url ?? undefined}
							alt="Organization logo"
							className="h-12 w-12 flex-shrink-0 rounded-md object-contain bg-surface"
							onError={() => setLogoImgError(true)}
						/>
					) : (
						<div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-md bg-surface">
							<Building2
								size={20}
								className="text-text-muted"
							/>
						</div>
					)}

					<div>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={() =>
									fileInputRef.current?.click()
								}
								disabled={uploadMutation.isPending}
								className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-border-strong hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
							>
								{uploadMutation.isPending ? (
									<Loader2
										size={12}
										className="animate-spin"
									/>
								) : (
									<Upload size={12} />
								)}
								{uploadMutation.isPending
									? "Uploading…"
									: "Upload Logo"}
							</button>

							{org?.logo_url && (
								<button
									type="button"
									onClick={handleRemove}
									disabled={
										deleteMutation.isPending
									}
									className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-error-text transition-colors hover:border-error-border hover:bg-error-bg disabled:cursor-not-allowed disabled:opacity-50"
								>
									{deleteMutation.isPending ? (
										<Loader2
											size={12}
											className="animate-spin"
										/>
									) : (
										<Trash2 size={12} />
									)}
									{deleteMutation.isPending
										? "Removing…"
										: "Remove"}
								</button>
							)}
						</div>

						{(uploadError || deleteError) && (
							<p className="mt-2 text-xs text-error-text">
								{uploadError ?? deleteError}
							</p>
						)}

						<p className="mt-2 text-xs text-text-muted">
							JPEG, PNG, or WebP · max 5 MB
						</p>
					</div>
				</div>

				<input
					ref={fileInputRef}
					type="file"
					accept="image/jpeg,image/png,image/webp"
					className="hidden"
					onChange={handleFileChange}
				/>
			</div>

			{/* Details form */}
			<form onSubmit={handleSave} className="px-5 py-5">
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<div className="sm:col-span-2">
						<label
							htmlFor="settings-name"
							className="mb-1 block text-xs font-medium text-text-tertiary"
						>
							Organization Name
						</label>
						{isLoading ? (
							<div className="h-8 animate-pulse rounded-md bg-surface" />
						) : (
							<input
								id="settings-name"
								type="text"
								value={form.name ?? ""}
								onChange={(e) => {
									const val = e.target.value;
									setForm((prev) => ({
										...prev,
										name: val,
									}));
									setNameError(
										val.trim() === ""
											? "Organization name is required."
											: null
									);
								}}
								className={`${inputBase} ${nameError ? "!border-error focus:!border-error focus:!ring-error" : ""}`}
							/>
						)}
						{nameError && (
							<p className="mt-1 text-xs text-error-text">
								{nameError}
							</p>
						)}
					</div>

					<div>
						<label
							htmlFor="settings-phone"
							className="mb-1 block text-xs font-medium text-text-tertiary"
						>
							Phone
						</label>
						{isLoading ? (
							<div className="h-8 animate-pulse rounded-md bg-surface" />
						) : (
							<input
								id="settings-phone"
								type="text"
								value={form.phone ?? ""}
								onChange={(e) =>
									setForm((prev) => ({
										...prev,
										phone: e.target
											.value,
									}))
								}
								className={inputBase}
							/>
						)}
					</div>

					<div>
						<label
							htmlFor="settings-email"
							className="mb-1 block text-xs font-medium text-text-tertiary"
						>
							Email
						</label>
						{isLoading ? (
							<div className="h-8 animate-pulse rounded-md bg-surface" />
						) : (
							<input
								id="settings-email"
								type="text"
								value={form.email ?? ""}
								onChange={(e) =>
									setForm((prev) => ({
										...prev,
										email: e.target
											.value,
									}))
								}
								className={inputBase}
							/>
						)}
					</div>

					<div className="sm:col-span-2">
						<label className="mb-1 block text-xs font-medium text-text-tertiary">
							Address
						</label>
						{isLoading ? (
							<div className="h-8 animate-pulse rounded-md bg-surface" />
						) : (
							<AddressForm
								mode="edit"
								originalValue={form.address ?? ""}
								originalCoords={
									form.coords ?? undefined
								}
								handleChange={handleAddressChange}
								handleClear={handleAddressClear}
							/>
						)}
					</div>

					<div>
						<label
							htmlFor="settings-website"
							className="mb-1 block text-xs font-medium text-text-tertiary"
						>
							Website
						</label>
						{isLoading ? (
							<div className="h-8 animate-pulse rounded-md bg-surface" />
						) : (
							<input
								id="settings-website"
								type="text"
								value={form.website ?? ""}
								onChange={(e) =>
									setForm((prev) => ({
										...prev,
										website: e.target
											.value,
									}))
								}
								className={inputBase}
							/>
						)}
					</div>
				</div>

				{/* Restock workflow emphasis — UX default only, never a capability gate */}
				<div className="mt-5">
					<SettingRadioGroup
						name="restock-mode"
						legend="Vehicle Restock Workflow"
						help={RESTOCK_MODE_HELP}
						options={RESTOCK_MODE_OPTIONS}
						value={form.restock_mode}
						onChange={(next) => setForm((prev) => ({ ...prev, restock_mode: next }))}
					/>
				</div>

				{/* Measurement system — orders the unit picker, never converts or hides units */}
				<div className="mt-5 border-t border-border-subtle pt-5">
					<SettingRadioGroup
						name="measurement-system"
						legend="Measurement System"
						help={MEASUREMENT_SYSTEM_HELP}
						options={MEASUREMENT_SYSTEM_OPTIONS}
						value={form.measurement_system}
						onChange={(next) => setForm((prev) => ({ ...prev, measurement_system: next }))}
					/>
				</div>

				{/* Security — org-wide MFA enforcement */}
				<div className="mt-5 border-t border-border-subtle pt-5">
					<span className="mb-1 block text-xs font-medium text-text-tertiary">
						Security
					</span>
					<p className="mb-2 text-xs text-text-muted">
						When on, everyone in this organization must set up an authenticator
						app; anyone not enrolled is prompted at their next sign-in.
					</p>
					<Toggle
						checked={!!form.mfa_required}
						onChange={() =>
							setForm((prev) => ({ ...prev, mfa_required: !prev.mfa_required }))
						}
						label="Require two-factor authentication"
					/>
				</div>

				{/* Branding */}
				<div className="mt-5">
					<span className="mb-1 block text-xs font-medium text-text-tertiary">
						Brand Color
					</span>
					<p className="mb-2 text-xs text-text-muted">
						Used as the accent color in outgoing client emails.
					</p>
					<div className="flex items-center gap-2">
						<input
							type="color"
							aria-label="Brand color picker"
							value={
								// The native color input requires lowercase hex; an uppercase
								// saved value (e.g. "#1E3A5F") would otherwise reset it to black.
								form.brand_color && HEX_COLOR_RE.test(form.brand_color)
									? form.brand_color.toLowerCase()
									: DEFAULT_BRAND_COLOR
							}
							onChange={(e) => {
								setForm((prev) => ({ ...prev, brand_color: e.target.value }));
								setBrandColorError(null);
							}}
							className="h-8 w-10 cursor-pointer rounded border border-border bg-surface p-0.5"
						/>
						<input
							type="text"
							value={form.brand_color ?? ""}
							onChange={(e) => {
								setForm((prev) => ({ ...prev, brand_color: e.target.value }));
								setBrandColorError(null);
							}}
							placeholder="#1e3a5f"
							className={`${inputBase} max-w-[140px] font-mono ${brandColorError ? "!border-error focus:!border-error focus:!ring-error" : ""}`}
						/>
					</div>
					{brandColorError && (
						<p className="mt-1 text-xs text-error-text">{brandColorError}</p>
					)}
				</div>


				{/* Field purchase second sign-off */}
				<div className="mt-5">
					<span className="mb-1 block text-xs font-medium text-text-tertiary">
						Second Sign-Off Threshold
					</span>
					<p className="mb-2 text-xs text-text-muted">
						Field purchases at or above this amount need a second approver before
						they are approved and stock moves. Leave blank to disable.
					</p>
					<div className="flex items-center gap-2">
						<span className="text-xs text-text-muted">$</span>
						<input
							type="number"
							min="0"
							step="0.01"
							value={threshold}
							onChange={(e) => setThreshold(e.target.value)}
							placeholder="Disabled"
							aria-label="Second sign-off threshold"
							className={`${inputBase} max-w-[140px] ${thresholdError ? "!border-error focus:!border-error focus:!ring-error" : ""}`}
						/>
					</div>
					{thresholdError && (
						<p className="mt-1 text-xs text-error-text">{thresholdError}</p>
					)}
				</div>

				<div className="mt-5 flex items-center gap-3">
					<button
						type="submit"
						disabled={updateMutation.isPending || isLoading}
						className="flex items-center gap-1.5 rounded-md bg-primary-hover px-4 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
					>
						{updateMutation.isPending && (
							<Loader2
								size={12}
								className="animate-spin"
							/>
						)}
						{updateMutation.isPending
							? "Saving…"
							: "Save Changes"}
					</button>

					{saveSuccess && (
						<span className="text-xs text-success-text">
							Changes saved.
						</span>
					)}
					{saveError && (
						<span className="text-xs text-error-text">
							{saveError}
						</span>
					)}
				</div>
			</form>
		</div>
	);
}

// ── Toggle primitive ──────────────────────────────────────────────────────────

interface ToggleProps {
	checked: boolean;
	onChange: () => void;
	label: string;
}

function Toggle({ checked, onChange, label }: ToggleProps) {
	return (
		<label className="flex cursor-pointer items-center gap-2" onClick={onChange}>
			<div
				className={`relative h-4 w-7 rounded-full border transition-colors ${
					checked
						? "border-primary bg-primary"
						: "border-border bg-surface-inset"
				}`}
			>
				<span
					className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
						checked ? "translate-x-3" : "translate-x-0.5"
					}`}
				/>
			</div>
			<span className="text-xs text-text-muted">{label}</span>
		</label>
	);
}

// ── Settings page shell ───────────────────────────────────────────────────────

// Own state and own submit, deliberately not folded into OrgSettingsSection:
// that form posts a fixed full payload on every save, so a numeric field sitting
// in it as "" would 400 every organization save, not just this one.
function CostingSettingsSection() {
	const { data: costing, isLoading } = useOrgCosting();
	const updateMutation = useUpdateOrgCosting();

	const [overhead, setOverhead] = useState("");
	const [perMile, setPerMile] = useState("");
	const [rate, setRate] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		if (!costing) return;
		setOverhead(costing.monthly_overhead ?? "");
		setPerMile(costing.cost_per_mile ?? "");
		setRate(costing.overhead_rate_per_hour ?? "");
	}, [costing]);

	const handleSave = async () => {
		const parsedOverhead = Number(overhead);
		const parsedPerMile = Number(perMile);
		if (
			overhead.trim() === "" ||
			perMile.trim() === "" ||
			Number.isNaN(parsedOverhead) ||
			Number.isNaN(parsedPerMile) ||
			parsedOverhead < 0 ||
			parsedPerMile < 0
		) {
			setError("Monthly overhead and cost per mile must be numbers of 0 or more");
			return;
		}
		// Blank is legal here and means "not set" — the report dashes overhead rather
		// than pricing it at 0.
		const parsedRate = rate.trim() === "" ? null : Number(rate);
		if (parsedRate !== null && (Number.isNaN(parsedRate) || parsedRate < 0)) {
			setError("Overhead rate must be a number of 0 or more, or blank");
			return;
		}
		setError(null);
		try {
			await updateMutation.mutateAsync({
				monthly_overhead: parsedOverhead,
				cost_per_mile: parsedPerMile,
				overhead_rate_per_hour: parsedRate,
			});
			setSaved(true);
			setTimeout(() => setSaved(false), 2000);
		} catch {
			setError("Could not save costing settings");
		}
	};

	if (isLoading) return <Loader2 className="h-4 w-4 animate-spin text-text-muted" />;

	return (
		<div className="space-y-4">
			<div>
				<label className="mb-1 block text-xs font-medium text-text-tertiary">
					Monthly overhead
				</label>
				<input
					type="number"
					step="any"
					min="0"
					value={overhead}
					onChange={(e) => setOverhead(e.target.value)}
					className={inputBase}
					disabled={updateMutation.isPending}
				/>
				<p className="mt-1 text-xs text-text-muted">
					Fixed monthly costs — rent, insurance, software. Used to measure how
					much of the month the jobs actually absorbed.
				</p>
			</div>
			<div>
				<label className="mb-1 block text-xs font-medium text-text-tertiary">
					Cost per mile
				</label>
				<input
					type="number"
					step="any"
					min="0"
					value={perMile}
					onChange={(e) => setPerMile(e.target.value)}
					className={inputBase}
					disabled={updateMutation.isPending}
				/>
				<p className="mt-1 text-xs text-text-muted">
					Fuel, maintenance, and depreciation per mile driven.
				</p>
			</div>
			<div>
				<label className="mb-1 block text-xs font-medium text-text-tertiary">
					Overhead rate per hour
				</label>
				<input
					type="number"
					step="any"
					min="0"
					value={rate}
					onChange={(e) => setRate(e.target.value)}
					className={inputBase}
					disabled={updateMutation.isPending}
					placeholder="Not set"
				/>
				<p className="mt-1 text-xs text-text-muted">
					Charged per hour worked on a job. Leave blank to leave overhead out of
					the profitability report — zero would price it as free.
				</p>
			</div>
			{error && <p className="text-xs text-error-text">{error}</p>}
			{saved && <p className="text-xs text-success-text">Saved</p>}
			<button
				type="button"
				onClick={handleSave}
				disabled={updateMutation.isPending}
				className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-text disabled:opacity-50"
			>
				{updateMutation.isPending ? "Saving..." : "Save"}
			</button>
		</div>
	);
}

export default function SettingsSection() {
	const [showTaxInactive, setShowTaxInactive] = useState(false);

	const MANAGE_ORG = usePermission("manage_organization");
	const MANAGE_TAX = usePermission("manage_taxes");
	// GET /org/costing is gated on view_reports, PATCH on manage_organization —
	// both are needed for the section to load and save.
	const VIEW_REPORTS = usePermission("view_reports");

	return (
		<div className="max-w-6xl">
			<div className="grid grid-cols-1 gap-x-8 lg:grid-cols-2 lg:items-start">
				{MANAGE_ORG && (
					<SettingRow
						title="Organization"
						description="Profile, branding, and contact information."
					>
						<OrgSettingsSection />
					</SettingRow>

				)}
				{MANAGE_TAX && (
					<SettingRow
						title="Tax"
						description="Rates and groups applied to quotes and invoices."
						action={
							<Toggle
								checked={showTaxInactive}
								onChange={() =>
									setShowTaxInactive((v) => !v)
								}
								label="Show inactive"
							/>
						}
					>
						<TaxSettingsSection showInactive={showTaxInactive} />
					</SettingRow>
				)}
				{MANAGE_ORG && VIEW_REPORTS && (
					<SettingRow
						title="Costing"
						description="Overhead and mileage rates used by the profitability report."
					>
						<CostingSettingsSection />
					</SettingRow>
				)}
			</div>
		</div>
	);
}



