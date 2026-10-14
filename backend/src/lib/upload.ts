import multer from "multer";

const WEB_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"];

export const imageUpload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
	fileFilter: (_req, file, cb) => {
		if (WEB_IMAGE_MIMES.includes(file.mimetype)) {
			cb(null, true);
		} else {
			cb(new Error("Only JPEG, PNG, and WebP images are allowed"));
		}
	},
});

/**
 * Receipts only. iOS tags a camera photo image/heic even after the browser has
 * re-encoded it to JPEG, and rejecting on that tag lost real receipts — but the
 * tolerance stops here rather than letting genuinely undisplayable HEIC into
 * every other image surface.
 */
export const receiptUpload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
	fileFilter: (_req, file, cb) => {
		if ([...WEB_IMAGE_MIMES, "image/heic", "image/heif"].includes(file.mimetype)) {
			cb(null, true);
		} else {
			cb(new Error("Only JPEG, PNG, WebP, and HEIC images are allowed"));
		}
	},
});

const SPREADSHEET_MIMES = [
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
	"application/vnd.ms-excel", // xls
	"text/csv",
	"application/csv",
];

export const spreadsheetUpload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
	fileFilter: (_req, file, cb) => {
		const ext = file.originalname.split(".").pop()?.toLowerCase();
		if (
			SPREADSHEET_MIMES.includes(file.mimetype) ||
			["xlsx", "xls", "csv"].includes(ext ?? "")
		) {
			cb(null, true);
		} else {
			cb(new Error("Only .xlsx, .xls, and .csv files are allowed"));
		}
	},
});
