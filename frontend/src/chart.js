"use strict";
const formatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
function localParts(time) {
  const p = Object.fromEntries(
    formatter.formatToParts(new Date(time)).map((x) => [x.type, x.value]),
  );
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    second: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second),
  };
}
function daysBetween(start, end) {
  const days = [];
  for (
    let time = Date.parse(start + "T12:00:00Z");
    time <= Date.parse(end + "T12:00:00Z");
    time += 86400000
  )
    days.push(new Date(time).toISOString().slice(0, 10));
  return days;
}
function prepare(series, fields, { mode = "timeline", start, end, days = [] }) {
  const selected = new Set(days),
    tracks = [];
  for (const field of fields) {
    const byDay = new Map();
    let current = [],
      previous = null;
    const flush = () => {
      if (current.length) {
        const day = mode === "compare" ? current[0].day : null;
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(current);
        current = [];
      }
    };
    // Sparse packets are asynchronous: absent keys do not mean a missing reading.
    // Deduplicate by field timestamp (latest supplied value wins), then sort that field.
    const records = new Map();
    for (const sample of series) {
      if (!Object.prototype.hasOwnProperty.call(sample.values || {}, field.key))
        continue;
      const time = Date.parse(sample.times?.[field.key] || sample.time);
      if (Number.isFinite(time))
        records.set(time, { time, value: sample.values[field.key] });
    }
    for (const { time, value } of [...records.values()].sort(
      (a, b) => a.time - b.time,
    )) {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        !Number.isFinite(time) ||
        time < start ||
        time >= end
      ) {
        flush();
        previous = null;
        continue;
      }
      const parts = localParts(time),
        point = {
          time,
          value,
          day: parts.day,
          x: mode === "compare" ? parts.second : time,
        };
      if (mode === "compare" && !selected.has(point.day)) {
        flush();
        previous = null;
        continue;
      }
      if (
        previous &&
        (time <= previous.time ||
          time - previous.time > 900000 ||
          (mode === "compare" &&
            (point.day !== previous.day || point.x <= previous.x)))
      )
        flush();
      current.push(point);
      previous = point;
    }
    flush();
    for (const [day, segments] of byDay)
      tracks.push({ field, day, segments, points: segments.flat() });
  }
  return tracks;
}
function nearest(points, target, tolerance = 900000, coordinate = "time") {
  let distance = Infinity,
    result = null;
  for (const point of points) {
    const delta = Math.abs(point[coordinate] - target);
    if (delta < distance) {
      distance = delta;
      result = point;
    }
  }
  return distance <= tolerance ? result : null;
}

// A calendar date owns its colour, independent of the displayed range or order.
function dayColor(day) {
  const ordinal = Math.floor(Date.parse(`${day}T12:00:00Z`) / 86400000);
  const hue = (((ordinal * 137.508) % 360) + 360) % 360;
  return `light-dark(hsl(${hue.toFixed(3)} 68% 36%), hsl(${hue.toFixed(3)} 74% 70%))`;
}

export { localParts, daysBetween, prepare, nearest, dayColor };
