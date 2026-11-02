import { useEffect, type JSX } from "react";
import { createPortal } from "react-dom";

interface FullPopupProps {
	content: JSX.Element;
	isModalOpen: boolean;
	onClose: () => void;
	size?: "md" | "lg" | "xl";
	hasBackground?: boolean;
	overflowVisible?: boolean;
	// Below sm, dock to the bottom edge as a sheet instead of centering.
	sheet?: boolean;
}

const FullPopup = ({
	content,
	isModalOpen,
	onClose,
	size = "md",
	hasBackground = true,
	overflowVisible = false,
	sheet = false,
}: FullPopupProps) => {
	// Off-click never closes the modal (deliberate — forms inside would lose state),
	// but Escape does. Listener is only attached while open and removed on close/unmount.
	useEffect(() => {
		if (!isModalOpen) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [isModalOpen, onClose]);

	const backdropClass =
		"transition-opacity duration-300 fixed inset-0 z-[4000] bg-black " +
		(isModalOpen ? "opacity-50 pointer-events-auto" : "opacity-0 pointer-events-none");

	const panelClass =
		`fixed inset-0 z-[5000] flex justify-center max-h-screen ${sheet ? "items-end sm:items-center " : "items-center "}` +
		(isModalOpen ? "pointer-events-auto" : "pointer-events-none");

	let insetClass =
		"scrollbar-hide bg-surface border border-border-card shadow-xl min-h-0 text-text-primary flex flex-col ";

	insetClass += sheet
		? "rounded-t-2xl sm:rounded-lg max-h-[92dvh] sm:max-h-[92vh] "
		: "rounded-lg max-h-[92vh] ";
	insetClass += overflowVisible ? "overflow-visible " : "overflow-hidden ";

	const phoneWidth = sheet ? "w-full" : "w-[calc(100%-2rem)]";
	switch (size) {
		case "md":
			insetClass += `${phoneWidth} sm:w-[clamp(600px,55vw,640px)]`;
			break;
		case "lg":
			insetClass += `${phoneWidth} sm:w-[clamp(800px,75vw,1000px)]`;
			break;
		case "xl":
			insetClass += `${phoneWidth} sm:w-[clamp(900px,85vw,1400px)]`;
			break;
	}

	if (!isModalOpen) {
		return (
			<>
				{hasBackground && <div className={backdropClass} />}
				<div className={panelClass} />
			</>
		);
	}

	return createPortal(
		<>
			{hasBackground && <div className={backdropClass} />}
			<div className={panelClass}>
				<div className={insetClass}>{content}</div>
			</div>
		</>,
		document.body
	);
};

export default FullPopup;
