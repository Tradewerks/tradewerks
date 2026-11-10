import { useState, type InputHTMLAttributes } from "react";

// Lets the field sit empty while typing; a controlled number snaps "" back to "0".
export default function NumberInput({ value, onValue, onBlur, ...rest }: Omit<
	InputHTMLAttributes<HTMLInputElement>,
	"value" | "onChange" | "type"
> & { value: number; onValue: (n: number) => void }) {
	const [draft, setDraft] = useState<string | null>(null);
	return (
		<input
			{...rest}
			type="number"
			value={draft ?? value}
			onChange={(e) => {
				setDraft(e.target.value);
				onValue(Number(e.target.value));
			}}
			onBlur={(e) => {
				setDraft(null);
				onBlur?.(e);
			}}
		/>
	);
}
