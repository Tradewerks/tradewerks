import { useState, useEffect } from "react";
import { useActiveTechniciansQuery } from "../hooks/useTechnicians";
import type { Technician } from "../types/technicians";
import { socket } from "../lib/socket";

export function useLiveTechnicians() {
	const [technicians, setTechnicians] = useState<Technician[]>([]);
	const { data: initialData, isLoading } = useActiveTechniciansQuery();

	useEffect(() => {
		if (initialData) setTechnicians(initialData);
	}, [initialData]);

	useEffect(() => {
		const handleUpdate = (updatedTech: Technician) => {
			setTechnicians((prev) => {
				const exists = prev.some((t) => t.id === updatedTech.id);
				if (exists) {
					return prev.map((t) =>
						t.id === updatedTech.id ? { ...t, ...updatedTech } : t,
					);
				}
				return [...prev, updatedTech];
			});
		};

		socket.on("technician-update", handleUpdate);

		return () => {
			socket.off("technician-update", handleUpdate);
		};
	}, []);

	return { technicians, isLoading };
}
