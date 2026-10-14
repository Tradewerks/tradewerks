/**
 * Importing this module registers every tool.
 *
 * The registry is populated as a side effect of import, so anything that wants
 * a complete catalog — the MCP server, the assistant loop, a test — imports
 * `agent/index.ts`, which imports this. Adding a tool means adding a line here;
 * forgetting to means the tool silently does not exist, which is why the
 * catalog test asserts the expected names.
 */

export { getArrivalStatus, getOnTimePerformance } from "./arrivals.js";
export { proposeDraft } from "./drafts.js";
export { getEntityHistoryTool } from "./history.js";
export { getInventoryLevels } from "./inventory.js";
export { getRecord, listRecords } from "./records.js";
export { runReport } from "./reports.js";
export { getSchedule, getTechnicianAvailability } from "./schedule.js";
export { addJobNote, assignTechnician, rescheduleVisit, scheduleVisit, updateJobStatus } from "./scheduling.js";
export { searchRecordsTool } from "./search.js";
