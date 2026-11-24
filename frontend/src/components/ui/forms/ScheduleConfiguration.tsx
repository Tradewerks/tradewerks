import type { ZodError } from "zod";
import {
	RecurringFrequencyValues,
	WeekdayValues,
	type RecurringFrequency,
	type Weekday,
} from "../../../types/recurringPlans";
import DatePicker from "../../ui/DatePicker";
import { UndoButton } from "./UndoButton";
import Dropdown from "../../ui/Dropdown";
import { RotateCcw } from "lucide-react";

interface ScheduleConfigurationProps {
	startDate: Date;
	endDate: Date | null;
	generationWindow: number;
	minAdvance: number;
	frequency: RecurringFrequency;
	interval: number;
	selectedWeekdays: Weekday[];
	monthDay: number | "";
	month: number | "";

	onStartDateChange: (date: Date | null) => void;
	onEndDateChange: (date: Date | null) => void;
	onGenerationWindowChange: (value: number) => void;
	onMinAdvanceChange: (value: number) => void;
	onFrequencyChange: (value: RecurringFrequency) => void;
	onIntervalChange: (value: number) => void;
	onToggleWeekday: (weekday: Weekday) => void;
	onMonthDayChange: (value: number | "") => void;
	onMonthChange: (value: number | "") => void;

	isLoading?: boolean;
	errors?: ZodError | null;
	mode?: "create" | "edit";

	/** IANA zone the plan runs in; display only, the server owns it. */
	timezone?: string;
	technicians?: { id: string; name: string }[];
	defaultTechnicianId?: string;
	onDefaultTechnicianChange?: (id: string) => void;

	originalStartDate?: Date;
	originalEndDate?: Date | null;

	isDirty?: (field: string) => boolean;
	onUndo?: (field: string) => void;
}

const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

const ShortMonthNote = ({ day }: { day: number | "" }) =>
	day !== "" && day >= 29 ? (
		<p className="mt-0.5 text-[10px] text-text-muted">Short months use their last day.</p>
	) : null;

const INPUT =
	"border border-border px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors min-w-0";

