import { useRef, useState, useEffect } from "react";
import FullPopup from "../ui/FullPopup";
import { PriorityValues } from "../../types/common";
import { type CreateJobInput } from "../../types/jobs";
import type { Request } from "../../types/requests";
import { normalizeCoords, type Coordinates, type GeocodeResult } from "../../types/location";
import Dropdown from "../ui/Dropdown";
import AddressForm from "../ui/AddressForm";
import { FormErrorBanner } from "../ui/forms/FormErrorBanner";
import { errorMessage } from "../../util/util";

interface ConvertToJobProps {
	isModalOpen: boolean;
	setIsModalOpen: (open: boolean) => void;
	request: Request;
	onConvert: (jobData: CreateJobInput) => Promise<string>;
}

export default function ConvertToJob({
	isModalOpen,
	setIsModalOpen,
	request,
	onConvert,
}: ConvertToJobProps) {
	const nameRef = useRef<HTMLInputElement>(null);
	const descRef = useRef<HTMLTextAreaElement>(null);
	const priorityRef = useRef<HTMLSelectElement>(null);
	const requestCoords = normalizeCoords(request.coords);
	const [geoData, setGeoData] = useState<{ address: string; coords?: Coordinates } | undefined>(
		request.address || requestCoords
			? { address: request.address || "", coords: requestCoords }
			: undefined
	);
	const [isLoading, setIsLoading] = useState(false);
	const [nameError, setNameError] = useState<string | null>(null);
	const [addressError, setAddressError] = useState<string | null>(null);
	const [submitError, setSubmitError] = useState<string | null>(null);

	useEffect(() => {
		if (isModalOpen && priorityRef.current) {
			const requestPriority = request.priority;
			if (PriorityValues.includes(requestPriority)) {
				priorityRef.current.value = requestPriority;
			} else {
				priorityRef.current.value = "Medium";
			}
		}
	}, [isModalOpen, request.priority]);

	const handleChangeAddress = (result: GeocodeResult) => {
		setGeoData({ address: result.address, coords: result.coords });
		setAddressError(null);
	};

	const handleClearAddress = () => {
		if (request.address || requestCoords) {
			setGeoData({ address: request.address || "", coords: requestCoords });
		} else {
			setGeoData(undefined);
		}
		setAddressError(null);
	};

	const priorityEntries = (
		<>
			{PriorityValues.map((v) => (
				<option key={v} value={v} className="text-black">
					{v}
				</option>
			))}
		</>
	);

	const invokeConvert = async () => {
		if (!nameRef.current || !descRef.current || !priorityRef.current || isLoading)
			return;

		const nameValue = nameRef.current.value.trim();
		const descValue = descRef.current.value.trim();
		const priorityValue = priorityRef.current.value.trim() as
			| "Low"
			| "Medium"
			| "High"
			| "Urgent"
			| "Emergency";

		setNameError(null);
		setAddressError(null);
		setSubmitError(null);

		let hasError = false;
		if (!nameValue) {
			setNameError("Job name is required");
			hasError = true;
		}
		if (!geoData?.address) {
			setAddressError("Job address is required");
			hasError = true;
		}
		if (hasError) return;

		setIsLoading(true);
		try {
			const jobData: CreateJobInput = {
				name: nameValue,
				client_id: request.client_id,
				request_id: request.id,
				address: geoData!.address,
				coords: geoData!.coords || { lat: 0, lon: 0 },
				description: descValue,
				priority: priorityValue,
				status: "Unscheduled",
			};

			await onConvert(jobData);

			if (nameRef.current) nameRef.current.value = "";
			if (descRef.current) descRef.current.value = "";
			setGeoData(undefined);
			setNameError(null);
			setAddressError(null);
			setIsModalOpen(false);
		} catch (error) {
			console.error("Failed to convert request to job:", error);
			setSubmitError(
				errorMessage(error, "Failed to convert request to job.")
			);
		} finally {
			setIsLoading(false);
		}
	};

	const content = (
		<div className="flex flex-col min-h-0 flex-1">
			{/* Header */}
			<div className="flex items-center justify-between px-4 lg:px-6 py-3 lg:py-4 border-b border-border-subtle flex-shrink-0">
				<h2 className="text-lg lg:text-xl font-bold text-text-primary">
					Convert to Job
				</h2>
			</div>

			{/* Scrollable body */}
			<div className="flex-1 overflow-y-auto px-4 lg:px-6 py-4 lg:py-5 space-y-3 lg:space-y-4">
				{/* Job Name */}
				<div>
					<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
						Job Name *
					</label>
					<input
						type="text"
						placeholder="Job Name"
						className="border border-border px-2.5 py-1.5 lg:py-2 w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors"
						disabled={isLoading}
						ref={nameRef}
						defaultValue={request.title}
						onChange={() => setNameError(null)}
					/>
					{nameError && (
						<p className="text-error-text text-xs mt-0.5">
							{nameError}
						</p>
					)}
				</div>

				{/* Description */}
				<div>
					<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
						Description
					</label>
					<textarea
						placeholder="Job Description"
						className="border border-border px-2.5 py-1.5 lg:py-2 w-full h-20 lg:h-24 rounded bg-base text-text-primary text-sm lg:text-base resize-none focus:border-primary focus:outline-none transition-colors"
						disabled={isLoading}
						ref={descRef}
						defaultValue={request.description}
					/>
				</div>

				{/* Address */}
				<div className="relative" style={{ zIndex: 50 }}>
					<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
						Job Address *
					</label>
					<AddressForm
						mode={request.address ? "edit" : "create"}
						originalValue={request.address || ""}
						originalCoords={requestCoords}
						dropdownPosition="above"
						handleChange={handleChangeAddress}
						handleClear={handleClearAddress}
					/>
					{addressError && (
						<p className="text-error-text text-xs mt-0.5">
							{addressError}
						</p>
					)}
				</div>

				{/* Priority */}
				<div>
					<label className="block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider">
						Priority
					</label>
					<Dropdown
						refToApply={priorityRef}
						entries={priorityEntries}
					/>
				</div>

				{/* Note */}
				<div className="p-3 bg-warning-bg border border-warning-border rounded-md">
					<p className="text-xs text-warning-text">
						Note: The job will be created in "Unscheduled"
						status. You can create visits and assign technicians
						after creation.
					</p>
				</div>
			</div>

			{/* Footer */}
			<div className="border-t border-border-subtle flex-shrink-0">
				<FormErrorBanner message={submitError} className="mx-4 lg:mx-6 mt-3" />
				<div className="flex items-center justify-end gap-2 px-4 lg:px-6 py-3 lg:py-4">
					<button
						onClick={() => setIsModalOpen(false)}
						disabled={isLoading}
						className="px-4 py-2 text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-surface rounded-md border border-border transition-colors disabled:opacity-50"
					>
						Cancel
					</button>
					<button
						onClick={invokeConvert}
						disabled={isLoading}
						className="px-4 py-2 text-sm font-medium bg-primary-hover hover:bg-primary-active text-on-primary rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{isLoading ? "Creating..." : "Create Job"}
					</button>
				</div>
			</div>
		</div>
	);

	return (
		<FullPopup
			content={content}
			isModalOpen={isModalOpen}
			onClose={() => !isLoading && setIsModalOpen(false)}
		/>
	);
}
