import { useState, useRef, useEffect } from "react";
import FullPopup from "../ui/FullPopup";
import DatePicker from "../ui/DatePicker";
import { type CreateQuoteInput } from "../../types/quotes";
import { PriorityValues } from "../../types/common";
import type { Request } from "../../types/requests";
import { normalizeCoords, type Coordinates, type GeocodeResult } from "../../types/location";
import Dropdown from "../ui/Dropdown";
import AddressForm from "../ui/AddressForm";
import { FormErrorBanner } from "../ui/forms/FormErrorBanner";
import { errorMessage } from "../../util/util";
import { X } from "lucide-react";

interface ConvertToQuoteProps {
	isModalOpen: boolean;
	setIsModalOpen: (open: boolean) => void;
	request: Request;
	onConvert: (quoteData: CreateQuoteInput) => Promise<string>;
}

const LABEL = "block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider";
const INPUT =
	"border border-border px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors";

export default function ConvertToQuote({
	isModalOpen,
	setIsModalOpen,
	request,
	onConvert,
}: ConvertToQuoteProps) {
	const titleRef = useRef<HTMLInputElement>(null);
	const descRef = useRef<HTMLTextAreaElement>(null);
	const priorityRef = useRef<HTMLSelectElement>(null);
	const [validUntil, setValidUntil] = useState<Date | null>(null);
	const [expiresAt, setExpiresAt] = useState<Date | null>(null);
	const requestCoords = normalizeCoords(request.coords);
	const [geoData, setGeoData] = useState<{ address: string; coords?: Coordinates } | undefined>(
		request.address || requestCoords
			? { address: request.address || "", coords: requestCoords }
			: undefined
	);
	const [isLoading, setIsLoading] = useState(false);
	const [titleError, setTitleError] = useState<string | null>(null);
	const [submitError, setSubmitError] = useState<string | null>(null);

	useEffect(() => {
		if (isModalOpen && priorityRef.current) {
			priorityRef.current.value = "Medium";
		}
		if (!isModalOpen) {
			setValidUntil(null);
			setExpiresAt(null);
			setTitleError(null);
		}
	}, [isModalOpen]);

	const handleChangeAddress = (result: GeocodeResult) => {
		setGeoData({ address: result.address, coords: result.coords });
	};

	const handleClearAddress = () => {
		if (request.address || requestCoords) {
			setGeoData({ address: request.address || "", coords: requestCoords });
		} else {
			setGeoData(undefined);
		}
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
		if (!titleRef.current || !descRef.current || !priorityRef.current || isLoading)
			return;

		const titleValue = titleRef.current.value.trim();
		const descValue = descRef.current.value.trim();
		const priorityValue = priorityRef.current.value.trim() as "Low" | "Medium" | "High";

		setTitleError(null);
		setSubmitError(null);
		if (!titleValue) {
			setTitleError("Quote title is required");
			return;
		}

		setIsLoading(true);
		try {
			const quoteData: CreateQuoteInput = {
				client_id: request.client_id,
				request_id: request.id,
				title: titleValue,
				description: descValue,
				address: geoData?.address || "",
				coords: geoData?.coords,
				priority: priorityValue,
				status: "Draft",
				subtotal: 0,
				tax_rate: 0,
				tax_amount: 0,
				discount_amount: 0,
				total: 0,
				valid_until: validUntil ? validUntil.toISOString() : undefined,
				expires_at: expiresAt ? expiresAt.toISOString() : undefined,
				line_items: [],
			};

			await onConvert(quoteData);

			if (titleRef.current) titleRef.current.value = "";
			if (descRef.current) descRef.current.value = "";
			setValidUntil(null);
			setExpiresAt(null);
			setGeoData(undefined);
			setTitleError(null);
			setIsModalOpen(false);
		} catch (error) {
			console.error("Failed to convert request to quote:", error);
			setSubmitError(
				errorMessage(error, "Failed to convert request to quote.")
			);
		} finally {
			setIsLoading(false);
		}
	};

	const content = (
		<div className="flex flex-col min-h-0 flex-1">
			{/* Header */}
			<div className="flex items-center justify-between px-4 sm:px-5 pt-4 pb-3 border-b border-border flex-shrink-0">
				<h2 className="text-lg sm:text-xl font-bold text-text-primary whitespace-nowrap">
					Convert to Quote
				</h2>
				<button
					onClick={() => !isLoading && setIsModalOpen(false)}
					disabled={isLoading}
					className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-surface rounded transition-colors disabled:opacity-50"
				>
					<X size={18} />
				</button>
			</div>

			{/* Body */}
			<div className="flex-1 overflow-y-auto px-4 sm:px-5 pt-3 sm:pt-4 pb-4 space-y-4 min-h-0">
				{/* Title */}
				<div>
					<label className={LABEL}>Quote Title *</label>
					<input
						type="text"
						placeholder="Quote Title"
						className={INPUT}
						disabled={isLoading}
						ref={titleRef}
						defaultValue={request.title}
						onChange={() => setTitleError(null)}
					/>
					{titleError && (
						<p className="text-error-text text-xs mt-0.5">
							{titleError}
						</p>
					)}
				</div>

				{/* Description */}
				<div>
					<label className={LABEL}>Description</label>
					<textarea
						placeholder="Quote Description"
						className="border border-border px-2.5 py-1.5 w-full h-20 rounded bg-base text-text-primary text-sm resize-none focus:border-primary focus:outline-none transition-colors"
						disabled={isLoading}
						ref={descRef}
						defaultValue={request.description}
					/>
				</div>

				{/* Address */}
				<div>
					<label className={LABEL}>Property Address</label>
					<AddressForm
						mode={request.address ? "edit" : "create"}
						originalValue={request.address || ""}
						originalCoords={requestCoords}
						dropdownPosition="below"
						handleChange={handleChangeAddress}
						handleClear={handleClearAddress}
					/>
				</div>

				{/* Priority */}
				<div>
					<label className={LABEL}>Priority</label>
					<Dropdown
						refToApply={priorityRef}
						entries={priorityEntries}
					/>
				</div>

				{/* Valid Until + Expires At */}
				<div className="grid grid-cols-2 gap-2 lg:gap-3">
					<div>
						<label className={LABEL}>Valid Until</label>
						<DatePicker
							portal
							value={validUntil}
							onChange={setValidUntil}
							disabled={isLoading}
							align="left"
						/>
					</div>
					<div>
						<label className={LABEL}>Expires At</label>
						<DatePicker
							portal
							value={expiresAt}
							onChange={setExpiresAt}
							disabled={isLoading}
							align="right"
						/>
					</div>
				</div>

				{/* Note */}
				<div className="p-3 bg-warning-bg border border-warning-border rounded-md">
					<p className="text-xs text-warning-text">
						The quote will be created with no line items. You
						can add pricing details after creation.
					</p>
				</div>
			</div>

			{/* Footer */}
			<div className="border-t border-border bg-base flex-shrink-0">
				<FormErrorBanner message={submitError} className="mx-4 mt-2.5" />
				<div className="flex items-center justify-end gap-2 px-4 py-2.5">
					<button
						onClick={() => setIsModalOpen(false)}
						disabled={isLoading}
						className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-border bg-transparent text-sm font-medium text-text-tertiary hover:text-text-primary hover:bg-surface hover:border-border-strong transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
					>
						Cancel
					</button>
					<button
						onClick={invokeConvert}
						disabled={isLoading}
						className="inline-flex items-center h-8 px-4 rounded-md bg-primary-hover hover:bg-primary disabled:bg-surface-raised disabled:text-text-muted text-sm font-semibold text-on-primary transition-colors disabled:cursor-not-allowed whitespace-nowrap"
					>
						{isLoading ? "Creating..." : "Create Quote"}
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
