import { useEffect, useState } from "react";
import Card from "../ui/Card";
import { HEADER_BTN_PRIMARY, HEADER_BTN_SECONDARY } from "../ui/headerActions";
import AdaptableTable from "../AdaptableTable";
import ConfirmDialog from "../ui/ConfirmDialog";
import { PERMISSION_CATALOGS, type PermissionCatalogTier } from "../../lib/permissionCatalogs";
import { usePermission } from "../../hooks/usePermission";
import {
	useAssignOrgRoleMutation,
	useCreateOrgRoleMutation,
	useOrgRolesQuery,
	useUpdateOrgRoleMutation,
} from "../../hooks/useOrgRoles";

type PermPill = {
	id: string;
	label: string;
	held: boolean;
};

type PermRow = {
	area: string;
	access: string;
	granted: string;
	_perms: PermPill[];
};

export interface AccessCardUser {
	id: string;
	name: string;
	role?: string;
	permissions: string[];
	organization_role: { id: string; name: string } | null;
}

interface AccessCardProps {
	user: AccessCardUser;
	tier: PermissionCatalogTier;
	readOnly ?: boolean;
}

const AccessCard = ({ user, tier, readOnly = false }: AccessCardProps) => {
	const MANAGE_ROLES = usePermission("manage_roles");
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState<Set<string>>(new Set());
	const { data: candidateRoles } = useOrgRolesQuery();
	const { mutateAsync: assignRoleAsync, isPending: assigning } = useAssignOrgRoleMutation();
	const { mutateAsync: updateRoleAsync, isPending: updating } = useUpdateOrgRoleMutation();
	const { mutateAsync: createRoleAsync, isPending: creating } = useCreateOrgRoleMutation();
	const [namingOpen, setNamingOpen] = useState(false);
	const [newName, setNewName] = useState("");
	const [nameError, setNameError] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const saving = assigning || updating;

	const catalog = PERMISSION_CATALOGS[tier];

	const buildRows = (held: Set<string>): PermRow[] =>
		catalog.map((s) => {
			const allPerms = s.permissions.map((p) => ({
				id: p.id,
				label: p.label,
				held: held.has(p.id),
			}));
			const perms = readOnly ? allPerms.filter((p) => p.held) : allPerms;
			return {
				area: s.category,
				access: "",
				granted: `${allPerms.filter((p) => p.held).length}/${allPerms.length}`,
				_perms: perms,
			};
		});

	const savedPerms = new Set(user.permissions);
	const rows = buildRows(savedPerms);
	const tempRows = buildRows(draft);

	const dirty =
		draft.size !== savedPerms.size || [...draft].some((id) => !savedPerms.has(id));

	useEffect(() => {
		if (editing) setDraft(new Set(user.permissions));
		setSaveError(null);
	}, [editing]);

	const togglePerm = (id: string) =>
		setDraft((prev) => {
			const newSet = new Set(prev);
			if (newSet.has(id)) newSet.delete(id);
			else newSet.add(id);
			return newSet;
		});

	const setEq = (a: Set<string>, b: Set<string>) =>
		a.size === b.size && [...a].every((id) => b.has(id));

	const currentRole = candidateRoles?.find((r) => r.id === user.organization_role?.id);
	// Only roles of this user's tier are candidates — dispatcher and technician
	// permission sets overlap (view_clients, view_inventory...), so a cross-tier
	// match would silently put a dispatcher on a technician role.
	const tierRoles = (candidateRoles ?? []).filter((r) => r.base_tier === tier);

	const handleRoleUpdate = async () => {
		setSaveError(null);

		// if current role is same as the new draft
		if (currentRole && setEq(draft, new Set(currentRole.permissions))){
			setEditing(false);
			return;
		}

		// looks for an existing same-tier role that matches the new draft
		const match = tierRoles.find((r) => setEq(draft, new Set(r.permissions)));
		if (match) {
			try {
				await assignRoleAsync({ user_id: user.id, user_type: tier, role_id: match.id });
				setEditing(false);
			} catch (e) {
				setSaveError(e instanceof Error ? e.message : "Failed to assign the role");
			}
			return;
		}

		// if the user is the only one assigned then just update the role — but
		// never rewrite the org's default role in place, since that silently
		// changes what every future hire is granted.
		const soleMember =
			(currentRole?._count?.dispatchers === 1 && currentRole._count.technicians === 0) ||
			(currentRole?._count?.dispatchers === 0 && currentRole._count.technicians === 1);
		if (currentRole && soleMember && !currentRole.is_default && currentRole.base_tier === tier) {
			try {
				await updateRoleAsync({
					id: currentRole.id,
					name: currentRole.name,
					base_tier: currentRole.base_tier,
					permissions: [...draft],
					is_default: currentRole.is_default,
				});
				setEditing(false);
			} catch (e) {
				setSaveError(e instanceof Error ? e.message : "Failed to update the role");
			}
			return;
		}

		// Can't update the role and no matching roles; Make a new role (prompt user for name and such)
		setNewName("");
		setNameError(null);
		setNamingOpen(true);
	}

	const handleCreateAndAssign = async () => {
		const name = newName.trim();
		if (!name) {
			setNameError("Role name is required");
			return;
		}
		const collides = (candidateRoles ?? []).some(
			(r) => r.name.trim().toLowerCase() === name.toLowerCase(),
		);
		if (collides) {
			setNameError(`A role named "${name}" already exists`);
			return;
		}
		setNameError(null);
		try {
			const role = await createRoleAsync({
				name,
				base_tier: tier,
				permissions: [...draft],
				is_default: false,
			});
			await assignRoleAsync({
				user_id: user.id,
				user_type: tier,
				role_id: role.id,
			});
			setNamingOpen(false);
			setNewName("");
			setEditing(false);
		} catch (e) {
			// leave the dialog open with the draft intact so the name can be retried
			setNameError(e instanceof Error ? e.message : "Failed to create the role");
		}
	}

	const canEdit = !readOnly && MANAGE_ROLES && !!user.organization_role && user.role !== "admin";

	return (
		<>
			<Card
				title="Access"
				headerAction={
					canEdit ? (
						editing ? (
							<div className="flex items-center gap-1.5">
								<button
									type="button"
									onClick={() => setEditing(false)}
									disabled={saving}
									className={HEADER_BTN_SECONDARY}
								>
									Cancel
								</button>
								<button
									type="button"
									disabled={!dirty || saving}
									title={!dirty ? "No changes to save" : undefined}
									onClick={handleRoleUpdate}
									className={HEADER_BTN_PRIMARY}
								>
									{saving ? "Saving..." : "Save changes"}
								</button>
							</div>
						) : (
							<button
								type="button"
								onClick={() => setEditing(true)}
								className={HEADER_BTN_SECONDARY}
							>
								Edit access
							</button>
						)
					) : undefined
				}
			>
				<div>
					<p className="text-xs text-text-muted mb-3">
						{user.role === "admin" ? (
							<>Full access comes from the Admin role directly, not from an organization role.</>
						) : user.organization_role ? (
							<>
								Granted by the{" "}
								<span className="font-medium text-text-secondary">
									{user.organization_role.name}
								</span>{" "}
								role
							</>
						) : (
							<>No organization role assigned.</>
						)}
					</p>
					{saveError && (
						<div
							role="alert"
							className="mb-3 rounded border border-error-border bg-error-bg px-3 py-2 text-sm text-error-text"
						>
							{saveError}
						</div>
					)}
					<AdaptableTable
						data={editing ? tempRows : rows}
						cellRenderers={{
							access: (row) => {
								const r = row as PermRow;
								return (
									<div className="flex flex-wrap gap-1.5">
										{r._perms.map((p) => (
											<span
												key={p.id}
												title={p.id}
												aria-label={`${p.label}: ${p.held ? "granted" : "not granted"}${
													editing && draft.has(p.id) !== savedPerms.has(p.id)
														? " (unsaved change)"
														: ""
												}`}
												className={`px-2.5 py-0.5 rounded-full border text-xs font-semibold leading-relaxed whitespace-nowrap ${
													p.held
														? "bg-primary-bg text-primary-text border-primary-border"
														: "bg-transparent text-text-faint border-border border-dashed"
												}
													${editing ? "hover:cursor-pointer" : ""}
													${
														editing && draft.has(p.id) !== savedPerms.has(p.id)
															? "ring-2 ring-warning ring-offset-1 ring-offset-base"
															: ""
													}
												`}
												onClick={() => {
													if (!editing) return;
													togglePerm(p.id);
												}}
											>
												{p.label}
											</span>
										))}
									</div>
								);
							},
						}}
						columnAlign={{ granted: "right" }}
					/>
				</div>
			</Card>

			<ConfirmDialog
				open={namingOpen}
				title="Name the new role"
				confirmLabel="Create and assign"
				pending={creating || assigning}
				error={nameError}
				onCancel={() => setNamingOpen(false)}
				onConfirm={handleCreateAndAssign}
				body={
					<div className="space-y-3">
						<p className="text-sm text-text-secondary leading-relaxed">
							No role matches these permissions.{" "}
							{currentRole && (
								<>
									<span className="font-medium text-text-primary">
										{currentRole.name}
									</span>{" "}
									stays as it is,{" "}
								</>
							)}
							a new role is created for {user.name}.
						</p>
						{draft.size === 0 && (
							<p className="text-sm text-warning-text leading-relaxed">
								This role grants nothing, {user.name} loses all access.
							</p>
						)}
						<div>
							<label
								htmlFor="new_role_name"
								className="block mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider"
							>
								Role name *
							</label>
							<input
								id="new_role_name"
								type="text"
								autoFocus
								value={newName}
								onChange={(e) => setNewName(e.target.value)}
								placeholder="e.g. Senior Coordinator"
								disabled={creating || assigning}
								className="border border-border px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm focus:border-primary focus:outline-none transition-colors min-w-0 disabled:opacity-40"
							/>
						</div>
					</div>
				}
			/>
		</>
	);
};

export default AccessCard;
