import { useRef, useState } from "react";
import FilterableSelect from "../ui/forms/FilterableSelect";
import { useClientByIdQuery, useClientSearchQuery, useFetchClient } from "../../hooks/useClients";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useToast } from "../ui/useToast";
import type { Client } from "../../types/clients";

interface ClientPickerProps {
	/** The chosen client's id, or "" for none. */
	value: string;
	onChange: (clientId: string) => void;
	/**
	 * Fires after a pick with the full client, for a form that prefills from it
	 * (address, coordinates, tax). The list rows are slim, so it is fetched by id.
	 */
	onPick?: (client: Client) => void;
	disabled?: boolean;
	error?: boolean;
	placeholder?: string;
}

/**
 * Type-ahead over the server's client search (first 20, A-Z). Nothing is fetched until
 * the field is focused, so a modal that is always mounted costs no request until used.
 */
export default function ClientPicker({
	value,
	onChange,
	onPick,
	disabled,
	error,
	placeholder = "Select client",
}: ClientPickerProps) {
	const toast = useToast();
	const fetchClient = useFetchClient();
	const [text, setText] = useState("");
	const [editing, setEditing] = useState(false);
	const [focused, setFocused] = useState(false);
	const latestPick = useRef("");
	const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
	const q = useDebouncedValue(editing ? text.trim() : "");
	const { data } = useClientSearchQuery(q, { enabled: focused });
	// A client set from outside (a restored draft) has no pick to take the name from.
	const pickedHere = !!value && picked?.id === value;
	const { data: selected } = useClientByIdQuery(value || null, { enabled: !!value && !pickedHere });
	const selectedName = pickedHere ? picked.name : selected?.name;

	return (
		<FilterableSelect
			value={editing ? text : (selectedName ?? "")}
			onChange={(next) => {
				setText(next);
				setEditing(true);
				if (next === "" && value) {
					latestPick.current = "";
					onChange("");
				}
			}}
			onSelect={(o) => {
				setPicked({ id: o.id, name: o.label });
				setEditing(false);
				setText("");
				onChange(o.id);
				latestPick.current = o.id;
				if (!onPick) return;
				// A slow fetch for an earlier pick must not prefill over a later one.
				fetchClient(o.id).then(
					(client) => latestPick.current === o.id && onPick(client),
					(err) => toast.error(err instanceof Error ? err.message : "Failed to load that client")
				);
			}}
			options={(data?.rows ?? []).map((c) => ({
				id: c.id,
				label: c.name,
			}))}
			preFiltered
			placeholder={placeholder}
			disabled={disabled}
			error={error}
			ariaLabel="Client"
			onFocus={() => setFocused(true)}
			onBlur={() => {
				setFocused(false);
				setEditing(false);
				setText("");
			}}
		/>
	);
}
