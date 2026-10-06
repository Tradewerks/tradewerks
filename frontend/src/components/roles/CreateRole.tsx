import { useState, useEffect, useMemo, useCallback } from "react";
import { X, ChevronRight } from "lucide-react";
import { FormWizardContainer } from "../ui/forms/FormWizardContainer";
import type { OrganizationRole } from "../../types/organizations";
import { PERMISSION_CATALOGS } from "../../lib/permissionCatalogs";
import { isPermissionOffered } from "../../lib/permissionAccess";
import { useEntitlements } from "../../hooks/useEntitlements";
import HiddenModulePermissionsNote from "./HiddenModulePermissionsNote";

interface CreateRoleProps {
	isModalOpen: boolean;
	setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
	createRole: (input: Omit<OrganizationRole, "id">) => Promise<void>;
}

const INPUT =
	"border border-border px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors min-w-0";
const LABEL = "block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider";


const PANEL_LABEL = "text-[10px] font-medium text-text-tertiary uppercase tracking-wider";
const CATEGORY_HEADER =
	"px-2.5 py-1 flex items-center justify-between bg-surface sticky top-0 border-b border-border";
const CATEGORY_TITLE =
	"text-[10px] font-semibold uppercase tracking-widest text-text-tertiary";

const CreateRole = ({ isModalOpen, setIsModalOpen, createRole }: CreateRoleProps) => {
	const [name, setName] = useState("");
	const [baseTier, setBaseTier] = useState<"dispatcher" | "technician">("dispatcher");
	const [permissions, setPermissions] = useState<string[]>([]);
	const [isDefault, setIsDefault] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [nameError, setNameError] = useState("");

	const resetForm = useCallback(() => {
		setName("");
		setBaseTier("dispatcher");
		setPermissions([]);
		setIsDefault(false);
		setNameError("");
	}, []);

	useEffect(() => {
		if (!isModalOpen) {
			resetForm();
			setIsLoading(false);
		}
	}, [isModalOpen, resetForm]);

	// Display only: `permissions` keeps what the role already holds from a module that
	// is off, so switching the module back on restores it.
	const { data: entitlements } = useEntitlements();
	const activeCatalog = useMemo(
		() =>
			PERMISSION_CATALOGS[baseTier]
				.map((group) => ({
					...group,
					permissions: group.permissions.filter((p) =>
						isPermissionOffered(p.id, entitlements),
					),
				}))
				.filter((group) => group.permissions.length > 0),
		[baseTier, entitlements],
	);

	const handleTierChange = (tier: "dispatcher" | "technician") => {
		setBaseTier(tier);
		setPermissions([]);
	};

	const togglePermission = (id: string) => {
		setPermissions((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
	};

	const toggleCategory = (permIds: readonly string[]) => {
		const allSelected = permIds.every((id) => permissions.includes(id));
		if (allSelected) {
			setPermissions((prev) => prev.filter((p) => !permIds.includes(p)));
		} else {
			setPermissions((prev) => [...prev, ...permIds.filter((id) => !prev.includes(id))]);
		}
	};

	const invokeCreate = async () => {
		if (isLoading) return;
		const trimmedName = name.trim();
		if (!trimmedName) {
			setNameError("Role name is required");
			return;
		}
		setNameError("");
		setIsLoading(true);
		try {
			await createRole({ name: trimmedName, base_tier: baseTier, permissions, is_default: isDefault });
			setIsModalOpen(false);
			resetForm();
		} catch (error) {
			console.error("Failed to create role:", error);
		} finally {
			setIsLoading(false);
		}
	};

	const isFormValid = useMemo(() => !!name.trim(), [name]);

	const formContent = useMemo(() => {
		const availableCategories = activeCatalog
			.map(({ category, permissions: perms }) => ({
				category,
				available: perms.filter((p) => !permissions.includes(p.id)),
				allIds: perms.map((p) => p.id) as string[],
			}))
			.filter((c) => c.available.length > 0);

		const selectedCategories = activeCatalog
			.map(({ category, permissions: perms }) => ({
				category,
				selected: perms.filter((p) => permissions.includes(p.id)),
			}))
			.filter((c) => c.selected.length > 0);

		const availableCount = availableCategories.reduce((n, c) => n + c.available.length, 0);

		return (
			<div className="space-y-2 lg:space-y-3 xl:space-y-4 min-w-0">
				{/* Name */}
				<div className="min-w-0">
					<label className={LABEL}>Role Name *</label>
					<input
						type="text"
						placeholder="e.g. Senior Technician"
						value={name}
						onChange={(e) => setName(e.target.value)}
						className={INPUT}
						disabled={isLoading}
					/>
					{nameError && (
						<p className="mt-0.5 text-error-text text-xs leading-tight">{nameError}</p>
					)}
				</div>

				{/* Base Tier */}
				<div className="min-w-0">
					<label className={LABEL}>Base Tier *</label>
					<select
						value={baseTier}
						onChange={(e) => handleTierChange(e.target.value as "dispatcher" | "technician")}
						className={INPUT}
						disabled={isLoading}
					>
						<option value="dispatcher">Dispatcher</option>
						<option value="technician">Technician</option>
					</select>
				</div>

				{/* Default role toggle */}
				<div className="min-w-0 flex items-center gap-2.5">
					<input
						type="checkbox"
						id="create_is_default"
						checked={isDefault}
						onChange={(e) => setIsDefault(e.target.checked)}
						disabled={isLoading}
						className="h-4 w-4 rounded border-border bg-base text-primary focus:ring-primary"
					/>
					<label htmlFor="create_is_default" className="text-sm text-text-secondary cursor-pointer select-none">
						Set as default role for {baseTier}s
					</label>
				</div>

				<HiddenModulePermissionsNote baseTier={baseTier} entitlements={entitlements} />

				{/* Permissions — transfer list */}
				<div className="min-w-0">
					<label className={LABEL}>Permissions</label>
					<div className="grid grid-cols-2 gap-2">
						{/* Available */}
						<div className="flex flex-col min-w-0">
							<div className="flex items-center justify-between mb-1">
								<span className={PANEL_LABEL}>Available</span>
								<span className="text-[10px] text-text-tertiary">{availableCount}</span>
							</div>
							<div className="border border-border rounded overflow-y-auto h-52 divide-y divide-border">
								{availableCategories.length === 0 ? (
									<p className="text-xs text-text-tertiary text-center py-8">
										All permissions added
									</p>
								) : (
									availableCategories.map(({ category, available, allIds }) => (
										<div key={category}>
											<div className={CATEGORY_HEADER}>
												<span className={CATEGORY_TITLE}>{category}</span>
												<button
													type="button"
													disabled={isLoading}
													onClick={() => toggleCategory(allIds)}
													className="text-[10px] text-primary hover:text-primary/70 transition-colors disabled:opacity-40"
												>
													Add all
												</button>
											</div>
											{available.map(({ id, label }) => (
												<button
													key={id}
													type="button"
													disabled={isLoading}
													onClick={() => togglePermission(id)}
													className="w-full text-left px-2.5 py-1.5 text-xs text-text-secondary hover:bg-primary/10 hover:text-text-primary transition-colors flex items-center justify-between group disabled:opacity-40"
												>
													{label}
													<ChevronRight className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-60 text-primary transition-opacity" />
												</button>
											))}
										</div>
									))
								)}
							</div>
						</div>

						{/* Selected */}
						<div className="flex flex-col min-w-0">
							<div className="flex items-center justify-between mb-1">
								<span className={PANEL_LABEL}>Selected</span>
								<span className="text-[10px] text-text-tertiary">{permissions.length}</span>
							</div>
							<div className="border border-border rounded overflow-y-auto h-52 divide-y divide-border">
								{selectedCategories.length === 0 ? (
									<p className="text-xs text-text-tertiary text-center py-8">
										No permissions selected
									</p>
								) : (
									selectedCategories.map(({ category, selected }) => {
										const selectedIds = selected.map((p) => p.id);
										return (
											<div key={category}>
												<div className={CATEGORY_HEADER}>
													<span className={CATEGORY_TITLE}>{category}</span>
													<button
														type="button"
														disabled={isLoading}
														onClick={() => toggleCategory(selectedIds)}
														className="text-[10px] text-error-text hover:text-error-text/70 transition-colors disabled:opacity-40"
													>
														Remove all
													</button>
												</div>
												{selected.map(({ id, label }) => (
													<button
														key={id}
														type="button"
														disabled={isLoading}
														onClick={() => togglePermission(id)}
														className="w-full text-left px-2.5 py-1.5 text-xs text-text-secondary hover:bg-error-text/10 hover:text-error-text transition-colors flex items-center justify-between group disabled:opacity-40"
													>
														{label}
														<X className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-60 transition-opacity" />
													</button>
												))}
											</div>
										);
									})
								)}
							</div>
						</div>
					</div>
				</div>
			</div>
		);
	}, [name, baseTier, activeCatalog, entitlements, permissions, isDefault, isLoading, nameError]);

	return (
		<FormWizardContainer
			title="Create Role"
			steps={[]}
			currentStep={1}
			visitedSteps={new Set([1])}
			isLoading={isLoading}
			isOpen={isModalOpen}
			onClose={() => setIsModalOpen(false)}
			onSubmit={invokeCreate}
			canGoNext={isFormValid}
			submitLabel="Create Role"
		>
			{formContent}
		</FormWizardContainer>
	);
};

export default CreateRole;
