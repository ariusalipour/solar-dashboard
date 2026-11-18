const test = require("node:test");
const assert = require("node:assert/strict");
const chart = require("../app/static/chart.js");
const fields = [
  { key: "pvPower", label: "Solar" },
  { key: "batChargePower", label: "Battery charge" },
];
const packet = (time, values, times) => ({ time, values, times });
const range = {
  start: Date.parse("2026-11-16T00:00:00Z"),
  end: Date.parse("2026-11-19T00:00:00Z"),
  mode: "compare",
  days: ["2026-11-16", "2026-11-17"],
};

test("daily overlays align UK clock time while retaining date and metric identity", () => {
  const tracks = chart.prepare(
    [
      packet("2026-11-16T09:00:00Z", { pvPower: 1, batChargePower: 0.2 }),
      packet("2026-11-16T09:05:00Z", { pvPower: 2, batChargePower: 0.4 }),
      packet("2026-11-17T09:00:00Z", { pvPower: 3 }),
      packet("2026-11-18T09:00:00Z", { pvPower: 9 }),
    ],
    fields,
    range,
  );
  const solar = tracks.filter((t) => t.field.key === "pvPower");
  assert.equal(solar.length, 2);
  assert.deepEqual(
    solar.map((t) => t.points[0].x),
    [32400, 32400],
  );
  assert.deepEqual(
    solar.map((t) => t.day),
    range.days,
  );
  assert.equal(
    tracks.find((t) => t.field.key === "batChargePower").points[0].value,
    0.2,
  );
});

test("field timestamp determines date and range; missing battery stays absent", () => {
  const tracks = chart.prepare(
    [
      packet(
        "2026-11-15T23:55:00Z",
        { pvPower: 2 },
        { pvPower: "2026-11-16T00:05:00Z" },
      ),
    ],
    fields,
    range,
  );
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].day, "2026-11-16");
  assert.equal(tracks[0].points[0].x, 300);
  assert.equal(
    chart.prepare(
      [
        packet(
          "2026-11-16T00:00:00Z",
          { pvPower: 2 },
          { pvPower: "2026-11-15T23:55:00Z" },
        ),
      ],
      fields,
      range,
    ).length,
    0,
  );
});

test("sparse measurements do not break a continuous metric; outages do", () => {
  const tracks = chart.prepare(
    [
      packet("2026-11-16T09:00:00Z", { pvPower: 1 }),
      packet("2026-11-16T09:01:00Z", { batChargePower: 0.2 }),
      packet("2026-11-16T09:05:00Z", { pvPower: 2 }),
      packet("2026-11-16T10:00:00Z", { pvPower: 3 }),
    ],
    fields,
    range,
  );
  assert.deepEqual(
    tracks.find((t) => t.field.key === "pvPower").segments.map((s) => s.length),
    [2, 1],
  );
});

test("UK DST uses clock time and splits the repeated autumn hour", () => {
  assert.deepEqual(chart.localParts(Date.parse("2026-07-01T08:00:00Z")), {
    day: "2026-07-01",
    second: 32400,
  });
  const tracks = chart.prepare(
    [
      packet("2026-10-25T00:55:00Z", { pvPower: 1 }),
      packet("2026-10-25T01:00:00Z", { pvPower: 2 }),
      packet("2026-10-25T01:05:00Z", { pvPower: 3 }),
    ],
    [fields[0]],
    {
      mode: "compare",
      start: Date.parse("2026-10-24T23:00:00Z"),
      end: Date.parse("2026-10-26T00:00:00Z"),
      days: ["2026-10-25"],
    },
  );
  assert.deepEqual(
    tracks[0].segments.map((s) => s.length),
    [1, 2],
  );
});

test("nearest-reading inspection never invents a value across a gap", () => {
  const points = [
    { time: 0, x: 0, value: 1 },
    { time: 3600000, x: 3600, value: 2 },
  ];
  assert.equal(chart.nearest(points, 1800, 900, "x"), null);
  assert.equal(chart.nearest(points, 3500, 900, "x").value, 2);
});

test("date selector lists calendar days inclusively across DST and empty selections plot nothing", () => {
  assert.deepEqual(chart.daysBetween("2026-10-24", "2026-10-26"), [
    "2026-10-24",
    "2026-10-25",
    "2026-10-26",
  ]);
  assert.equal(
    chart.prepare([packet("2026-11-16T09:00:00Z", { pvPower: 1 })], fields, {
      ...range,
      days: [],
    }).length,
    0,
  );
  assert.equal(
    chart.prepare([packet("2026-11-16T09:00:00Z", { pvPower: 1 })], [], range)
      .length,
    0,
  );
});
