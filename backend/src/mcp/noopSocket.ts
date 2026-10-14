/**
 * A stand-in Socket.io server for out-of-process tool execution.
 *
 * Several controllers push a real-time update after a successful write —
 * `getSocket().emit(...)` — and most of them do it unguarded, because inside the
 * HTTP server the socket is always initialized. Outside it, `getSocket()` throws,
 * the controller's catch swallows it, and a write that already committed is
 * reported to the caller as a failure. That is the worst possible outcome: the
 * change happened, the agent was told it did not, and it retries or apologises.
 *
 * Installing a no-op here fixes every such call site at once, and does not
 * suppress a genuine bug in the HTTP server — that process installs the real
 * server at boot and never reaches this code.
 *
 * The limitation is real and worth stating: a change made through the MCP server
 * does NOT live-push to dispatchers with the app open. They see it on their next
 * refetch. Cross-process emission would need a Socket.io Redis adapter, which is
 * a bigger change than this transport justifies.
 */

import type { Server } from "socket.io";
import { initSocket } from "../services/socketService.js";

/** Covers the three shapes controllers use: emit, to().emit, and in().emit. */
function createNoopSocket(): Server {
	const sink = {
		emit: () => true,
		to: () => sink,
		in: () => sink,
		except: () => sink,
	};
	return sink as unknown as Server;
}

/**
 * Install the no-op. Call once, before any tool runs.
 *
 * Deliberately not called from `agent/` — a tool should not know or care which
 * process it is in. Only transports that run outside the HTTP server need this.
 */
export function installNoopSocket(): void {
	initSocket(createNoopSocket());
}
