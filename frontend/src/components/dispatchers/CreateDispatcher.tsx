import { useState, useEffect, useMemo, useCallback } from "react";
import { Link } from "react-router-dom";
import { isAxiosError } from "axios";
import type { ZodError } from "zod";
import { CreateDispatcherSchema, type CreateDispatcherInput } from "../../types/dispatchers";
import { FormWizardContainer } from "../ui/forms/FormWizardContainer";
import PasswordSetField from "../ui/forms/PasswordSetField";
import { useOrgRolesQuery } from "../../hooks/useOrgRoles";
import { FormErrorBanner } from "../ui/forms/FormErrorBanner";
import { errorMessage } from "../../util/util";

interface CreateDispatcherProps {
	isModalOpen: boolean;
	setIsModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
	createDispatcher: (input: CreateDispatcherInput) => Promise<string>;
}

const INPUT =
	"border border-border px-2.5 h-[34px] w-full rounded bg-base text-text-primary text-sm lg:text-base focus:border-primary focus:outline-none transition-colors min-w-0";
const LABEL =
	"block mb-0.5 lg:mb-1 text-xs font-medium text-text-tertiary uppercase tracking-wider";

const CreateDispatcher = ({
	isModalOpen,
	setIsModalOpen,
	createDispatcher,
}: CreateDispatcherProps) => {
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [phone, setPhone] = useState("");
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [organizationRoleId, setOrganizationRoleId] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [errors, setErrors] = useState<ZodError | null>(null);
    const [password, setPassword] = useState("");
    const [choosePassword, setChoosePassword] = useState(false);

    const { data: roles } = useOrgRolesQuery();
    const dispatcherRoles = useMemo(() => (roles ?? []).filter((r) => r.base_tier === "dispatcher"), [roles]);

    useEffect(() => {
        if (isModalOpen && dispatcherRoles.length > 0 && organizationRoleId === null) {
            const defaultRole = dispatcherRoles.find((r) => r.is_default);
            if (defaultRole) setOrganizationRoleId(defaultRole.id);
        }
    }, [isModalOpen, dispatcherRoles, organizationRoleId]);

    const [submitError, setSubmitError] = useState<string | null>(null);
    const [seatLimit, setSeatLimit] = useState(false);

    const resetForm = useCallback(() => {
        setName("");
        setEmail("");
        setPhone("");
        setTitle("");
        setDescription("");
        setErrors(null);
        setPassword("");
        setChoosePassword(false);
        setOrganizationRoleId(null);
        setSubmitError(null);
        setSeatLimit(false);
    }, []);

	useEffect(() => {
		if (!isModalOpen) {
			resetForm();
			setIsLoading(false);
		}
	}, [isModalOpen, resetForm]);

	const invokeCreate = async () => {
		if (isLoading) return;

        const newDispatcher: CreateDispatcherInput = {
            name: name.trim(),
            email: email.trim(),
            phone: phone.trim(),
            password: choosePassword ? password.trim() : undefined,
            title: title.trim(),
            description: description.trim(),
            organization_role_id: organizationRoleId,
        };

		const parseResult = CreateDispatcherSchema.safeParse(newDispatcher);
		if (!parseResult.success) {
			setErrors(parseResult.error);
			return;
		}

		setErrors(null);
		setSubmitError(null);
		setSeatLimit(false);
		setIsLoading(true);
		try {
			await createDispatcher(newDispatcher);
			setIsModalOpen(false);
			resetForm();
		} catch (error) {
			setSubmitError(errorMessage(error, "Couldn't add the dispatcher. Try again."));
			setSeatLimit(isAxiosError(error) && error.response?.data?.error?.code === "SEAT_LIMIT_REACHED");
		} finally {
			setIsLoading(false);
		}
	};

	const ErrorDisplay = ({ path }: { path: string }) => {
		if (!errors) return null;
		const fieldErrors = errors.issues.filter((err) => err.path[0] === path);
		if (fieldErrors.length === 0) return null;
		return (
			<div className="mt-0.5">
				{fieldErrors.map((err, idx) => (
					<p
						key={idx}
						className="text-error-text text-xs leading-tight"
					>
						{err.message}
					</p>
				))}
			</div>
		);
	};

	const isFormValid = useMemo(
		() =>
			!!(
				name.trim() &&
				email.trim() &&
				phone.trim() &&
				title.trim() &&
				(!choosePassword || password.trim())
			),
		[name, email, phone, title, choosePassword, password]
	);

	const formContent = useMemo(
		() => (
			<div className="space-y-2 lg:space-y-3 xl:space-y-4 min-w-0">
				<FormErrorBanner message={submitError} className="mb-2" />
				{seatLimit && (
					<Link
						to="/dispatch/admin?tab=entitlements"
						className="mb-2 inline-block text-sm text-primary hover:underline"
					>
						View subscription
					</Link>
				)}
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
					<ErrorDisplay path="name" />
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
						<ErrorDisplay path="email" />
					</div>
					<div className="min-w-0">
						<label className={LABEL}>Phone *</label>
						<input
							type="tel"
							placeholder="(555) 123-4567"
							value={phone}
							onChange={(e) => setPhone(e.target.value)}
							className={INPUT}
							disabled={isLoading}
						/>
						<ErrorDisplay path="phone" />
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
                    <ErrorDisplay path="title" />
                </div>

                {/* Role */}
                <div className="min-w-0">
                    <label className={LABEL}>Role</label>
                    <select
                        value={organizationRoleId ?? ""}
                        onChange={(e) => setOrganizationRoleId(e.target.value || null)}
                        className={INPUT}
                        disabled={isLoading}
                    >
                        <option value="">— No Role —</option>
                        {dispatcherRoles.map((r) => (
                            <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                    </select>
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
				{/* Password */}
				<PasswordSetField
					enabled={choosePassword}
					onEnabledChange={setChoosePassword}
					password={password}
					onPasswordChange={setPassword}
					disabled={isLoading}
					description="Otherwise the user sets one from their invite email"
					errorMessages={errors?.issues
						.filter((e) => e.path[0] === "password")
						.map((e) => e.message)}
				/>
			</div>
		),
		[
			name,
			email,
			phone,
			title,
			description,
			isLoading,
			errors,
			choosePassword,
			password,
			organizationRoleId,
			dispatcherRoles,
			ErrorDisplay,
			submitError,
			seatLimit,
		]
	);

	return (
		<FormWizardContainer
			title="Create Dispatcher"
			steps={[]}
			currentStep={1}
			visitedSteps={new Set([1])}
			isLoading={isLoading}
			isOpen={isModalOpen}
			onClose={() => setIsModalOpen(false)}
			onSubmit={invokeCreate}
			canGoNext={isFormValid}
			submitLabel="Create Dispatcher"
		>
			{formContent}
		</FormWizardContainer>
	);
};

export default CreateDispatcher;
