import { useState, useMemo } from "react";
import { Plus } from "lucide-react";
import { useOrgRolesQuery, useCreateOrgRoleMutation, useUpdateOrgRoleMutation } from "../../hooks/useOrgRoles";
import type { OrganizationRole } from "../../types/organizations";
import CreateRole from "../roles/CreateRole";
import EditRole from "../roles/EditRole";
import SearchBar from "../../components/ui/SearchBar";
import FilterChips from "../../components/ui/FilterChips";
import { useMultiSearch } from "../../hooks/useMultiSearch";
import { groupPermissionsByCategory } from "../../lib/permissionCatalogs";
import type { PermissionCatalogTier } from "../../lib/permissionCatalogs";
import LoadSvg from "../../assets/icons/loading.svg?react";
import BoxSvg from "../../assets/icons/box.svg?react";
import ErrSvg from "../../assets/icons/error.svg?react";

const RolesSection = () => {
    const { data: roles, isLoading: rolesLoading, error: rolesError } = useOrgRolesQuery();
    const [selectedRole, setSelectedRole] = useState<OrganizationRole | null>(null);
    const [isRoleModalOpen, setIsRoleModalOpen] = useState(false);
    const [isEditRoleModalOpen, setIsEditRoleModalOpen] = useState(false);
    const createRoleMutation = useCreateOrgRoleMutation();
    const updateRoleMutation = useUpdateOrgRoleMutation();

    // Search
    const [searchInput, setSearchInput] = useState("");
    const { terms, addTerm, removeTerm, duplicateTerm, clearAll } = useMultiSearch("rolesSearch");

    // Tier filter
    const [showDispatchers, setShowDispatchers] = useState(true);
    const [showTechnicians, setShowTechnicians] = useState(true);
    const [defaultOnly, setDefaultOnly] = useState(false);

    const handleCreateRole = async (input: Omit<OrganizationRole, "id">) => {
        await createRoleMutation.mutateAsync(input);
    };

    const handleUpdateRole = async (id: string, input: Omit<OrganizationRole, "id">) => {
        await updateRoleMutation.mutateAsync({ id, ...input });
    };

    const activeTerms = searchInput.trim() ? [...terms, searchInput.trim()] : terms;

    const filteredRoles = useMemo(() => {
        if (!roles) return [];
        return roles.filter((role) => {
            if (!showDispatchers && role.base_tier === "dispatcher") return false;
            if (!showTechnicians && role.base_tier === "technician") return false;
            if (defaultOnly && !role.is_default) return false;
            if (activeTerms.length > 0) {
                const lower = role.name.toLowerCase();
                return activeTerms.every((t) => lower.includes(t.toLowerCase()));
            }
            return true;
        });
    }, [roles, showDispatchers, showTechnicians, defaultOnly, terms, searchInput, activeTerms]);

    const clearAllFilters = () => {
        setSearchInput("");
        clearAll();
        setShowDispatchers(true);
        setShowTechnicians(true);
        setDefaultOnly(false);
    };

    const hasActiveFilters = !showDispatchers || !showTechnicians || defaultOnly || terms.length > 0;

    return (
        <>
            {/* Controls row */}
            <div className="flex flex-wrap items-center gap-2 mb-3">
                <SearchBar
                    paramKey="rolesSearch"
                    placeholder="Search roles..."
                    onValueChange={setSearchInput}
                    onSubmit={addTerm}
                    className="flex-1 min-w-[200px]"
                />

                <div className="h-8 w-px bg-border hidden sm:block" />

                {/* Tier toggles */}
                <div className="flex items-center gap-1 bg-surface border border-border rounded-md p-1">
                    <button
                        onClick={() => setShowDispatchers(!showDispatchers)}
                        className={`px-3 py-1 text-xs rounded font-medium cursor-pointer transition-colors ${
                            showDispatchers ? "bg-primary-hover text-on-primary" : "text-text-tertiary hover:text-text-primary"
                        }`}
                    >
                        Dispatchers
                    </button>
                    <button
                        onClick={() => setShowTechnicians(!showTechnicians)}
                        className={`px-3 py-1 text-xs rounded font-medium cursor-pointer transition-colors ${
                            showTechnicians ? "bg-primary-hover text-on-primary" : "text-text-tertiary hover:text-text-primary"
                        }`}
                    >
                        Technicians
                    </button>
                </div>

                {/* Default-only toggle */}
                <button
                    onClick={() => setDefaultOnly(!defaultOnly)}
                    className={`px-3 py-1.5 text-xs rounded-md font-medium border cursor-pointer transition-colors ${
                        defaultOnly
                            ? "bg-primary/15 border-primary/30 text-primary"
                            : "bg-surface border-border text-text-tertiary hover:text-text-primary"
                    }`}
                >
                    Default only
                </button>

                <div className="h-8 w-px bg-border hidden sm:block" />

                <button
                    className="flex items-center gap-2 px-3 py-2 bg-primary-hover hover:bg-primary-active text-on-primary rounded-md text-sm font-medium cursor-pointer transition-colors"
                    onClick={() => setIsRoleModalOpen(true)}
                >
                    <Plus size={15} />
                    New Role
                </button>
            </div>

            <FilterChips
                filters={[
                    ...terms.map((term) => ({
                        label: `Search: "${term}"`,
                        color: "purple" as const,
                        onRemove: () => removeTerm(term),
                        highlighted: duplicateTerm === term,
                    })),
                    ...(!showDispatchers ? [{ label: "Dispatchers hidden", color: "orange" as const, onRemove: () => setShowDispatchers(true) }] : []),
                    ...(!showTechnicians ? [{ label: "Technicians hidden", color: "orange" as const, onRemove: () => setShowTechnicians(true) }] : []),
                    ...(defaultOnly ? [{ label: "Default only", color: "blue" as const, onRemove: () => setDefaultOnly(false) }] : []),
                ]}
                resultCount={filteredRoles.length}
                onClearAll={clearAllFilters}
            />

            {/* Loading */}
            {rolesLoading && (
                <div className="flex flex-col items-center justify-center py-10">
                    <LoadSvg className="w-16 h-16 animate-spin text-primary" />
                    <p className="mt-4 text-secondary">Loading roles...</p>
                </div>
            )}

            {/* Error */}
            {rolesError && (
                <div className="flex flex-col items-center justify-center py-10">
                    <ErrSvg className="w-16 h-16 text-error-text" />
                    <p className="mt-4 text-secondary">Failed to load roles.</p>
                </div>
            )}

            {/* Empty */}
            {!rolesLoading && !rolesError && filteredRoles.length === 0 && (
                <div className="flex flex-col items-center justify-center py-10">
                    <BoxSvg className="w-16 h-16 text-secondary" />
                    <p className="mt-4 text-secondary">
                        {hasActiveFilters ? "No roles match your filters." : "No roles found."}
                    </p>
                </div>
            )}

            {/* Grid */}
            {!rolesLoading && !rolesError && filteredRoles.length > 0 && (
                <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(288px,1fr))]">
                    {filteredRoles.map((role) => (
                        <div
                            key={role.id}
                            onClick={() => setSelectedRole(role)}
                            className="bg-base border rounded-lg p-5 cursor-pointer hover:shadow-lg transition-all flex flex-col gap-4 border-border-card hover:border-border-strong"
                        >
                            {/* Header */}
                            <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <h3 className="text-text-primary font-semibold text-lg truncate">{role.name}</h3>
                                    <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
                                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border border-border text-text-secondary">
                                            {role.base_tier.charAt(0).toUpperCase() + role.base_tier.slice(1)}
                                        </span>
                                        {role.is_default && (
                                            <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/15 text-primary border border-primary/20">
                                                Default
                                            </span>
                                        )}
                                    </div>
                                </div>
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setSelectedRole(role);
                                        setIsEditRoleModalOpen(true);
                                    }}
                                    className="shrink-0 text-xs px-3 py-1.5 bg-surface hover:bg-surface-raised text-text-primary rounded-md transition-colors border border-border-subtle"
                                >
                                    Edit
                                </button>
                            </div>

                            {/* Permissions list */}
                            <div className="border border-border rounded overflow-y-auto h-40 divide-y divide-border mt-auto">
                                {role.permissions.length === 0 ? (
                                    <p className="text-xs text-text-tertiary text-center py-6">No permissions</p>
                                ) : (
                                    groupPermissionsByCategory(role.permissions, role.base_tier as PermissionCatalogTier).map(({ category, permissions: perms }) => (
                                        <div key={category}>
                                            <div className="px-2.5 py-1 flex items-center justify-between bg-surface sticky top-0 border-b border-border">
                                                <span className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary">{category}</span>
                                                <span className="text-[10px] text-text-tertiary">{perms.length}</span>
                                            </div>
                                            {perms.map(({ id, label }) => (
                                                <div key={id} className="px-2.5 py-1.5 text-xs text-text-secondary">
                                                    {label}
                                                </div>
                                            ))}
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <CreateRole
                isModalOpen={isRoleModalOpen}
                setIsModalOpen={setIsRoleModalOpen}
                createRole={handleCreateRole}
            />
            {selectedRole && (
                <EditRole
                    isModalOpen={isEditRoleModalOpen}
                    setIsModalOpen={setIsEditRoleModalOpen}
                    role={selectedRole}
                    updateRole={handleUpdateRole}
                />
            )}
        </>
    );
};

export default RolesSection;
