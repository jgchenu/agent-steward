// Stable loopback address: bookmark it; never bind the unauthenticated console publicly.
export const CONSOLE_PORT = 17831;
export const CONSOLE_URL = `http://127.0.0.1:${CONSOLE_PORT}/`;

export function consolePort(value = process.env.STEWARD_CONSOLE_PORT): number {
  if (value === undefined) return CONSOLE_PORT;
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('STEWARD_CONSOLE_PORT must be an integer between 1 and 65535.');
  }
  return Number(value);
}
