/** Shared ffprobe/remux duration tolerance, in seconds. */
export function durationTolerance(seconds: number): number { return Math.max(0.1, Math.min(2, seconds * 0.001)); }
