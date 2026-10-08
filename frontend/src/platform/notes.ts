export const MIN_NOTE = 3;
export const noteReady = (text: string) => text.trim().length >= MIN_NOTE;
export const REASON_TOO_SHORT = `Give a reason (${MIN_NOTE} characters or more)`;
export const NOTE_TOO_SHORT = `Add a note (${MIN_NOTE} characters or more)`;