export const ScheduleConfiguration = ({
	startDate,
	endDate,
	generationWindow,
	minAdvance,
	frequency,
	interval,
	selectedWeekdays,
	monthDay,
	month,
	onStartDateChange,
	onEndDateChange,
	onGenerationWindowChange,
	onMinAdvanceChange,
	onFrequencyChange,
	onIntervalChange,
	onToggleWeekday,
	onMonthDayChange,
	onMonthChange,
	isLoading = false,
	errors = null,
	mode = "create",
	timezone,
	technicians,
	defaultTechnicianId = "",
	onDefaultTechnicianChange,
	originalStartDate,
	originalEndDate,
	isDirty,
	onUndo,
}: ScheduleConfigurationProps) => {
	const getFieldErrors = (path: string) => {
		if (!errors) return [];
		return errors.issues.filter((err) => err.path[0] === path);
	};

	const ErrorDisplay = ({ path }: { path: string }) => {
		const fieldErrors = getFieldErrors(path);
		if (fieldErrors.length === 0) return null;
		return (
			<div className="mt-0.5">
				{fieldErrors.map((err, idx) => (
					<p key={idx} className="text-error-text text-xs leading-tight">
						{err.message}
					</p>
				))}
			</div>
		);
	};

	const getIntervalLabel = () => {
		const labels = {
			daily: interval === 1 ? "day" : "days",
			weekly: interval === 1 ? "week" : "weeks",
			monthly: interval === 1 ? "month" : "months",
			yearly: interval === 1 ? "year" : "years",
		};
		return labels[frequency] || "";
	};

	const showUndo = (field: string) =>
		mode === "edit" && !!isDirty && !!onUndo && isDirty(field);

	return (
		<div className="space-y-2 lg:space-y-3 pt-2 min-w-0">
			<div className="p-2.5 lg:p-3 bg-surface rounded-lg border border-border">
				<h3 className="text-xs lg:text-sm font-semibold mb-2 lg:mb-3 text-text-primary uppercase tracking-wider">
					Schedule Configuration
				</h3>
				{timezone && (
					<p className="mb-2 lg:mb-3 text-xs text-text-tertiary">
						Times are in {timezone}
					</p>
				)}

				{/* Dates + Windows */}
				<div className="grid grid-cols-2 gap-2 lg:gap-3 mb-2 lg:mb-3 min-w-0">
					{/* Start Date */}
					<div className="min-w-0">
						<label className="block mb-0.5 lg:mb-1 text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
							Start Date *
						</label>
						<DatePicker
							portal
							mode={mode}
							originalValue={originalStartDate}
							value={startDate}
							onChange={onStartDateChange}
							align="left"
							position="below"
						/>
						<ErrorDisplay path="starts_at" />
					</div>

					{/* End Date */}
					<div className="min-w-0">
						<label className="block mb-0.5 lg:mb-1 text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
							End Date (Optional)
						</label>
						<DatePicker
							portal
							mode={mode}
							originalValue={originalEndDate}
							value={endDate}
							onChange={onEndDateChange}
							align="right"
							position="below"
						/>
						<ErrorDisplay path="ends_at" />
					</div>

					{/* Generation Window */}
					<div className="min-w-0">
						<label className="block mb-0.5 lg:mb-1 text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
							Generation Window (days) *
						</label>
						<div className="relative min-w-0">
							<input
								type="number"
								min="1"
								value={generationWindow}
								onChange={(e) =>
									onGenerationWindowChange(
										parseInt(
											e.target
												.value
										) || 30
									)
								}
								disabled={isLoading}
								className={`${INPUT} pr-8`}
								placeholder="30"
							/>
							{showUndo("generationWindow") && (
								<UndoButton
									show
									onUndo={() =>
										onUndo!(
											"generationWindow"
										)
									}
									disabled={isLoading}
								/>
							)}
						</div>
						<ErrorDisplay path="generation_window_days" />
					</div>

					{/* Min Advance */}
					<div className="min-w-0">
						<label className="block mb-0.5 lg:mb-1 text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
							Min. Advance (days) *
						</label>
						<div className="relative min-w-0">
							<input
								type="number"
								min="0"
								value={minAdvance}
								onChange={(e) =>
									onMinAdvanceChange(
										parseInt(
											e.target
												.value
										) || 1
									)
								}
								disabled={isLoading}
								className={`${INPUT} pr-8`}
								placeholder="1"
							/>
							{showUndo("minAdvance") && (
								<UndoButton
									show
									onUndo={() =>
										onUndo!(
											"minAdvance"
										)
									}
									disabled={isLoading}
								/>
							)}
						</div>
						<ErrorDisplay path="min_advance_days" />
					</div>
				</div>

				{onDefaultTechnicianChange && (
					<div className="mb-2 lg:mb-3 min-w-0">
						<label
							htmlFor="plan-default-technician"
							className="block mb-0.5 lg:mb-1 text-[10px] font-medium text-text-tertiary uppercase tracking-wider"
						>
							Default Technician
						</label>
						<Dropdown
							id="plan-default-technician"
							entries={
								<>
									<option value="">Unassigned</option>
									{(technicians ?? []).map((t) => (
										<option key={t.id} value={t.id}>
											{t.name}
										</option>
									))}
								</>
							}
							value={defaultTechnicianId}
							onChange={onDefaultTechnicianChange}
							disabled={isLoading}
						/>
						<p className="mt-0.5 text-[10px] text-text-muted">
							Assigned to each new visit this plan generates.
						</p>
					</div>
				)}

				{/* Recurrence Pattern */}
				<div className="border-t border-border pt-2 lg:pt-3">
					<h4 className="text-[10px] lg:text-xs font-medium mb-2 text-text-tertiary uppercase tracking-wider">
						Recurrence Pattern *
					</h4>
					<ErrorDisplay path="rule" />

					<div className="grid grid-cols-2 gap-2 lg:gap-3 mb-2 lg:mb-3 min-w-0">
						{/* Frequency */}
						<div className="min-w-0">
							<label className="block mb-0.5 lg:mb-1 text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
								Frequency *
							</label>
							<div className="relative min-w-0">
								<Dropdown
									entries={RecurringFrequencyValues.map(
										(freq) => (
											<option
												key={
													freq
												}
												value={
													freq
												}
											>
												{freq
													.charAt(
														0
													)
													.toUpperCase() +
													freq.slice(
														1
													)}
											</option>
										)
									)}
									value={frequency}
									onChange={(v) =>
										onFrequencyChange(
											v as RecurringFrequency
										)
									}
									disabled={isLoading}
								/>
								{showUndo("frequency") && (
									<UndoButton
										show
										onUndo={() =>
											onUndo!(
												"frequency"
											)
										}
										position="right-9"
										disabled={isLoading}
									/>
								)}
							</div>
						</div>

						{/* Interval */}
						<div className="min-w-0">
							<label className="block mb-0.5 lg:mb-1 text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
								Repeat Every *
							</label>
							<div className="relative min-w-0">
								<input
									type="number"
									min="1"
									value={interval}
									onChange={(e) =>
										onIntervalChange(
											parseInt(
												e
													.target
													.value
											) || 1
										)
									}
									disabled={isLoading}
									className={`${INPUT} pr-16`}
									placeholder="1"
								/>
								{showUndo("interval") && (
									<UndoButton
										show
										onUndo={() =>
											onUndo!(
												"interval"
											)
										}
										position="right-16"
										disabled={isLoading}
									/>
								)}
								<span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-tertiary text-xs pointer-events-none">
									{getIntervalLabel()}
								</span>
							</div>
						</div>
					</div>

					{/* Weekly */}
					{frequency === "weekly" && (
						<div className="mt-2 lg:mt-3">
							<div className="flex items-center gap-2 mb-1.5">
								<label className="text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
									Repeat On *
								</label>
								{showUndo("selectedWeekdays") && (
									<button
										type="button"
										title="Undo"
										onClick={() =>
											onUndo!(
												"selectedWeekdays"
											)
										}
										disabled={isLoading}
										className="text-text-tertiary hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
									>
										<RotateCcw
											size={12}
										/>
									</button>
								)}
							</div>
							<div className="flex flex-wrap gap-1.5">
								{WeekdayValues.map((day) => (
									<button
										key={day}
										type="button"
										onClick={() =>
											onToggleWeekday(
												day
											)
										}
										disabled={isLoading}
										className={`px-2 py-1 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
											selectedWeekdays.includes(
												day
											)
												? "bg-primary-hover text-on-primary"
												: "bg-surface-raised text-text-secondary hover:bg-border-subtle"
										}`}
									>
										{day}
									</button>
								))}
							</div>
						</div>
					)}

					{/* Monthly */}
					{frequency === "monthly" && (
						<div className="mt-2 lg:mt-3 min-w-0">
							<label className="block mb-0.5 lg:mb-1 text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
								Day of Month *
							</label>
							<div className="relative min-w-0">
								<input
									type="number"
									min="1"
									max="31"
									value={monthDay}
									onChange={(e) =>
										onMonthDayChange(
											e.target
												.value
												? parseInt(
														e
															.target
															.value
													)
												: ""
										)
									}
									disabled={isLoading}
									className={`${INPUT} pr-8`}
									placeholder="1–31"
								/>
								{showUndo("monthDay") && (
									<UndoButton
										show
										onUndo={() =>
											onUndo!(
												"monthDay"
											)
										}
										disabled={isLoading}
									/>
								)}
							</div>
							<ShortMonthNote day={monthDay} />
						</div>
					)}

					{/* Yearly */}
					{frequency === "yearly" && (
						<div className="grid grid-cols-2 gap-2 lg:gap-3 mt-2 lg:mt-3 min-w-0">
							<div className="min-w-0">
								<label className="block mb-0.5 lg:mb-1 text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
									Month *
								</label>
								<div className="relative min-w-0">
									<Dropdown
										entries={
											<>
												<option value="">
													Select
													month
												</option>
												{MONTH_NAMES.map(
													(
														m,
														i
													) => (
														<option
															key={
																i
															}
															value={
																i +
																1
															}
														>
															{
																m
															}
														</option>
													)
												)}
											</>
										}
										value={
											month !== ""
												? String(
														month
													)
												: ""
										}
										onChange={(v) =>
											onMonthChange(
												v
													? parseInt(
															v
														)
													: ""
											)
										}
										disabled={isLoading}
									/>
									{showUndo("month") && (
										<UndoButton
											show
											onUndo={() =>
												onUndo!(
													"month"
												)
											}
											position="right-9"
											disabled={
												isLoading
											}
										/>
									)}
								</div>
							</div>

							<div className="min-w-0">
								<label className="block mb-0.5 lg:mb-1 text-[10px] font-medium text-text-tertiary uppercase tracking-wider">
									Day of Month *
								</label>
								<div className="relative min-w-0">
									<input
										type="number"
										min="1"
										max="31"
										value={monthDay}
										onChange={(e) =>
											onMonthDayChange(
												e
													.target
													.value
													? parseInt(
															e
																.target
																.value
														)
													: ""
											)
										}
										disabled={isLoading}
										className={`${INPUT} pr-8`}
										placeholder="1–31"
									/>
									{showUndo("monthDay") && (
										<UndoButton
											show
											onUndo={() =>
												onUndo!(
													"monthDay"
												)
											}
											disabled={
												isLoading
											}
										/>
									)}
								</div>
								<ShortMonthNote day={monthDay} />
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
};
