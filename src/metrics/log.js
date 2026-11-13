/** Machine-readable one-event-per-line logs, shared by later benchmarks. */
/** @param {string} type @param {Record<string, unknown>} [details] */
export function logEvent(type, details = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: type, ...details }));
}
