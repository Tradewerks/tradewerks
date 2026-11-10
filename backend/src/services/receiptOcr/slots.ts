/**
 * A FIFO counting semaphore for one provider's calls in this process. With N backend
 * instances the real ceiling is N x `max`.
 */
export class Slots {
	private active = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(public max: number) {}

	/** Resolves false if no slot came free within `maxWaitMs`. */
	acquire(maxWaitMs: number): Promise<boolean> {
		if (this.active < this.max) {
			this.active += 1;
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			const take = () => {
				clearTimeout(timer);
				this.active += 1;
				resolve(true);
			};
			const timer = setTimeout(() => {
				const i = this.waiters.indexOf(take);
				if (i >= 0) this.waiters.splice(i, 1);
				resolve(false);
			}, maxWaitMs);
			this.waiters.push(take);
		});
	}

	release(): void {
		this.active = Math.max(0, this.active - 1);
		while (this.active < this.max && this.waiters.length > 0) this.waiters.shift()!();
	}

	get inUse(): number {
		return this.active;
	}
}
