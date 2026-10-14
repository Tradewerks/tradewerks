import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { isAxiosError } from "axios";
import { Upload, X, Trash2, Lock, Barcode as BarcodeIcon } from "lucide-react";
import { BarcodeScanner } from "./BarcodeScanner";
import { FormWizardContainer } from "../ui/forms/FormWizardContainer";
import { TemplateSearch, type TemplateSearchResult } from "../ui/forms/TemplateSearch";
import { useStepWizard } from "../../hooks/forms/useStepWizard";
import {
	useCreateInventoryItemMutation,
	useUpdateInventoryItemMutation,
	useUploadInventoryImageMutation,
	useInventoryTagsQuery,
	useSetItemTagsMutation,
} from "../../hooks/useInventory";
import {
	useEnsureItemCodeMutation,
	useUpdateItemTrackingMutation,
	useTrackingEligibilityQuery,
} from "../../hooks/useTracking";
import { receiveInventory } from "../../api/tracking";
import { invalidate } from "../../lib/queryKeys";
import { useQueryClient } from "@tanstack/react-query";
import { useLabelQueueStore } from "../../stores/labelQueueStore";
import { useToast } from "../ui/useToast";
import ConfirmDialog from "../ui/ConfirmDialog";
import {
	useQBStatusQuery,
	useQBItemsQuery,
	useQBMappedItemsQuery,
	useImportQBItemMutation,
} from "../../hooks/useQuickbooks";
import type {
	InventoryItem,
	CreateInventoryItemInput,
	UpdateInventoryItemInput,
} from "../../types/inventory";
import type { ReceiveInventoryInput } from "../../types/tracking";
import SerialCaptureList from "./tracking/SerialCaptureList";
import BatchCaptureFields, { type BatchCaptureValue } from "./tracking/BatchCaptureFields";
import SupplierPicker from "./SupplierPicker";
import type { SupplierCapture } from "../../types/suppliers";
import UnitSelect from "../ui/forms/UnitSelect";
import ToggleSwitch from "../ui/ToggleSwitch";
import {
	DEFAULT_UNIT_CODE,
	formatQty,
	normalizeUnitCode,
	unitLabel,
	type UnitCode,
} from "../../lib/units";
import { isStorableStockQty } from "./stockQtyPrecision";

const MAX_FILE_MB = Number(import.meta.env.VITE_MAX_UPLOAD_MB) || 15;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type Step = 1 | 2 | 3 | 4;

interface CreateInventoryItemProps {
	isOpen: boolean;
	onClose: () => void;
	existingItem?: InventoryItem | null;
	prefillBarcode?: string;
	/** Seeds the Name field on a fresh create (e.g. from an unmatched search). */
	initialName?: string;
	/** Distinct categories already in use, for the Category datalist. Passed in
	 *  by callers that already hold the item list, so the modal doesn't fire a
	 *  second full-inventory request just to suggest strings. */
	categorySuggestions?: string[];
	/** Fired on a successful create (not edit), with the new item. */
	onCreated?: (item: InventoryItem) => void;
}

const BASE_STEPS: { id: Step; label: string }[] = [
	{ id: 1, label: "Basics" },
	{ id: 2, label: "Stock & Pricing" },
	{ id: 3, label: "Images & Review" },
];

const INPUT =
	"border border-border px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors min-w-0";
// Same box, red border. Applied only once a step's errors have been revealed —
// a form that opens pre-painted in red is noise, not guidance.
const INPUT_INVALID =
	"border border-error px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-error focus:outline-none transition-colors min-w-0";
const LABEL = "block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider";

/** Field caps mirrored from the server's Zod schemas
 *  (`backend/src/lib/validate/inventory.ts`), so a violation is caught on the
 *  step that owns the field instead of surfacing as a raw message at Save. */
const LIMITS = {
	name: 255,
	location: 255,
	description: 5000,
	sku: 100,
	category: 100,
	barcode: 200,
} as const;

/** Length check against a cap, measured on the trimmed value the form submits. */
function tooLong(label: string, value: string, max: number): string | undefined {
	const length = value.trim().length;
	if (length <= max) return undefined;
	return `${label} must be ${max} characters or fewer — currently ${length}.`;
}

/** Per-step validation result: field key → message. Empty object = step passes. */
type FieldErrors = Record<string, string>;

// Stable identity so the memoized lookups below don't churn on every render.
const NO_ERRORS: FieldErrors = {};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Message under a field, shown only for revealed steps. */
function FieldMessage({ children }: { children?: string }) {
	if (!children) return null;
	return <p className="mt-1 text-[11px] text-error-text">{children}</p>;
}

/**
 * Says why the wizard didn't move, once the user has tried to leave the step.
 * `listMessages` is for the capture step, whose errors have no field slot of
 * their own; other steps just point at the marked fields instead of repeating
 * messages already shown beside each input.
 */
function StepErrorSummary({
	errors,
	listMessages = false,
}: {
	errors: FieldErrors;
	listMessages?: boolean;
}) {
	const messages = Object.values(errors);
	if (messages.length === 0) return null;
	return (
		<div className="rounded-lg border border-error-border bg-error-bg px-3 py-2">
			{listMessages ? (
				<ul className="space-y-0.5 pl-4 list-disc">
					{messages.map((m) => (
						<li key={m} className="text-xs text-error-text">
							{m}
						</li>
					))}
				</ul>
			) : (
				<p className="text-xs text-error-text">
					Fix the {messages.length === 1 ? "field" : `${messages.length} fields`}{" "}
					marked below before continuing.
				</p>
			)}
		</div>
	);
}

// Unwraps the common axios-error-message shape used across this form's
// submit/catch sites, falling back to a plain Error message and finally to
// the caller-supplied default.
function getApiErrorMessage(e: unknown, fallback: string): string {
	if (isAxiosError(e)) {
		return e.response?.data?.error?.message || fallback;
	}
	return e instanceof Error ? e.message : fallback;
}

/**
 * What the unit field is seeded with for a stored value: the canonical catalog
 * code for a code or alias ("LBS" → "lb"), the RAW string for a legacy value
 * outside the catalog (kept verbatim so an unrelated edit can't rewrite it), or
 * the default for a blank.
 */
function seedUnit(stored: string | null | undefined): string {
	const raw = typeof stored === "string" ? stored.trim() : "";
	return normalizeUnitCode(raw) ?? (raw || DEFAULT_UNIT_CODE);
}

