export function parseStrictIsoTimestamp(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, fraction = "0"] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const [yearNumber, monthNumber, dayNumber, hourNumber, minuteNumber, secondNumber] = parts;
  if (
    yearNumber === undefined ||
    monthNumber === undefined ||
    dayNumber === undefined ||
    hourNumber === undefined ||
    minuteNumber === undefined ||
    secondNumber === undefined ||
    yearNumber < 1970
  ) {
    return undefined;
  }
  const milliseconds = Number(fraction.padEnd(3, "0"));
  const timestamp = Date.UTC(
    yearNumber,
    monthNumber - 1,
    dayNumber,
    hourNumber,
    minuteNumber,
    secondNumber,
    milliseconds,
  );
  const date = new Date(timestamp);
  return date.getUTCFullYear() === yearNumber &&
    date.getUTCMonth() === monthNumber - 1 &&
    date.getUTCDate() === dayNumber &&
    date.getUTCHours() === hourNumber &&
    date.getUTCMinutes() === minuteNumber &&
    date.getUTCSeconds() === secondNumber &&
    date.getUTCMilliseconds() === milliseconds
    ? timestamp
    : undefined;
}

export function validClockValue(value: Date, label: string): string {
  if (!Number.isFinite(value.getTime())) throw new TypeError(`${label} must return a valid date.`);
  return value.toISOString();
}
