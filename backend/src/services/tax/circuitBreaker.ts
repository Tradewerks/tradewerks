// backend/src/services/tax/circuitBreaker.ts

/** Process-local: each backend instance protects its own request budget. */
export class CircuitBreaker {
	private failures = 0;
	private openUntil = 0;

	constructor(
		private readonly threshold: number,
		private readonly coolDownMs: number,
		private readonly clock: () => number = Date.now
	) {}

	isOpen(): boolean {
		return this.clock() < this.openUntil;
	}

	recordSuccess(): void {
		this.failures = 0;
		this.openUntil = 0;
	}

	recordFailure(): void {
		this.failures += 1;
		if (this.failures >= this.threshold) {
			this.openUntil = this.clock() + this.coolDownMs;
			this.failures = 0;
		}
	}
}
