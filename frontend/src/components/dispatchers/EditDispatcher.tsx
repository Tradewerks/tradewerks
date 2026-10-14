import { useState, useEffect, useMemo } from "react";
import type { Dispatcher } from "../../types/dispatchers";
import { useUpdateDispatcherMutation } from "../../hooks/useDispatchers";
import { useOrgRolesQuery, useAssignOrgRoleMutation } from "../../hooks/useOrgRoles";
import { FormWizardContainer } from "../ui/forms/FormWizardContainer";

interface EditDispatcherProps {
    isOpen: boolean;
    onClose: () => void;
    dispatcher: Dispatcher;
}

const INPUT =
    "border border-border px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors min-w-0";
const LABEL = "block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider";

export default function EditDispatcher({ isOpen, onClose, dispatcher }: EditDispatcherProps) {
    const [name, setName] = useState(dispatcher.name);
    const [email, setEmail] = useState(dispatcher.email);
    const [phone, setPhone] = useState(dispatcher.phone);
    const [title, setTitle] = useState(dispatcher.title);
    const [description, setDescription] = useState(dispatcher.description || "");
    const [organizationRoleId, setOrganizationRoleId] = useState<string>(dispatcher.organization_role?.id ?? "");

    const updateDispatcher = useUpdateDispatcherMutation();
    const assignRole = useAssignOrgRoleMutation();
    const { data: orgRoles } = useOrgRolesQuery();
    const dispatcherRoles = orgRoles?.filter((r) => r.base_tier === "dispatcher") ?? [];

    const isLoading = updateDispatcher.isPending || assignRole.isPending;

    useEffect(() => {
        if (isOpen) {
            setName(dispatcher.name);
            setEmail(dispatcher.email);
            setPhone(dispatcher.phone);
            setTitle(dispatcher.title);
            setDescription(dispatcher.description || "");
            setOrganizationRoleId(dispatcher.organization_role?.id ?? "");
        }
    }, [isOpen, dispatcher]);

    const handleSubmit = async () => {
        try {
            await updateDispatcher.mutateAsync({
                id: dispatcher.id,
                data: { name, email, phone, title, description },
            });
            const newRoleId = organizationRoleId || null;
            if (newRoleId !== (dispatcher.organization_role?.id ?? null)) {
                await assignRole.mutateAsync({
                    user_id: dispatcher.id,
                    user_type: "dispatcher",
                    role_id: newRoleId,
                });
            }
            onClose();
        } catch (error) {
            console.error("Failed to update dispatcher:", error);
        }
    };

    const isFormValid = useMemo(
        () => !!(name.trim() && email.trim() && phone?.trim() && title.trim()),
        [name, email, phone, title]
    );

    const formContent = useMemo(
        () => (
            <div className="space-y-2 lg:space-y-3 xl:space-y-4 min-w-0">
                {/* Name */}
                <div className="min-w-0">
                    <label className={LABEL}>Full Name *</label>
                    <input
                        type="text"
                        placeholder="Full Name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className={INPUT}
                        disabled={isLoading}
                    />
                </div>

                {/* Email + Phone */}
                <div className="grid grid-cols-2 gap-2 lg:gap-3 min-w-0">
                    <div className="min-w-0">
                        <label className={LABEL}>Email *</label>
                        <input
                            type="email"
                            placeholder="email@example.com"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className={INPUT}
                            disabled={isLoading}
                        />
                    </div>
                    <div className="min-w-0">
                        <label className={LABEL}>Phone *</label>
                        <input
                            type="tel"
                            placeholder="(555) 123-4567"
                            value={phone?.trim() ? phone : ""}
                            onChange={(e) => setPhone(e.target.value)}
                            className={INPUT}
                            disabled={isLoading}
                        />
                    </div>
                </div>

                {/* Title */}
                <div className="min-w-0">
                    <label className={LABEL}>Title *</label>
                    <input
                        type="text"
                        placeholder="e.g. Senior Dispatcher"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        className={INPUT}
                        disabled={isLoading}
                    />
                </div>

                {/* Description */}
                <div className="min-w-0">
                    <label className={LABEL}>Description</label>
                    <textarea
                        placeholder="Brief description or notes..."
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        className="border border-border px-2.5 py-1.5 lg:py-2 w-full h-14 lg:h-20 xl:h-24 rounded bg-base text-primary text-sm lg:text-base resize-none focus:border-primary focus:outline-none transition-colors min-w-0"
                        disabled={isLoading}
                    />
                </div>

                {/* Permission Role */}
                {dispatcher.role !== "admin" && (
                    <div className="min-w-0">
                        <label className={LABEL}>Permission Role</label>
                        <select
                            value={organizationRoleId}
                            onChange={(e) => setOrganizationRoleId(e.target.value)}
                            className={INPUT}
                            disabled={isLoading}
                        >
                            <option value="">— No Role —</option>
                            {dispatcherRoles.map((r) => (
                                <option key={r.id} value={r.id}>{r.name}</option>
                            ))}
                        </select>
                    </div>
                )}
            </div>
        ),
        [name, email, phone, title, description, organizationRoleId, dispatcherRoles, isLoading, dispatcher.role]
    );

    return (
        <FormWizardContainer
            title="Edit Dispatcher"
            steps={[]}
            currentStep={1}
            visitedSteps={new Set([1])}
            isLoading={updateDispatcher.isPending}
            isOpen={isOpen}
            onClose={onClose}
            onSubmit={handleSubmit}
            canGoNext={isFormValid}
            submitLabel="Save Changes"
            isEditMode
        >
            {formContent}
        </FormWizardContainer>
    );
}
