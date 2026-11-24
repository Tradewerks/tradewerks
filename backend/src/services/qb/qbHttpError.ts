/** QuickBooks answered with a non-2xx status (as opposed to a network error / timeout with no answer). */
export class QbHttpError extends Error {
    constructor(
        method: string,
        path: string,
        public readonly status: number,
        body: string,
    ) {
        super(`QB ${method} ${path} → ${status}: ${body}`);
        this.name = "QbHttpError";
    }
}
