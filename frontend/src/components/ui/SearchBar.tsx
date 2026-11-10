import { useState, useEffect, useRef } from "react";
import { Search } from "lucide-react";
import { useSearchParams } from "react-router-dom";

type UrlParamProps = {
	placeholder: string;
	paramKey: string;
	onValueChange?: (v: string) => void;
	onSubmit?: (v: string) => boolean;
	className?: string;
};

type ControlledProps = {
	placeholder: string;
	value: string;
	onChange: (v: string) => void;
	className?: string;
};

type SearchBarProps = UrlParamProps | ControlledProps;

export default function SearchBar(props: SearchBarProps) {
	if ("paramKey" in props) {
		return <UrlParamSearchBar {...props} />;
	}
	return <ControlledSearchBar {...props} />;
}

function UrlParamSearchBar({ placeholder, paramKey, onValueChange, onSubmit, className }: UrlParamProps) {
	const [searchParams, setSearchParams] = useSearchParams();
	const committed = searchParams.get(paramKey) ?? "";
	const [value, setValue] = useState(committed);
	const onValueChangeRef = useRef(onValueChange);

	useEffect(() => {
		onValueChangeRef.current = onValueChange;
	});

	useEffect(() => {
		if (onSubmit) return;
		setValue(committed);
		onValueChangeRef.current?.(committed);
	}, [committed, onSubmit]);

	const handleChange = (v: string) => {
		setValue(v);
		onValueChange?.(v);
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!value.trim()) return;
		if (onSubmit) {
			const accepted = onSubmit(value.trim());
			if (accepted) handleChange("");
			return;
		}
		const next = new URLSearchParams(searchParams);
		next.set(paramKey, value.trim());
		setSearchParams(next);
	};

	return (
		<form onSubmit={handleSubmit} className={`relative ${className ?? "w-full"}`}>
			<Search
				size={16}
				className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
			/>
			<input
				type="text"
				placeholder={placeholder}
				value={value}
				onChange={(e) => handleChange(e.target.value)}
				className="w-full pl-9 pr-3 py-2 rounded-md bg-base border border-border text-sm text-text-primary placeholder:text-faint focus:outline-none focus:ring-1 focus:ring-primary-border"
			/>
		</form>
	);
}

function ControlledSearchBar({ placeholder, value, onChange, className }: ControlledProps) {
	return (
		<div className={`relative ${className ?? "w-full"}`}>
			<Search
				size={16}
				className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
			/>
			<input
				type="text"
				placeholder={placeholder}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="w-full pl-9 pr-3 py-2 rounded-md bg-base border border-border text-sm text-text-primary placeholder:text-faint focus:outline-none focus:ring-1 focus:ring-primary-border"
			/>
		</div>
	);
}
