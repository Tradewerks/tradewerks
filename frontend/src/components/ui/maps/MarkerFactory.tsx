import { renderToStaticMarkup } from "react-dom/server";
import type { StaticMarker } from "../../../types/location";
import { Building2, MapPin, Users, Wrench } from "lucide-react";

const iconStyles = "m-auto h-full text-white";

const CreateMarker = (m: StaticMarker) => {
	let bgColor = "";
	let icon = null;

	switch (m.type) {
		case "CLIENT": {
			bgColor = " bg-primary ";
			icon = <Users className={iconStyles} size={20} />;
			break;
		}

		case "TECHNICIAN": {
			bgColor = " [background-color:var(--color-orange)] ";
			icon = <Wrench className={iconStyles} size={20} />;
			break;
		}

		case "SITE": {
			bgColor = " bg-primary ";
			icon = <MapPin className={iconStyles} size={20} />;
			break;
		}

		case "WAREHOUSE": {
			bgColor = " bg-neutral ";
			icon = <Building2 className={iconStyles} size={18} />;
			break;
		}
	}

	const borderStyle = m.color
		? { borderColor: m.color, borderWidth: "3px", borderStyle: "solid" as const }
		: undefined;

	const dimmed = m.variant === "dimmed";

	const reactElement = (
		<div className={`flex flex-col items-center ${dimmed ? "opacity-80" : ""}`}>
			<div className="relative mx-auto">
				<div
					className={`${dimmed ? "w-6 h-6" : "w-8 h-8"} rounded-full shadow-md ${m.color ? "" : "border-3 border-white"} ${bgColor}`}
					style={borderStyle}
				></div>
				<div
					className={`absolute top-0 left-0 ${dimmed ? "w-6 h-6" : "w-8 h-8"} flex items-center justify-center`}
				>
					{icon}
				</div>
				{m.statusDotColor && (
					<div
						className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-canvas ${m.statusDotColor}`}
					></div>
				)}
			</div>

			{m.label && (
				<div
					className="mt-1 px-2 py-0.5 rounded-md bg-base border border-border text-text-primary text-xs font-semibold whitespace-nowrap shadow-md"
					style={{ pointerEvents: "none" }}
				>
					{m.label}
				</div>
			)}
		</div>
	);

	const output = document.createElement("div");
	const staticElement = renderToStaticMarkup(reactElement);
	output.innerHTML = staticElement;
	output.classList.add("mapboxgl-marker");

	if (m.onClick) {
		output.style.cursor = "pointer";
		output.addEventListener("click", m.onClick);
	}

	return output;
};

export default CreateMarker;
