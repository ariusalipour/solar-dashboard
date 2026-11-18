export const zone = "Europe/London";
export const finite = (value) =>
  typeof value === "number" && Number.isFinite(value);
export const pounds = (value) =>
  finite(value)
    ? new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: "GBP",
      }).format(value)
    : "—";
export const kwh = (value) =>
  finite(value)
    ? `${new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} kWh`
    : "—";
export const kw = (value) => (finite(value) ? `${value.toFixed(2)} kW` : "—");
export const pence = (value, unit = "p/kWh") =>
  finite(value)
    ? `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 3 }).format(value)}${unit}`
    : "—";
export function localDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
export function shiftDate(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function dateLabel(value, year = false) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    ...(year ? { year: "numeric" } : {}),
    timeZone: zone,
  }).format(new Date(`${value}T12:00:00Z`));
}
export function stamp(value) {
  return value
    ? new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: zone,
      }).format(new Date(value))
    : "Not received";
}
