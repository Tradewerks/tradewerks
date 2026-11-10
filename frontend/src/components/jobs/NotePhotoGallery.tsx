import { useState } from "react";
import ImageCarousel from "../inventory/ImageCarousel";
import type { JobNotePhoto } from "../../types/jobs";
import { Camera } from "lucide-react";

export default function NotePhotoGallery({ photos }: {photos: JobNotePhoto[] }){
    const [active, setActive] = useState(0);
    if (!photos.length) return null;
    return (
        <div className="mt-2">
            <ImageCarousel
                images={photos.map((p)=>p.photo_url)}
                index={active}
                onIndexChange={setActive}
                compact
                compactNav
                objectFit="contain"
                frameClassName="w-full h-80"
            />
            <div className="flex flex-wrap gap-1.5 mt-1.5">
				{photos.map((p, i) => (
					<button
						type="button"
						key={p.id}
						onClick={() => setActive(i)}
						className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10px] transition-colors ${
							i === active
								? "bg-surface-raised border-border-strong text-text-primary"
								: "bg-surface border-border text-text-tertiary hover:bg-surface-raised"
						}`}
					>
						<Camera size={10} aria-hidden="true" />
						{p.photo_label}
						{p.photo_name && <span className="max-w-[140px] truncate">· {p.photo_name}</span>}
					</button>
				))}
			</div>
        </div>
    );
}