declare global {
    namespace Express {
        interface Request {
            user?: {
                uid: string;
                email: string;
                role: string;
                organization_id: string | null;
                permissions: string[] | null;
            }
            staff?: { id: string; email: string; name: string };
            // Raw request bytes for webhook
            rawBody?: Buffer;
        }
    }
}

export {};