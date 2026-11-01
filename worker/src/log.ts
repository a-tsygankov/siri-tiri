// One JSON line per log event. Callers pass ids, counts, status codes and
// latencies only: never bodies, audio, tokens or pairing codes.
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function log(event: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), component: 'worker', event, ...fields }));
}
