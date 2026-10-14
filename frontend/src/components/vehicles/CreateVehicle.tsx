import { useState, useEffect, useMemo, useCallback } from "react";
import type { ZodError } from "zod";
import { CreateVehicleSchema, type CreateVehicleInput } from "../../types/vehicles";
import { FormWizardContainer } from "../ui/forms/FormWizardContainer";
import AddressForm from "../ui/AddressForm";
import type { GeocodeResult } from "../../types/location";

interface CreateVehicleProps {
	isModalOpen: boolean;
	setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
	createVehicle: (input: CreateVehicleInput) => Promise<string>;
}

const INPUT =
	"border border-border px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm focus:border-primary focus:outline-none transition-colors min-w-0";
const LABEL = "block mb-0.5 text-xs font-medium text-text-tertiary uppercase tracking-wider";
const DIVIDER_LABEL = "flex items-center gap-2 my-1";

export default function CreateVehicle({
	isModalOpen,
	setIsModalOpen,
	createVehicle,
}: CreateVehicleProps) {
	const [name, setName] = useState("");
	const [type, setType] = useState("");
	const [licensePlate, setLicensePlate] = useState("");
	const [year, setYear] = useState("");
	const [make, setMake] = useState("");
	const [model, setModel] = useState("");
	const [color, setColor] = useState("");
	const [status, setStatus] = useState<"active" | "inactive">("active");
	const [notes, setNotes] = useState("");
	const [odometer, setOdometer] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [geoData, setGeoData] = useState<GeocodeResult>();
	const [errors, setErrors] = useState<ZodError | null>(null);

	const resetForm = useCallback(() => {
		setName("");
		setType("");
		setLicensePlate("");
		setYear("");
		setMake("");
		setModel("");
		setColor("");
		setStatus("active");
		setNotes("");
		setOdometer("");
		setErrors(null);
		setGeoData(undefined);
	}, []);

	useEffect(() => {
		if (!isModalOpen) {
			resetForm();
			setIsLoading(false);
		}
	}, [isModalOpen, resetForm]);

	const ErrorDisplay = ({ path }: { path: string }) => {
		if (!errors) return null;
		const fieldErrors = errors.issues.filter((e) => e.path[0] === path);
		if (fieldErrors.length === 0) return null;
		return (
			<div className="mt-0.5">
				{fieldErrors.map((e, i) => (
					<p key={i} className="text-error-text text-xs leading-tight">
						{e.message}
					</p>
				))}
			</div>
		);
	};

	const handleChangeAddress = (result: GeocodeResult) => {
		setGeoData({ address: result.address, coords: result.coords });
	};
	const handleClearAddress = () => setGeoData(undefined);

	const invokeCreate = async () => {
		if (isLoading) return;
		const input: CreateVehicleInput = {
			name: name.trim(),
			type: type.trim(),
			license_plate: licensePlate.trim(),
			year: year ? parseInt(year, 10) : null,
			make: make.trim() || null,
			model: model.trim() || null,
			color: color.trim() || null,
			status,
			notes: notes.trim() || null,
			current_odometer_mi: odometer ? parseInt(odometer, 10) : null,
			stored_at: geoData?.address,
			stored_at_coords: geoData?.coords,
		};
		const result = CreateVehicleSchema.safeParse(input);
		if (!result.success) {
			setErrors(result.error);
			return;
		}
		setErrors(null);
		setIsLoading(true);
		try {
			await createVehicle(result.data);
			setIsModalOpen(false);
			resetForm();
		} catch (err) {
			console.error("Failed to create vehicle:", err);
		} finally {
			setIsLoading(false);
		}
	};

	const isFormValid = useMemo(
		() => !!(name.trim() && type.trim() && licensePlate.trim()),
		[name, type, licensePlate]
	);

	const formContent = useMemo(
		() => (
			<div className="space-y-3 min-w-0">
				{/* Name */}
				<div>
					<label className={LABEL}>Name *</label>
					<input
						type="text"
						placeholder="e.g. Unit 4 — Service Van"
						value={name}
						onChange={(e) => setName(e.target.value)}
						className={INPUT}
						disabled={isLoading}
					/>
					<ErrorDisplay path="name" />
				</div>

				{/* Type + License Plate */}
				<div className="grid grid-cols-2 gap-2">
					<div>
						<label className={LABEL}>Type *</label>
						<input
							type="text"
							placeholder="Van, Truck, Sedan…"
							value={type}
							onChange={(e) => setType(e.target.value)}
							className={INPUT}
							disabled={isLoading}
						/>
						<ErrorDisplay path="type" />
					</div>
					<div>
						<label className={LABEL}>
							License Plate / ID *
						</label>
						<input
							type="text"
							placeholder="e.g. ABC-1234 · UNIT-7"
							value={licensePlate}
							onChange={(e) =>
								setLicensePlate(e.target.value)
							}
							className={INPUT}
							disabled={isLoading}
						/>
						<ErrorDisplay path="license_plate" />
					</div>
				</div>

				{/* Optional divider */}
				<div className={DIVIDER_LABEL}>
					<div className="flex-1 h-px bg-surface" />
					<span className="text-[10px] text-text-muted uppercase tracking-widest">
						Vehicle details (optional)
					</span>
					<div className="flex-1 h-px bg-surface" />
				</div>

				{/* Year + Make + Model */}
				<div className="grid grid-cols-4 gap-2">
					<div>
						<label className={LABEL}>Year</label>
						<input
							type="number"
							placeholder="2021"
							value={year}
							onChange={(e) => setYear(e.target.value)}
							className={INPUT}
							disabled={isLoading}
						/>
					</div>
					<div>
						<label className={LABEL}>Make</label>
						<input
							type="text"
							placeholder="Ford"
							value={make}
							onChange={(e) => setMake(e.target.value)}
							className={INPUT}
							disabled={isLoading}
						/>
					</div>
					<div>
						<label className={LABEL}>Model</label>
						<input
							type="text"
							placeholder="Transit"
							value={model}
							onChange={(e) => setModel(e.target.value)}
							className={INPUT}
							disabled={isLoading}
						/>
					</div>
					<div>
						<label className={LABEL}>Miles</label>
						<input
							type="number"
							placeholder="50000"
							value={odometer}
							onChange={(e) => setOdometer(e.target.value)}
							className={INPUT}
							disabled={isLoading}
						/>
					</div>
				</div>

				{/* Color + Status */}
				<div className="grid grid-cols-2 gap-2">
					<div>
						<label className={LABEL}>Color</label>
						<input
							type="text"
							placeholder="Pearl White"
							value={color}
							onChange={(e) => setColor(e.target.value)}
							className={INPUT}
							disabled={isLoading}
						/>
					</div>
					<div>
						<label className={LABEL}>Status</label>
						<select
							value={status}
							onChange={(e) =>
								setStatus(
									e.target.value as
										| "active"
										| "inactive"
								)
							}
							className={INPUT}
							disabled={isLoading}
						>
							<option value="active">Active</option>
							<option value="inactive">Inactive</option>
						</select>
					</div>
				</div>

				<div
					className="relative min-w-0"
					style={{ zIndex: 50 }}
				>
					<label className={LABEL}>Stored at</label>
					<AddressForm
						mode={geoData ? "edit" : "create"}
						originalValue={
							geoData?.address || ""
						}
						originalCoords={geoData?.coords}
						dropdownPosition="above"
						handleChange={handleChangeAddress}
						handleClear={handleClearAddress}
					/>
				</div>

				{/* Notes */}
				<div>
					<label className={LABEL}>Notes</label>
					<textarea
						placeholder="Optional internal notes…"
						value={notes}
						onChange={(e) => setNotes(e.target.value)}
						disabled={isLoading}
						className="border border-border px-2.5 py-1.5 w-full h-16 rounded bg-base text-primary text-sm resize-none focus:border-primary focus:outline-none transition-colors min-w-0"
					/>
				</div>
			</div>
		),
		[
			name,
			type,
			licensePlate,
			year,
			make,
			model,
			color,
			status,
			notes,
			odometer,
			isLoading,
			errors,
			geoData,
		]
	);

	return (
		<FormWizardContainer
			title="New Vehicle"
			steps={[]}
			currentStep={1}
			visitedSteps={new Set([1])}
			isLoading={isLoading}
			isOpen={isModalOpen}
			onClose={() => setIsModalOpen(false)}
			onSubmit={invokeCreate}
			canGoNext={isFormValid}
			submitLabel="Create Vehicle"
		>
			{formContent}
		</FormWizardContainer>
	);
}