export default function CreateInventoryItem({
	isOpen,
	onClose,
	existingItem,
	prefillBarcode,
	categorySuggestions = [],
	onCreated,
	initialName,
}: CreateInventoryItemProps) {
	const isEdit = !!existingItem;

	const [qbSearchOpen, setQbSearchOpen] = useState(false);
	const [selectedQBId, setSelectedQBId] = useState("");

	const [name, setName] = useState("");
	const [sku, setSku] = useState("");
	const [category, setCategory] = useState("");
	const [barcode, setBarcode] = useState("");
	const [isScannerOpen, setIsScannerOpen] = useState(false);
	const [description, setDescription] = useState("");
	const [location, setLocation] = useState("");
	const [quantity, setQuantity] = useState(0);
	// A string, not a UnitCode: an item saved before the unit catalog existed can
	// hold a value no alias maps onto ("skein"), and that raw value has to
	// survive an unrelated edit untouched (see seedUnit / unitChanged below).
	const [unit, setUnit] = useState<string>(DEFAULT_UNIT_CODE);
	// Decision 5: changing the unit of an item with stock on hand re-reads that
	// stock in the new unit, so the server requires an explicit acknowledgement.
	const [acknowledgeUnitChange, setAcknowledgeUnitChange] = useState(false);
	// Set when the server rejected the save for want of the acknowledgement on
	// stock this form couldn't see — shows the checkbox so the user can answer.
	const [ackRequiredByServer, setAckRequiredByServer] = useState(false);
	const [unitPrice, setUnitPrice] = useState("");
	const [cost, setCost] = useState("");
	const [lowStockEnabled, setLowStockEnabled] = useState(false);
	const [lowStockThreshold, setLowStockThreshold] = useState("");
	const [alertEmailsEnabled, setAlertEmailsEnabled] = useState(false);
	const [alertEmail, setAlertEmail] = useState("");
	const [imageUrls, setImageUrls] = useState<string[]>([]);
	const [altIds, setAltIds] = useState<string[]>([]);
	const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
	const [isUploading, setIsUploading] = useState(false);
	const [uploadErrors, setUploadErrors] = useState<{ name: string; reason: string }[]>([]);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const [isLoading, setIsLoading] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);

	// Serial/batch tracking toggles. In create mode they seed a brand-new item;
	// in edit mode they mirror the item's current tracking and can be flipped
	// (enable / disable / switch) subject to the empty-only backend policy.
	const [isSerialized, setIsSerialized] = useState(false);
	const [isBatchTracked, setIsBatchTracked] = useState(false);
	// Disabling/switching tracking is a meaningful change — confirm it first.
	const [trackingConfirmOpen, setTrackingConfirmOpen] = useState(false);
	const [serialCaptureValues, setSerialCaptureValues] = useState<string[]>([]);
	const [batchCaptureValue, setBatchCaptureValue] = useState<BatchCaptureValue>({
		mode: "new",
		batch_number: "",
		expires_at: null,
	});
	// Who the opening quantity was bought from. Only meaningful on create: an
	// edit never moves stock, so there's no receipt to attribute.
	const [openingSupplier, setOpeningSupplier] = useState<SupplierCapture>({});

	const createMutation = useCreateInventoryItemMutation();
	const updateMutation = useUpdateInventoryItemMutation();
	const uploadMutation = useUploadInventoryImageMutation();
	const setTagsMutation = useSetItemTagsMutation();
	const importMutation = useImportQBItemMutation();
	const ensureCodeMutation = useEnsureItemCodeMutation();
	const queryClient = useQueryClient();
	const updateTrackingMutation = useUpdateItemTrackingMutation(existingItem?.id ?? "");
	const addToLabelQueue = useLabelQueueStore((s) => s.add);
	const toast = useToast();

	// Tracking edits are gated server-side by PATCH /tracking: zero on-hand
	// across the warehouse AND every vehicle, plus no live serial/lot for a
	// disable or switch. GET /tracking-eligibility returns that same verdict so
	// the toggles can't unlock on something the server will reject —
	// existingItem.quantity alone only sees the warehouse column, blind to units on a van.
	const { data: eligibility, isLoading: eligibilityLoading } = useTrackingEligibilityQuery(
		existingItem?.id ?? "",
		isEdit && isOpen,
	);
	const itemIsTracked =
		isEdit && !!existingItem && (existingItem.is_serialized || existingItem.is_batch_tracked);
	// Falls back to the warehouse-only proxy while the eligibility check is
	// loading or failed; the server is authoritative either way.
	const emptyFallback = isEdit && !!existingItem && existingItem.quantity === 0;
	// Enable path: currently-untracked item that's empty everywhere.
	const canEnableTracking =
		isEdit &&
		!!existingItem &&
		!itemIsTracked &&
		(eligibility ? eligibility.can_enable : emptyFallback);
	// Disable/switch path: tracked item with nothing live left to account for.
	const canModifyTracking =
		itemIsTracked && (eligibility ? eligibility.can_disable : emptyFallback);
	// Always rendered — hiding it left "why can't I turn tracking on?" unanswered.
	const showTrackingControls = true;
	// QB import creates the item with QuickBooks' on-hand quantity, and the
	// server only allows enabling tracking on an empty item, so QB items stay locked.
	const trackingLocked = (isEdit && !canEnableTracking && !canModifyTracking) || !!selectedQBId;
	// Rows that would survive a disable, so the callout can promise what happens
	// to them rather than leaving the dispatcher to guess.
	const retainedHistory = (eligibility?.history_serials ?? 0) + (eligibility?.history_lots ?? 0);
	// The change turns OFF a currently-tracked dimension (pure disable, or the
	// "off" half of a switch) — the case worth confirming before it fires.
	const isDisablingOrSwitching =
		isEdit &&
		!!existingItem &&
		((existingItem.is_serialized && !isSerialized) ||
			(existingItem.is_batch_tracked && !isBatchTracked));
	const { data: allTags = [] } = useInventoryTagsQuery();

	// QuickBooks import — create mode only, when connected
	const qbConnected = !!useQBStatusQuery().data?.connected;
	const qbImportAvailable = qbConnected && !isEdit;
	const { data: qbItems = [], isLoading: qbItemsLoading } = useQBItemsQuery(
		qbImportAvailable && isOpen,
	);
	const { data: mappedItems = [] } = useQBMappedItemsQuery(qbImportAvailable && isOpen);

	// QB items not yet linked to any inventory item
	const availableQBItems = useMemo(() => {
		const mappedExternalIds = new Set(mappedItems.map((m) => m.external_id));
		return qbItems.filter((q) => !mappedExternalIds.has(q.Id));
	}, [qbItems, mappedItems]);

	// QB item import: searchable card-list results (no client concept for inventory)
	const qbItemResults = useMemo<TemplateSearchResult[]>(
		() =>
			availableQBItems.map((q) => ({
				id: q.Id,
				title: q.Name,
				subtitle: q.Sku ? `SKU ${q.Sku}` : undefined,
				detail: q.Description ?? undefined,
				value: q.UnitPrice != null ? `$${q.UnitPrice}` : undefined,
			})),
		[availableQBItems],
	);

	// Label for the chip shown once a QB item has been picked
	const selectedQBLabel = useMemo(() => {
		if (!selectedQBId) return null;
		return qbItems.find((q) => q.Id === selectedQBId)?.Name ?? "selected item";
	}, [selectedQBId, qbItems]);

	// Tracked items with a positive initial quantity get a capture step
	// inserted BEFORE images/review (position 3, pushing review to 4) —
	// reachable only after the item itself is created (see
	// handleCreateTrackedItemStage): SerialCaptureList's "already exists"
	// check needs a real itemId, which doesn't exist until then. Non-tracked
	// items and tracked-but-zero-qty items keep the plain 3-step flow
	// (nothing to capture).
	// Compared against what the select was SEEDED with: the canonical code for
	// a catalog alias ("LBS" → lb), or the raw string for a legacy value outside
	// the catalog. Only a pick the user actually made registers as a change —
	// which is what decides whether `unit` travels in the PATCH at all. The old
	// normalized comparison hid the flip on legacy values and the payload sent
	// `unit` unconditionally, silently rewriting "gallon"/"Each" on any edit.
	const seededUnit = existingItem ? seedUnit(existingItem.unit) : DEFAULT_UNIT_CODE;
	const unitChanged = isEdit && !!existingItem && unit !== seededUnit;
	// Stored unit isn't in the catalog and nothing maps onto it.
	const legacyUnit =
		isEdit &&
		!!existingItem &&
		normalizeUnitCode(existingItem.unit) === null &&
		seededUnit !== DEFAULT_UNIT_CODE;
	// On-hand as the server would count it for decision 5: warehouse + vehicles
	// (and live serials/lots), from the eligibility read when it has landed, else
	// the warehouse-only column this form always has.
	const onHandForUnitChange = eligibility
		? eligibility.qty_warehouse + eligibility.qty_on_vehicles
		: (existingItem?.quantity ?? 0);
	const hasStockOnHand =
		isEdit &&
		!!existingItem &&
		(eligibility
			? onHandForUnitChange !== 0 || eligibility.live_serials > 0 || eligibility.live_lots > 0
			: existingItem.quantity !== 0);
	const showUnitAcknowledgement = unitChanged && (hasStockOnHand || ackRequiredByServer);

	const showCaptureStep = !isEdit && !selectedQBId && (isSerialized || isBatchTracked) && quantity > 0;

	// Only editable on a plain create (seeds the opening balance). On edit/QB
	// import the server ignores whatever's sent, so the field is locked instead
	// of pretending to be live.
	const quantityReadOnly = isEdit || !!selectedQBId;
	const quantityEscapeHatch = !isEdit
		? "Set from the QuickBooks item's on-hand quantity."
		: isSerialized || isBatchTracked
			? "Add units with Receive Stock; correct a miscount with Adjust Stock."
			: "Change this with Adjust Stock, so the movement is recorded.";

	const STEPS = useMemo(() => {
		if (!showCaptureStep) return BASE_STEPS;
		return [
			BASE_STEPS[0],
			BASE_STEPS[1],
			{
				id: 3 as Step,
				label:
					isSerialized && isBatchTracked
						? "Serials & Batch"
						: isSerialized
							? "Serial Numbers"
							: "Batch / Lot",
			},
			{ id: 4 as Step, label: BASE_STEPS[2].label },
		];
	}, [showCaptureStep, isSerialized, isBatchTracked]);

	const {
		currentStep,
		visitedSteps,
		goNext,
		goBack,
		goToStep,
		reset: resetWizard,
		pruneVisited,
	} = useStepWizard<Step>({ totalSteps: (showCaptureStep ? 4 : 3) as Step, initialStep: 1 as Step });

	// When the capture step is inserted or removed, later step ids shift meaning
	// (review is id 4 with capture, id 3 without). Drop any visited marker ahead
	// of the current step so a stale "seen" flag can't paint a step the user
	// hasn't actually reached under the new layout. Keyed only on the layout flip
	// — reading currentStep via a ref keeps normal navigation untouched.
	const currentStepRef = useRef(currentStep);
	currentStepRef.current = currentStep;
	useEffect(() => {
		pruneVisited((s) => s <= currentStepRef.current);
	}, [showCaptureStep, pruneVisited]);

	// Seed the form from the item ONCE per open (or when the drawer is pointed at
	// a different item) — not on every new object identity. The detail page
	// passes the live query result, which is a fresh object on every refetch
	// (tracking flip, socket update, even presigned image URLs rotating), and
	// re-seeding on identity wiped whatever the user had typed mid-edit.
	const existingItemRef = useRef(existingItem);
	existingItemRef.current = existingItem;
	const existingItemId = existingItem?.id;
	useEffect(() => {
		const existingItem = existingItemRef.current;
		if (isOpen && existingItem) {
			setName(existingItem.name);
			setSku(existingItem.sku || "");
			setCategory(existingItem.category || "");
			setBarcode(existingItem.barcode || "");
			setDescription(existingItem.description);
			setLocation(existingItem.location || "");
			setQuantity(existingItem.quantity);
			setUnit(seedUnit(existingItem.unit));
			setUnitPrice(
				existingItem.unit_price != null
					? String(existingItem.unit_price)
					: ""
			);
			setCost(existingItem.cost != null ? String(existingItem.cost) : "");
			setLowStockEnabled(existingItem.low_stock_threshold !== null);
			setLowStockThreshold(
				existingItem.low_stock_threshold !== null
					? String(existingItem.low_stock_threshold)
					: ""
			);
			setAlertEmailsEnabled(existingItem.alert_emails_enabled);
			setAlertEmail(existingItem.alert_email || "");
			setImageUrls(existingItem.image_urls ?? []);
			setSelectedTagIds(existingItem.tags?.map((t) => t.id) ?? []);
			setAltIds(existingItem.alt_ids ?? []);
			// Mirror current tracking so edit-mode toggles reflect reality and can
			// be flipped (create mode leaves these at their false defaults).
			setIsSerialized(existingItem.is_serialized);
			setIsBatchTracked(existingItem.is_batch_tracked);
		}
	}, [isOpen, existingItemId]);

	useEffect(() => {
		if (isOpen && !existingItem && prefillBarcode) {
			setBarcode(prefillBarcode);
		}
	}, [isOpen, existingItem, prefillBarcode]);

	useEffect(() => {
		if (isOpen && !existingItem && initialName) {
			setName(initialName);
		}
	}, [isOpen, existingItem, initialName]);

	const resetForm = useCallback(() => {
		resetWizard();
		setQbSearchOpen(false);
		setSelectedQBId("");
		setName("");
		setSku("");
		setCategory("");
		setBarcode("");
		setDescription("");
		setLocation("");
		setQuantity(0);
		setUnit(DEFAULT_UNIT_CODE);
		setAcknowledgeUnitChange(false);
		setAckRequiredByServer(false);
		setUnitPrice("");
		setCost("");
		setLowStockEnabled(false);
		setLowStockThreshold("");
		setAlertEmailsEnabled(false);
		setAlertEmail("");
		setImageUrls([]);
		setAltIds([]);
		setSelectedTagIds([]);
		setUploadErrors([]);
		setIsLoading(false);
		setSubmitError(null);
		setRevealedSteps(new Set());
		setIsSerialized(false);
		setIsBatchTracked(false);
		setSerialCaptureValues([]);
		setBatchCaptureValue({ mode: "new", batch_number: "", expires_at: null });
		setOpeningSupplier({});
	}, [resetWizard]);

	useEffect(() => {
		if (!isOpen) resetForm();
	}, [isOpen, resetForm]);

	// Apply a chosen QB item to the form, then close the search overlay.
	const handleSelectQBItem = useCallback(
		(id: string) => {
			setSelectedQBId(id);
			const q = qbItems.find((item) => item.Id === id);
			if (q) {
				setName(q.Name);
				setSku(q.Sku ?? "");
				setDescription(q.Description ?? "");
				setQuantity(q.QtyOnHand ?? 0);
				setUnitPrice(q.UnitPrice != null ? String(q.UnitPrice) : "");
				setCost(q.PurchaseCost != null ? String(q.PurchaseCost) : "");
			}
			setQbSearchOpen(false);
		},
		[qbItems],
	);

	// ── Per-step validation ──────────────────────────────────────────────
	// Field-level errors, not a single boolean — Next/header jumps/Submit all
	// read the same maps, so a step is never left invalid and the reason is
	// renderable instead of implied by a dead button.

	const step1Errors = useMemo<FieldErrors>(() => {
		const e: FieldErrors = {};
		// Required first, then the server's length cap — every text field on this step has one.
		if (!name.trim()) e.name = "Name is required.";
		else {
			const msg = tooLong("Name", name, LIMITS.name);
			if (msg) e.name = msg;
		}
		const locationMsg = tooLong("Location", location, LIMITS.location);
		if (locationMsg) e.location = locationMsg;
		const skuMsg = tooLong("SKU", sku, LIMITS.sku);
		if (skuMsg) e.sku = skuMsg;
		const categoryMsg = tooLong("Category", category, LIMITS.category);
		if (categoryMsg) e.category = categoryMsg;
		const barcodeMsg = tooLong("Barcode", barcode, LIMITS.barcode);
		if (barcodeMsg) e.barcode = barcodeMsg;
		const descriptionMsg = tooLong("Description", description, LIMITS.description);
		if (descriptionMsg) e.description = descriptionMsg;
		return e;
	}, [name, location, sku, category, barcode, description]);

	const step2Errors = useMemo<FieldErrors>(() => {
		const e: FieldErrors = {};
		// numeric(10,2) allows fractional, except a serialized item — a serial is
		// one indivisible unit and the capture step requires enteredSerials.length === quantity.
		if (!quantityReadOnly) {
			if (isSerialized) {
				if (!Number.isInteger(quantity) || quantity < 0)
					e.quantity = "Quantity must be a whole number of 0 or more.";
			} else if (quantity < 0 || !isStorableStockQty(quantity)) {
				e.quantity = "Quantity must be 0 or more, to two decimal places.";
			}
		}
		if (unitPrice.trim() && !(Number(unitPrice) >= 0))
			e.unitPrice = "Unit price must be a number of 0 or more.";
		if (cost.trim() && !(Number(cost) >= 0)) e.cost = "Cost must be a number of 0 or more.";
		if (lowStockEnabled) {
			const threshold = lowStockThreshold.trim();
			// Blank still means 0 (buildPayload's long-standing behavior); only a
			// value that was typed and is unusable counts as an error.
			if (threshold) {
				const n = Number(threshold);
				if (!(n >= 0) || !isStorableStockQty(n))
					e.lowStockThreshold =
						"Low-stock threshold must be 0 or more, to two decimal places.";
			}
			// Gated on lowStockEnabled as well as alertEmailsEnabled: the email
			// row is only rendered inside the low-stock block, and a blocking
			// error on a field nobody can see is a dead end.
			if (alertEmailsEnabled) {
				const email = alertEmail.trim();
				if (!email) e.alertEmail = "Alert email is required while email alerts are on.";
				else if (!EMAIL_RE.test(email)) e.alertEmail = "Enter a valid email address.";
			}
		}
		return e;
	}, [
		quantityReadOnly,
		isSerialized,
		quantity,
		unitPrice,
		cost,
		lowStockEnabled,
		lowStockThreshold,
		alertEmailsEnabled,
		alertEmail,
	]);

	const captureErrors = useMemo<FieldErrors>(() => {
		if (!showCaptureStep) return NO_ERRORS;
		const e: FieldErrors = {};
		if (isSerialized) {
			const entered = serialCaptureValues.map((s) => s.trim()).filter(Boolean);
			if (entered.length !== quantity)
				e.serials = `Enter exactly ${quantity} serial number${
					quantity === 1 ? "" : "s"
				} — ${entered.length} entered so far.`;
			// Serial numbers are unique per item server-side, so a duplicate is a
			// guaranteed rejection at Submit. Catch it on the step that owns it.
			else if (new Set(entered).size !== entered.length)
				e.serialsDuplicate = "Serial numbers must be unique.";
		}
		if (
			isBatchTracked &&
			batchCaptureValue.mode === "new" &&
			!batchCaptureValue.batch_number.trim()
		)
			e.batch = "Enter a batch/lot number.";
		return e;
	}, [
		showCaptureStep,
		isSerialized,
		isBatchTracked,
		serialCaptureValues,
		quantity,
		batchCaptureValue,
	]);

	const errorsForStep = useCallback(
		(step: Step): FieldErrors => {
			if (step === 1) return step1Errors;
			if (step === 2) return step2Errors;
			if (step === 3 && showCaptureStep) return captureErrors;
			// Images/review has no inputs of its own to validate.
			return NO_ERRORS;
		},
		[step1Errors, step2Errors, captureErrors, showCaptureStep],
	);

	const isStepValid = useCallback(
		(step: Step) => Object.keys(errorsForStep(step)).length === 0,
		[errorsForStep],
	);

	// Errors stay hidden until the user tries to leave a step (Next, a header
	// jump, or Submit). Revealing on first keystroke would paint a brand-new
	// form red before anything has been attempted.
	const [revealedSteps, setRevealedSteps] = useState<Set<Step>>(new Set());
	const revealStep = useCallback((step: Step) => {
		setRevealedSteps((prev) => (prev.has(step) ? prev : new Set(prev).add(step)));
	}, []);

	// What the CURRENT step renders. Every other step's errors are gating input,
	// not display.
	const shownErrors = revealedSteps.has(currentStep) ? errorsForStep(currentStep) : NO_ERRORS;

	// First step that fails, in wizard order — the step Submit sends the user
	// back to, and the reason a later step can't be reached.
	const firstInvalidStep = useCallback((): Step | null => {
		const ordered: Step[] = showCaptureStep ? [1, 2, 3] : [1, 2];
		return ordered.find((s) => !isStepValid(s)) ?? null;
	}, [showCaptureStep, isStepValid]);

	// Next never advances out of an invalid step. It stays ENABLED so the click
	// has somewhere to land: a disabled button just refused, silently, and the
	// user's next move was to jump ahead by the step header instead.
	const handleNext = useCallback(() => {
		if (!isStepValid(currentStep)) {
			revealStep(currentStep);
			return;
		}
		goNext();
	}, [isStepValid, currentStep, revealStep, goNext]);

	// Header navigation: backward is always free; forward requires every step
	// before the target to validate. Edit mode's free jumps still respect that —
	// prefilled data already validates, so nothing changes until a field breaks.
	const canGoToStep = useCallback(
		(targetStep: Step): boolean => {
			if (targetStep === currentStep) return true;
			if (targetStep < currentStep) return true;
			for (let s = 1 as Step; s < targetStep; s = (s + 1) as Step) {
				if (!isStepValid(s)) return false;
			}
			if (isEdit) return true;
			return visitedSteps.has(targetStep) || targetStep === currentStep + 1;
		},
		[isEdit, currentStep, visitedSteps, isStepValid],
	);

	// Wraps every submit path. Sends the user back to the first invalid step
	// with its errors showing instead of letting the server catch it at Save.
	const guardSubmit = useCallback(
		(run: () => void) => () => {
			const blocking = firstInvalidStep();
			if (blocking === null) {
				run();
				return;
			}
			revealStep(blocking);
			setSubmitError(null);
			if (blocking !== currentStep) goToStep(blocking);
		},
		[firstInvalidStep, revealStep, currentStep, goToStep],
	);

	const handleUploadImages = useCallback(
		async (files: FileList | File[]) => {
			const errors: { name: string; reason: string }[] = [];
			const valid: File[] = [];

			for (const file of Array.from(files)) {
				if (!ALLOWED_MIME_TYPES.has(file.type)) {
					errors.push({ name: file.name, reason: "unsupported format — JPEG, PNG, or WebP only" });
				} else if (file.size > MAX_FILE_BYTES) {
					errors.push({ name: file.name, reason: `exceeds the ${MAX_FILE_MB}MB size limit` });
				} else {
					valid.push(file);
				}
			}

			setUploadErrors(errors);

			if (!valid.length) return;

			setIsUploading(true);
			try {
				const urls = await Promise.all(valid.map((file) => uploadMutation.mutateAsync(file)));
				setImageUrls((prev) => [...prev, ...urls]);
			} catch (e) {
				console.error("Image upload failed:", e);
			} finally {
				setIsUploading(false);
			}
		},
		[uploadMutation]
	);

	const handleRemoveImage = useCallback((index: number) => {
		setImageUrls((prev) => prev.filter((_, i) => i !== index));
	}, []);

	// Best-effort — a new item is ready to label immediately; failure here
	// must never block the create flow (the item card menu covers this later).
	// Shared by the plain-create path and the tracked-item creation stage.
	const queueNewItemLabel = useCallback(
		async (created: InventoryItem) => {
			try {
				const code = created.barcode ?? (await ensureCodeMutation.mutateAsync(created.id)).barcode;
				if (code) {
					addToLabelQueue({
						id: created.id,
						code,
						kind: "item",
						primaryLabel: created.name,
						secondaryLabel: created.sku ?? undefined,
						isSerialized: created.is_serialized,
						isBatchTracked: created.is_batch_tracked,
					});
				}
			} catch {
				// no-op
			}
		},
		[ensureCodeMutation, addToLabelQueue]
	);

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			if (e.dataTransfer.files.length) {
				handleUploadImages(e.dataTransfer.files);
			}
		},
		[handleUploadImages]
	);

	// Shared by handleSubmit (plain create/edit/QB paths) and
	// handleCreateTrackedItemStage (tracked+qty>0 path) — quantity is
	// overridden to 0 by the caller when the item is tracked and needs its
	// initial stock captured via a separate receive call instead.
	const buildPayload = useCallback(
		() => ({
			name: name.trim(),
			sku: sku.trim() || null,
			category: category.trim() || null,
			barcode: barcode.trim() || null,
			description: description.trim(),
			location: location.trim() || null,
			quantity,
			// No trim-or-default: the select can't emit a blank or an alias. On an
			// edit, handleSubmit strips this unless the user actually changed it.
			unit,
			unit_price: unitPrice ? Number(unitPrice) : null,
			cost: cost ? Number(cost) : null,
			low_stock_threshold: lowStockEnabled ? Number(lowStockThreshold) || 0 : null,
			image_urls: imageUrls,
			// Alert email is only rendered inside the low-stock block; sending it
			// while low stock is off could ship a stale address the server rejects
			// but the form isn't showing.
			alert_emails_enabled: lowStockEnabled && alertEmailsEnabled,
			alert_email:
				lowStockEnabled && alertEmailsEnabled ? alertEmail.trim() || null : null,
			alt_ids: altIds.map((s) => s.trim()).filter(Boolean),
		}),
		[
			name,
			sku,
			category,
			barcode,
			description,
			location,
			quantity,
			unit,
			unitPrice,
			cost,
			lowStockEnabled,
			lowStockThreshold,
			imageUrls,
			alertEmailsEnabled,
			alertEmail,
			altIds,
		],
	);

	const handleSubmit = async () => {
		if (isLoading) return;
		setIsLoading(true);
		setSubmitError(null);

		try {
			if (isEdit && existingItem) {
				// Tracking (PATCH /tracking) fires FIRST: it has its own server-side
				// gate and is most likely to be rejected, so a failure here leaves
				// nothing else written. Only fires when the flags actually changed
				// and the item is eligible; enabling adds units later via Receive Stock.
				const trackingChanged =
					isSerialized !== existingItem.is_serialized ||
					isBatchTracked !== existingItem.is_batch_tracked;
				if (trackingChanged && (canEnableTracking || canModifyTracking)) {
					try {
						await updateTrackingMutation.mutateAsync({
							is_serialized: isSerialized,
							is_batch_tracked: isBatchTracked,
						});
						toast.success("Tracking updated");
					} catch (trackingErr) {
						toast.error(getApiErrorMessage(trackingErr, "Failed to update tracking"));
						throw trackingErr;
					}
				}

				const data: UpdateInventoryItemInput = buildPayload();
				// Quantity is derived from the stock ledger, not editable here — the
				// server strips it from PATCH /inventory/:id anyway. Stock moves via
				// Adjust Stock / Receive Stock.
				delete data.quantity;
				// `unit` only travels when the user changed it. Sending the seeded
				// value back would rewrite a legacy/aliased stored unit on an
				// unrelated edit — the ledger keeps every movement's own unit, so
				// the item's label must not drift without anyone asking for it.
				if (!unitChanged) delete data.unit;
				else if (acknowledgeUnitChange) data.acknowledge_unit_change = true;
				try {
					await updateMutation.mutateAsync({ itemId: existingItem.id, data });
				} catch (updateErr) {
					// The server saw stock this form didn't (e.g. the eligibility
					// read hadn't landed): surface the checkbox so the user can
					// confirm and resubmit, instead of a dead end.
					if (unitChanged && /acknowledge_unit_change/.test(getApiErrorMessage(updateErr, ""))) {
						setAckRequiredByServer(true);
					}
					throw updateErr;
				}
				await setTagsMutation.mutateAsync({ itemId: existingItem.id, tagIds: selectedTagIds });
			} else if (selectedQBId) {
				// Create the item + QB mapping from the QB item, then apply any edits
				const result = await importMutation.mutateAsync({ qb_item_id: selectedQBId });
				const created = result.item;
				const data: UpdateInventoryItemInput = buildPayload();
				// Same as the edit path: PATCH ignores quantity. On a QB import the
				// opening quantity comes from the QB item's QtyOnHand, recorded as
				// an `initial` ledger movement by importQBItem — the form has no say.
				delete data.quantity;
				// importQBItem already set the sku from QB (or nulled it if globally
				// taken). Only re-send sku if the user actually changed it in the form
				// — otherwise we'd redundantly re-assert the QB sku and, when it's
				// taken, re-trigger the conflict and block the import.
				const qbItem = qbItems.find((q) => q.Id === selectedQBId);
				if (sku.trim() === (qbItem?.Sku ?? "")) {
					delete data.sku;
				}
				await updateMutation.mutateAsync({ itemId: created.id, data });
				if (selectedTagIds.length > 0) {
					await setTagsMutation.mutateAsync({ itemId: created.id, tagIds: selectedTagIds });
				}
				onCreated?.(created);
			} else {
				// The opening quantity is a receipt, so it carries a vendor; the
				// server drops the field when quantity is 0 and nothing moves.
				const data: CreateInventoryItemInput = { ...buildPayload(), ...openingSupplier };
				// Tracked-but-zero-qty items are created in a single call same as
				// any plain item — there's nothing to receive (see
				// handleCreateTrackedItemStage for the tracked+qty>0 path, which
				// wires its own submit handler and never reaches this branch).
				if (isSerialized) data.is_serialized = true;
				if (isBatchTracked) data.is_batch_tracked = true;
				const created = await createMutation.mutateAsync(data);
				if (selectedTagIds.length > 0) {
					await setTagsMutation.mutateAsync({ itemId: created.id, tagIds: selectedTagIds });
				}
				await queueNewItemLabel(created);
				onCreated?.(created);
			}
			onClose();
		} catch (e) {
			console.error("Failed to save inventory item:", e);
			setSubmitError(getApiErrorMessage(e, "Failed to save inventory item"));
		} finally {
			setIsLoading(false);
		}
	};

	// Tracked item with a positive initial quantity: nothing is written during
	// the wizard — it all happens here at Submit. Create the item (quantity
	// forced to 0, tracking flags on, images from the review step included via
	// buildPayload), set tags, then record the locally-captured serials/batch as
	// initial stock via a single receive call, queue labels, and close.
	const handleSubmitTracked = async () => {
		if (isLoading) return;

		const enteredSerials = serialCaptureValues.filter((s) => s.trim());
		if (isSerialized && enteredSerials.length !== quantity) {
			setSubmitError(
				`Enter exactly ${quantity} serial number${
					quantity === 1 ? "" : "s"
				} (currently ${enteredSerials.length}).`,
			);
			return;
		}
		if (isBatchTracked && batchCaptureValue.mode === "new" && !batchCaptureValue.batch_number.trim()) {
			setSubmitError("Enter a batch/lot number.");
			return;
		}

		setIsLoading(true);
		setSubmitError(null);

		try {
			const data: CreateInventoryItemInput = {
				...buildPayload(),
				quantity: 0,
				is_serialized: isSerialized,
				is_batch_tracked: isBatchTracked,
			};
			const created = await createMutation.mutateAsync(data);
			if (selectedTagIds.length > 0) {
				await setTagsMutation.mutateAsync({ itemId: created.id, tagIds: selectedTagIds });
			}
			await queueNewItemLabel(created);

			const input: ReceiveInventoryInput = {
				qty: quantity,
				...openingSupplier,
				...(isSerialized ? { serial_numbers: serialCaptureValues.map((s) => s.trim()) } : {}),
				...(isBatchTracked
					? batchCaptureValue.mode === "existing"
						? { batch_id: batchCaptureValue.batch_id }
						: {
								batch: {
									batch_number: batchCaptureValue.batch_number.trim(),
									expires_at: batchCaptureValue.expires_at,
								},
							}
					: {}),
			};

			const result = await receiveInventory(created.id, input);
			invalidate.warehouse(queryClient);

			// Best-effort — never block finishing on label-queue failures.
			try {
				for (const serial of result.created_serials ?? []) {
					addToLabelQueue({
						id: serial.id,
						code: serial.code,
						kind: "serial",
						primaryLabel: created.name,
						secondaryLabel: serial.serial_number,
					});
				}
				if (result.batch) {
					addToLabelQueue({
						id: result.batch.id,
						code: result.batch.code,
						kind: "batch",
						primaryLabel: created.name,
						secondaryLabel: result.batch.batch_number,
					});
				}
			} catch {
				// no-op
			}

			onCreated?.({ ...created, quantity });
			onClose();
		} catch (e) {
			// Create may have succeeded while receive failed — the item then
			// exists at qty 0 and is visible in the list; stock can be received
			// later. Surface the error and stay open so the user can retry.
			console.error("Failed to save tracked item:", e);
			setSubmitError(
				getApiErrorMessage(
					e,
					"Failed to save item. If it was created, you can receive stock for it later.",
				),
			);
		} finally {
			setIsLoading(false);
		}
	};

	const stepContent = (() => {
		// QuickBooks item import — full-height searchable card list (same UX as
		// the QB invoice import in CreateInvoice / draft import in CreateJob).
		if (qbSearchOpen) {
			return (
				<TemplateSearch
					heading="Import from QuickBooks"
					placeholder="Search by item name or SKU…"
					results={qbItemResults}
					clients={[]}
					isLoading={qbItemsLoading}
					onSelect={handleSelectQBItem}
					onClose={() => setQbSearchOpen(false)}
				/>
			);
		}

		// Images/review — the final step for every flow (plain create/edit/QB
		// import land here at step 3; the tracked+qty>0 flow lands here at
		// step 4, after capture). Pulled out so both cases can share it
		// instead of duplicating this JSX.
		const renderImagesReview = () => (
			<div className="space-y-4 min-w-0">
				{submitError && (
					<div className="p-3 bg-error-bg border border-error-border rounded-lg">
						<p className="text-sm text-error-text">{submitError}</p>
					</div>
				)}
				{/* Image Upload */}
				<div>
					<label className={LABEL}>Images</label>
					<div
						onDrop={handleDrop}
						onDragOver={(e) => e.preventDefault()}
						onClick={() => fileInputRef.current?.click()}
						className="border-2 border-dashed border-border rounded-lg p-6 text-center cursor-pointer hover:border-border-strong transition-colors"
					>
						<Upload size={24} className="mx-auto mb-2 text-text-muted" />
						<p className="text-sm text-text-tertiary">
							{isUploading ? "Uploading..." : "Drop images here or click to browse"}
						</p>
						<p className="text-xs text-text-muted mt-1">
							JPEG, PNG, WebP — max {MAX_FILE_MB}MB each
						</p>
						<input
							ref={fileInputRef}
							type="file"
							accept="image/jpeg,image/png,image/webp"
							multiple
							className="hidden"
							onChange={(e) => {
								if (e.target.files?.length) {
									handleUploadImages(e.target.files);
									e.target.value = "";
								}
							}}
						/>
					</div>

					{uploadErrors.length > 0 && (
						<div className="mt-2 p-3 bg-error-bg border border-error-border rounded-lg">
							<p className="text-xs font-semibold text-error-text mb-1.5 uppercase tracking-wide">
								{uploadErrors.length} file{uploadErrors.length > 1 ? "s" : ""} rejected
							</p>
							<ul className="space-y-1">
								{uploadErrors.map((err, i) => (
									<li key={i} className="text-xs text-error-text">
										<span className="font-medium">{err.name}</span>
										{" — "}
										{err.reason}
									</li>
								))}
							</ul>
						</div>
					)}
				</div>

				{/* Image Preview Grid */}
				{imageUrls.length > 0 && (
					<div className="grid grid-cols-3 gap-2">
						{imageUrls.map((url, i) => (
							<div key={i} className="relative group">
								<img
									src={url}
									alt={`Upload ${i + 1}`}
									className="w-full h-24 object-cover rounded border border-border"
								/>
								<button
									type="button"
									onClick={() => handleRemoveImage(i)}
									className="absolute top-1 right-1 w-5 h-5 rounded-full bg-error text-on-primary flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
								>
									<X size={12} />
								</button>
							</div>
						))}
					</div>
				)}

				{/* Summary — reads like the record about to be created: identity and
				    tracking up top, operational facts below. */}
				<div className="border border-border rounded-lg overflow-hidden">
					<div className="flex items-start justify-between gap-3 bg-surface/40 p-4">
						<div className="min-w-0">
							<h3 className="truncate text-base font-semibold text-text-primary">
								{name || "Untitled item"}
							</h3>
							{(sku || barcode) && (
								<p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-xs text-text-muted">
									{sku && <span>SKU {sku}</span>}
									{sku && barcode && <span className="text-text-faint">·</span>}
									{barcode && <span>#{barcode}</span>}
								</p>
							)}
						</div>
						{(isSerialized || isBatchTracked) && (
							<div className="flex shrink-0 items-center gap-1">
								{isSerialized && (
									<span className="shrink-0 rounded border border-primary/30 bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary-text">
										Serialized
									</span>
								)}
								{isBatchTracked && (
									<span className="shrink-0 rounded border border-reviewing/30 bg-reviewing/15 px-1.5 py-0.5 text-[10px] font-semibold text-reviewing-text">
										Batch
									</span>
								)}
							</div>
						)}
					</div>

					<dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border p-4 text-sm">
						<div className="flex items-baseline justify-between gap-2 min-w-0">
							<dt className="text-text-tertiary">Location</dt>
							<dd className="truncate text-right text-text-primary">{location || "—"}</dd>
						</div>
						<div className="flex items-baseline justify-between gap-2 min-w-0">
							<dt className="text-text-tertiary">Quantity</dt>
							<dd className="text-right tabular-nums text-text-primary">
								{formatQty(quantity, unit)}
							</dd>
						</div>
						{unitPrice && (
							<div className="flex items-baseline justify-between gap-2 min-w-0">
								<dt className="text-text-tertiary">Unit price</dt>
								<dd className="text-right tabular-nums text-text-primary">
									${Number(unitPrice).toFixed(2)}
								</dd>
							</div>
						)}
						{cost && (
							<div className="flex items-baseline justify-between gap-2 min-w-0">
								<dt className="text-text-tertiary">Cost</dt>
								<dd className="text-right tabular-nums text-text-primary">
									${Number(cost).toFixed(2)}
								</dd>
							</div>
						)}
						{lowStockEnabled && (
							<div className="flex items-baseline justify-between gap-2 min-w-0">
								<dt className="text-text-tertiary">Low stock at</dt>
								<dd className="text-right tabular-nums text-text-primary">
									{lowStockThreshold || 0}
								</dd>
							</div>
						)}
						<div className="flex items-baseline justify-between gap-2 min-w-0">
							<dt className="text-text-tertiary">Images</dt>
							<dd className="text-right tabular-nums text-text-primary">{imageUrls.length}</dd>
						</div>
						{altIds.filter((s) => s.trim()).length > 0 && (
							<div className="flex items-baseline justify-between gap-2 min-w-0">
								<dt className="text-text-tertiary">Alternate IDs</dt>
								<dd className="text-right tabular-nums text-text-primary">
									{altIds.filter((s) => s.trim()).length}
								</dd>
							</div>
						)}
					</dl>

					{(isSerialized || isBatchTracked) && quantity > 0 && (
						<p className="border-t border-border px-4 py-2.5 text-xs text-text-muted">
							{quantity} unit{quantity === 1 ? "" : "s"} will be recorded{" "}
							{isSerialized && isBatchTracked
								? "with serial numbers and a batch/lot"
								: isSerialized
									? "with serial numbers"
									: "under a batch/lot"}{" "}
							on save.
						</p>
					)}
				</div>
			</div>
		);

		switch (currentStep) {
			case 1:
				return (
					<div className="space-y-2 lg:space-y-3 xl:space-y-4 min-w-0">
						<StepErrorSummary errors={shownErrors} />

						{/* Imported-from-QuickBooks chip */}
						{selectedQBId && (
							<div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm">
								<span className="text-primary-text font-medium">
									Imported from QuickBooks: {selectedQBLabel}
								</span>
								{qbImportAvailable && (
									<button
										type="button"
										onClick={() => setQbSearchOpen(true)}
										disabled={isLoading}
										className="ml-auto text-primary hover:underline"
									>
										Change
									</button>
								)}
							</div>
						)}

						<div className="min-w-0">
							<label className={LABEL}>Name *</label>
							<input
								type="text"
								placeholder="Item Name"
								value={name}
								onChange={(e) =>
									setName(e.target.value)
								}
								className={shownErrors.name ? INPUT_INVALID : INPUT}
								aria-invalid={!!shownErrors.name}
								disabled={isLoading}
							/>
							<FieldMessage>{shownErrors.name}</FieldMessage>
						</div>

						<div className="grid grid-cols-2 gap-2 lg:gap-3 min-w-0">
							<div className="min-w-0">
								<label className={LABEL}>SKU</label>
								<input
									type="text"
									placeholder="e.g. PVC-ELB-24"
									value={sku}
									onChange={(e) =>
										setSku(
											e.target
												.value
										)
									}
									className={
										shownErrors.sku ? INPUT_INVALID : INPUT
									}
									aria-invalid={!!shownErrors.sku}
									disabled={isLoading}
								/>
								<FieldMessage>{shownErrors.sku}</FieldMessage>
							</div>
							<div className="min-w-0">
								<label className={LABEL}>
									Location
								</label>
								<input
									type="text"
									placeholder="e.g. A42 - 325"
									value={location}
									onChange={(e) =>
										setLocation(
											e.target
												.value
										)
									}
									className={
										shownErrors.location
											? INPUT_INVALID
											: INPUT
									}
									aria-invalid={!!shownErrors.location}
									disabled={isLoading}
								/>
								<FieldMessage>{shownErrors.location}</FieldMessage>
							</div>
						</div>

						{/* Single-valued grouping axis, deliberately not a tag — an item
						    with three tags couldn't sit in one bucket. Datalist steers
						    toward existing spellings so "Filters"/"filters" don't fragment. */}
						<div className="min-w-0">
							<label className={LABEL}>Category</label>
							<input
								type="text"
								list="inventory-category-suggestions"
								placeholder="e.g. Refrigerants"
								value={category}
								onChange={(e) => setCategory(e.target.value)}
								className={shownErrors.category ? INPUT_INVALID : INPUT}
								aria-invalid={!!shownErrors.category}
								disabled={isLoading}
							/>
							<FieldMessage>{shownErrors.category}</FieldMessage>
							{categorySuggestions.length > 0 && (
								<datalist id="inventory-category-suggestions">
									{categorySuggestions.map((c) => (
										<option key={c} value={c} />
									))}
								</datalist>
							)}
						</div>

						<div className="min-w-0">
							<label className={LABEL}>Barcode / QR Code</label>
							<div className="flex items-center gap-1.5">
								<input
									type="text"
									data-barcode-input="true"
									placeholder="UPC-A, EAN-13, Code128, QR…"
									value={barcode}
									onChange={(e) => setBarcode(e.target.value)}
									className={
										shownErrors.barcode ? INPUT_INVALID : INPUT
									}
									aria-invalid={!!shownErrors.barcode}
									disabled={isLoading}
								/>
								<button
									type="button"
									onClick={() => setIsScannerOpen(true)}
									disabled={isLoading}
									aria-label="Scan barcode"
									className="h-[34px] w-[34px] shrink-0 flex items-center justify-center rounded border border-border text-text-muted hover:text-primary hover:border-primary transition-colors"
								>
									<BarcodeIcon size={16} />
								</button>
							</div>
							<FieldMessage>{shownErrors.barcode}</FieldMessage>
						</div>

						<div className="min-w-0">
							<label className={LABEL}>Alternate IDs</label>
							{altIds.length > 0 && (
								<div className="grid grid-cols-2 gap-2 lg:gap-3 mb-1.5 min-w-0">
									{altIds.map((id, i) => (
										<div key={i} className="flex items-center gap-1 min-w-0">
											<input
												type="text"
												value={id}
												onChange={(e) =>
													setAltIds(
														altIds.map((v, j) =>
															j === i ? e.target.value : v
														)
													)
												}
												className={INPUT}
												disabled={isLoading}
												placeholder="e.g. MFR-12345"
											/>
											<button
												type="button"
												onClick={() =>
													setAltIds(altIds.filter((_, j) => j !== i))
												}
												disabled={isLoading}
												aria-label="Remove"
												className="h-[34px] w-[34px] shrink-0 flex items-center justify-center rounded border border-border text-text-muted hover:text-error hover:border-error transition-colors"
											>
												<Trash2 size={14} />
											</button>
										</div>
									))}
								</div>
							)}
							<button
								type="button"
								onClick={() => setAltIds([...altIds, ""])}
								disabled={isLoading}
								className="text-xs text-primary hover:underline"
							>
								+ Add ID
							</button>
						</div>

						<div className="min-w-0">
							<label className={LABEL}>Description</label>
							<textarea
								placeholder="Item description"
								value={description}
								onChange={(e) =>
									setDescription(
										e.target.value
									)
								}
								className={`border px-2.5 py-1.5 lg:py-2 w-full h-20 lg:h-24 rounded bg-base text-text-primary text-sm lg:text-base resize-none focus:outline-none transition-colors min-w-0 ${
									shownErrors.description
										? "border-error focus:border-error"
										: "border-border focus:border-primary"
								}`}
								aria-invalid={!!shownErrors.description}
								disabled={isLoading}
							/>
							<FieldMessage>{shownErrors.description}</FieldMessage>
						</div>

						<div className="min-w-0">
							<label className={LABEL}>Tags</label>
							{allTags.length === 0 ? (
								<p className="text-xs text-muted mt-0.5">
									No tags yet — create some from the inventory page.
								</p>
							) : (
								<div className="flex flex-wrap gap-1.5 mt-0.5">
									{allTags.map((tag) => {
										const selected = selectedTagIds.includes(tag.id);
										return (
											<button
												key={tag.id}
												type="button"
												onClick={() =>
													setSelectedTagIds(
														selected
															? selectedTagIds.filter((id) => id !== tag.id)
															: [...selectedTagIds, tag.id]
													)
												}
												disabled={isLoading}
												className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border transition-colors ${
													selected
														? "bg-primary-bg border-primary text-primary-text"
														: "bg-base border-border text-muted hover:border-border-strong hover:text-secondary"
												}`}
											>
												{tag.label}
											</button>
										);
									})}
								</div>
							)}
						</div>
					</div>
				);

			case 2:
				return (
					<div className="space-y-2 lg:space-y-3 xl:space-y-4 min-w-0">
						<StepErrorSummary errors={shownErrors} />

						<div className="grid grid-cols-4 gap-2 lg:gap-3 min-w-0">
							<div className="min-w-0">
								<label className={LABEL}>
									Quantity
								</label>
								{quantityReadOnly ? (
									// Derived from the stock ledger, so this points at the
									// endpoint that can actually move it instead of
									// accepting input the server would discard.
									<>
										<div
											className={`${INPUT} flex items-center justify-between gap-2 cursor-default select-none`}
											aria-label="Quantity"
											aria-readonly="true"
										>
											<span className="tabular-nums">
												{quantity}
											</span>
											<Lock
												size={12}
												className="text-text-faint flex-shrink-0"
												aria-hidden
											/>
										</div>
										<p className="text-[10px] text-text-muted mt-1">
											{quantityEscapeHatch}
										</p>
									</>
								) : (
									<>
										<input
											type="number"
											min="0"
											aria-label="Quantity"
											value={quantity}
											onChange={(e) =>
												setQuantity(
													Math.max(
														0,
														Number(
															e
																.target
																.value
														)
													)
												)
											}
											className={
												shownErrors.quantity
													? INPUT_INVALID
													: INPUT
											}
											aria-invalid={!!shownErrors.quantity}
											disabled={isLoading}
										/>
										<FieldMessage>
											{shownErrors.quantity}
										</FieldMessage>
									</>
								)}
							</div>
							<div className="min-w-0">
								<label className={LABEL}>
									Unit
								</label>
								{/* A legacy unit can't sit in the select: a native
								    <select> whose value matches no option falls back
								    to its first option, which would SHOW "Each" over a
								    stored "skein". So the raw value is shown as-is, and
								    the select only appears once the user asks to pick —
								    the stored unit stays untouched until then. */}
								{legacyUnit && !unitChanged && existingItem ? (
									<>
										<div className="flex items-center gap-2">
											<div
												className="flex-1 min-w-0 h-[34px] px-2.5 flex items-center rounded border border-border bg-surface text-sm lg:text-base text-text-primary truncate"
												title={existingItem.unit}
												aria-label="Unit of measure (legacy)"
											>
												{existingItem.unit}
											</div>
											<button
												type="button"
												onClick={() => setUnit(DEFAULT_UNIT_CODE)}
												disabled={isLoading}
												className="shrink-0 text-xs font-medium text-primary hover:underline disabled:opacity-50"
											>
												Choose a catalog unit
											</button>
										</div>
										<p className="mt-1 text-[11px] leading-relaxed text-text-muted">
											Legacy unit “{existingItem.unit}” — choose a catalog
											unit. It isn’t in the unit catalog, so it stays
											exactly as stored until you pick one.
										</p>
									</>
								) : (
									<UnitSelect
										value={unit as UnitCode}
										onChange={setUnit}
										disabled={isLoading}
									/>
								)}
								{/* Informational only, not a block: the ledger keeps each
								    movement's original unit, but totals spanning the
								    change can't be summed across units. */}
								{unitChanged && (
									<p className="mt-1 text-[11px] leading-relaxed text-text-muted">
										Past movements stay recorded in{" "}
										{unitLabel(existingItem?.unit)}
										. Usage and stock totals that
										span the change will read as
										mixed units instead of a total,
										until the whole range shares one
										unit.
										{legacyUnit && existingItem && (
											<>
												{" "}
												<button
													type="button"
													onClick={() => setUnit(seededUnit)}
													disabled={isLoading}
													className="font-medium text-primary hover:underline disabled:opacity-50"
												>
													Keep “{existingItem.unit}”
												</button>
											</>
										)}
									</p>
								)}
								{/* Decision 5: stock on hand is re-read in the new unit,
								    not converted. The server refuses the change without
								    this flag, so the checkbox is the form's way of asking
								    the question before the server has to. */}
								{showUnitAcknowledgement && (
									<label className="mt-2 flex items-start gap-2 rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-xs text-text-primary cursor-pointer">
										<input
											type="checkbox"
											checked={acknowledgeUnitChange}
											onChange={(e) => setAcknowledgeUnitChange(e.target.checked)}
											disabled={isLoading}
											className="mt-0.5 h-3.5 w-3.5 rounded border-border bg-base text-primary focus:ring-primary cursor-pointer"
										/>
										<span>
											I understand the on-hand quantity ({onHandForUnitChange}) will now be read in{" "}
											{unitLabel(unit)}.
										</span>
									</label>
								)}
							</div>
							<div className="min-w-0">
								<label className={LABEL}>
									Unit Price ($)
								</label>
								<input
									type="number"
									min="0"
									step="0.01"
									placeholder="0.00"
									value={unitPrice}
									onChange={(e) =>
										setUnitPrice(
											e.target
												.value
										)
									}
									className={
										shownErrors.unitPrice
											? INPUT_INVALID
											: INPUT
									}
									aria-invalid={!!shownErrors.unitPrice}
									disabled={isLoading}
								/>
								<FieldMessage>{shownErrors.unitPrice}</FieldMessage>
							</div>
							<div className="min-w-0">
								<label className={LABEL}>
									Cost ($)
								</label>
								<input
									type="number"
									min="0"
									step="0.01"
									placeholder="0.00"
									value={cost}
									onChange={(e) =>
										setCost(
											e.target
												.value
										)
									}
									className={
										shownErrors.cost ? INPUT_INVALID : INPUT
									}
									aria-invalid={!!shownErrors.cost}
									disabled={isLoading}
								/>
								<FieldMessage>{shownErrors.cost}</FieldMessage>
							</div>
						</div>

						{/* Only on create with stock arriving: an edit moves nothing, so
						    there is no receipt to attribute to a vendor. */}
						{!isEdit && quantity > 0 && (
							<div className="min-w-0 max-w-sm">
								<SupplierPicker
									value={openingSupplier}
									onChange={setOpeningSupplier}
									label="Supplier (optional)"
									disabled={isLoading}
								/>
								<p className="mt-1 text-[11px] leading-relaxed text-text-muted">
									Who the opening {unitLabel(unit, quantity)} came from.
									Recorded on the receipt, not on the item.
								</p>
							</div>
						)}

						{showTrackingControls && (
							<div className="border border-border rounded-lg p-3 space-y-3">
								<div className="flex items-center justify-between">
									<label className="text-sm font-medium text-text-primary">
										Track by Serial Number
									</label>
									<ToggleSwitch
										checked={isSerialized}
										onChange={() => setIsSerialized((prev) => !prev)}
										disabled={isLoading || trackingLocked}
										ariaLabel="Track by serial number"
									/>
								</div>

								<div className="flex items-center justify-between">
									<label className="text-sm font-medium text-text-primary">
										Track by Batch / Lot
									</label>
									<ToggleSwitch
										checked={isBatchTracked}
										onChange={() => setIsBatchTracked((prev) => !prev)}
										disabled={isLoading || trackingLocked}
										ariaLabel="Track by batch or lot"
									/>
								</div>

								{selectedQBId ? (
									// A disabled toggle with no reason attached is worse than
									// no toggle at all.
									<div className="rounded-md border border-border-subtle bg-surface px-3 py-2 text-xs text-text-secondary">
										<span className="font-medium">
											Tracking isn’t available on a QuickBooks import.
										</span>{" "}
										The item is created with QuickBooks’ on-hand quantity,
										and tracking can only be turned on while an item is
										empty. Import it first, then enable tracking from the
										item page once its stock is at zero.
									</div>
								) : isEdit ? (
									// Always explained: the empty-warehouse-AND-vehicles rule is
									// invisible otherwise, and the vehicle half is what dispatchers don't expect.
									<div
										className={`rounded-md border px-3 py-2 text-xs ${
											trackingLocked
												? "border-warning/40 bg-warning/10 text-warning-text"
												: "border-border-subtle bg-surface text-text-secondary"
										}`}
									>
										{eligibilityLoading && !eligibility ? (
											"Checking whether tracking can be changed…"
										) : trackingLocked ? (
											<>
												<span className="font-medium">
													Tracking can’t be changed yet.
												</span>{" "}
												{eligibility?.blockers.length ? (
													<>
														{eligibility.blockers.join(" Also: ")}.
													</>
												) : (
													<>
														This item still has stock on hand — tracking
														can only change while the quantity is 0 in the
														warehouse and on every vehicle.
													</>
												)}
											</>
										) : canModifyTracking ? (
											<>
												<span className="font-medium">
													Nothing left on hand
													{eligibility
														? ` (0 in the warehouse, 0 on vehicles)`
														: ""}
													.
												</span>{" "}
												Turn tracking off or switch between serial and
												batch/lot — changes apply on save.
												{retainedHistory > 0 && (
													<>
														{" "}
														Existing{" "}
														{eligibility!.history_serials > 0 &&
															`${eligibility!.history_serials} unit${eligibility!.history_serials === 1 ? "" : "s"}`}
														{eligibility!.history_serials > 0 &&
															eligibility!.history_lots > 0 &&
															" and "}
														{eligibility!.history_lots > 0 &&
															`${eligibility!.history_lots} lot${eligibility!.history_lots === 1 ? "" : "s"}`}{" "}
														stay on the Tracking tab as read-only history,
														marked as no longer tracked.
													</>
												)}
											</>
										) : (
											<>
												<span className="font-medium">
													This item is empty, so tracking can be enabled.
												</span>{" "}
												After saving, use “Receive Stock” on this item to add
												units. Tracking can only change while the quantity is
												0 in the warehouse and on every vehicle.
											</>
										)}
									</div>
								) : (
									(isSerialized || isBatchTracked) && (
										<p className="text-xs text-text-muted">
											{quantity > 0
												? `You'll ${
														isSerialized
															? "scan or enter serial numbers"
															: "confirm the batch/lot details"
													} for the ${quantity} unit${quantity === 1 ? "" : "s"} being added, in a final step right after the item is created.`
												: "Stock starts at 0 — add serial numbers or a batch later using the item's Receive action."}
										</p>
									)
								)}
							</div>
						)}

						<div className="border border-border rounded-lg p-3 space-y-3">
							<div className="flex items-center justify-between">
								<label className="text-sm font-medium text-text-primary">
									Low Stock Alert
								</label>
								<ToggleSwitch
									checked={lowStockEnabled}
									onChange={() => setLowStockEnabled(!lowStockEnabled)}
								/>
							</div>

							{lowStockEnabled && (
								<div className="min-w-0">
									<label className={LABEL}>
										Threshold
									</label>
									<input
										type="number"
										min="0"
										placeholder="e.g. 10"
										value={
											lowStockThreshold
										}
										onChange={(e) =>
											setLowStockThreshold(
												e
													.target
													.value
											)
										}
										className={
											shownErrors.lowStockThreshold
												? INPUT_INVALID
												: INPUT
										}
										aria-invalid={
											!!shownErrors.lowStockThreshold
										}
										disabled={isLoading}
									/>
									<FieldMessage>
										{shownErrors.lowStockThreshold}
									</FieldMessage>
								</div>
							)}

							{lowStockEnabled && (
								<>
									<div className="flex items-center justify-between">
										<label className="text-sm font-medium text-text-primary">
											Email Alerts
										</label>
										<ToggleSwitch
											checked={alertEmailsEnabled}
											onChange={() => setAlertEmailsEnabled(!alertEmailsEnabled)}
										/>
									</div>

									{alertEmailsEnabled && (
										<div className="min-w-0">
											<label
												className={
													LABEL
												}
											>
												Alert
												Email
												*
											</label>
											<input
												type="email"
												placeholder="alerts@company.com"
												value={
													alertEmail
												}
												onChange={(
													e
												) =>
													setAlertEmail(
														e
															.target
															.value
													)
												}
												className={
													shownErrors.alertEmail
														? INPUT_INVALID
														: INPUT
												}
												aria-invalid={
													!!shownErrors.alertEmail
												}
												disabled={
													isLoading
												}
											/>
											<FieldMessage>
												{
													shownErrors.alertEmail
												}
											</FieldMessage>
										</div>
									)}
								</>
							)}
						</div>
					</div>
				);

			case 3:
				// Tracked+qty>0 flow: capture serials/batch here, before
				// images/review. Nothing is persisted yet — the values live in
				// local state and are written on Submit (see handleSubmitTracked).
				// Non-tracked and tracked-but-zero-qty flows have no capture step,
				// so step 3 is the final images/review step instead.
				if (!showCaptureStep) return renderImagesReview();
				return (
					<div className="space-y-3 min-w-0">
						{submitError && (
							<div className="p-3 bg-error-bg border border-error-border rounded-lg">
								<p className="text-sm text-error-text">{submitError}</p>
							</div>
						)}
						<StepErrorSummary errors={shownErrors} listMessages />
						<p className="text-sm text-text-secondary">
							<span className="font-medium text-text-primary">{name || "This item"}</span>{" "}
							will be created with the {quantity} unit{quantity === 1 ? "" : "s"} you{" "}
							{isSerialized ? "scan or enter" : "confirm"} below.
						</p>
						{isSerialized && (
							<SerialCaptureList
								itemId=""
								targetCount={quantity}
								value={serialCaptureValues}
								onChange={setSerialCaptureValues}
							/>
						)}
						{isBatchTracked && (
							<BatchCaptureFields
								itemId=""
								value={batchCaptureValue}
								onChange={setBatchCaptureValue}
							/>
						)}
					</div>
				);

			case 4:
				return renderImagesReview();

			default:
				return null;
		}
	})();

	return (
		<FormWizardContainer<Step>
			title={isEdit ? "Edit Inventory Item" : "New Inventory Item"}
			steps={STEPS}
			currentStep={currentStep}
			visitedSteps={visitedSteps}
			isLoading={isLoading}
			isOpen={isOpen}
			onClose={onClose}
			canGoToStep={canGoToStep}
			onStepClick={goToStep}
			onNext={handleNext}
			onBack={goBack}
			onSubmit={guardSubmit(
				showCaptureStep
					? handleSubmitTracked
					: isDisablingOrSwitching
						? () => setTrackingConfirmOpen(true)
						: handleSubmit,
			)}
			// The gate lives in handleNext, not in a disabled button: Next stays
			// clickable so the click can explain what's blocking it.
			canGoNext
			isEditMode={isEdit}
			submitLabel={
				isEdit
					? "Save Changes"
					: showCaptureStep
						? "Finish"
						: selectedQBId
							? "Import Item"
							: "Create Item"
			}
			isSourceSearchOpen={qbSearchOpen}
			hideSourceToggle={true}
			fullHeightContent={qbSearchOpen}
			onStartFromExisting={() => setQbSearchOpen(true)}
			startFromExistingLabel="Import from QuickBooks"
			hideStartFromExisting={!qbImportAvailable || !!selectedQBId}
			onCloseSourceSearch={() => setQbSearchOpen(false)}
		>
			{stepContent}
			{isScannerOpen && (
				<BarcodeScanner
					onScan={(code) => setBarcode(code)}
					onClose={() => setIsScannerOpen(false)}
				/>
			)}
			<ConfirmDialog
				open={trackingConfirmOpen}
				title="Change tracking?"
				body={
					retainedHistory > 0
						? `This turns off (or switches) how this item is tracked. Its ${retainedHistory} existing record${retainedHistory === 1 ? "" : "s"} stay as read-only history on the Tracking tab — nothing new will be tracked. Continue?`
						: "This turns off (or switches) how this item is tracked. Nothing new will be tracked for it. Continue?"
				}
				confirmLabel="Change tracking"
				tone="destructive"
				pending={isLoading}
				onConfirm={() => {
					setTrackingConfirmOpen(false);
					void handleSubmit();
				}}
				onCancel={() => setTrackingConfirmOpen(false)}
			/>
		</FormWizardContainer>
	);
}
