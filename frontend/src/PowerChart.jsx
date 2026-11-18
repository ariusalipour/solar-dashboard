import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Selector } from "@astryxdesign/core/Selector";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import * as SolarChart from "./chart.js";
import "./chart.css";

const fields = [
  {
    key: "pvPower",
    label: "Solar",
    toggle: "pvPower",
    color: "var(--solar-chart-solar)",
  },
  {
    key: "loadsPower",
    label: "Home",
    toggle: "loadsPower",
    color: "var(--solar-chart-home)",
  },
  {
    key: "gridConsumptionPower",
    label: "Import",
    toggle: "gridConsumptionPower",
    color: "var(--solar-chart-import)",
  },
  {
    key: "feedinPower",
    label: "Export",
    toggle: "feedinPower",
    color: "var(--solar-chart-export)",
  },
  {
    key: "batChargePower",
    label: "Battery charge",
    toggle: "battery",
    color: "var(--solar-chart-battery)",
  },
  {
    key: "batDischargePower",
    label: "Battery discharge",
    toggle: "battery",
    color: "var(--solar-chart-battery-discharge)",
  },
];
const metrics = [
  ...fields.slice(0, 4),
  { toggle: "battery", label: "Battery", color: "var(--solar-chart-battery)" },
];
const dateLabel = (day) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "Europe/London",
  }).format(new Date(`${day}T12:00:00Z`));
const stamp = (time) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
    timeZoneName: "short",
  }).format(new Date(time));
const clock = (value) =>
  `${String(Math.floor(value / 3600)).padStart(2, "0")}:${String(Math.floor((value % 3600) / 60)).padStart(2, "0")}`;
function preferences() {
  try {
    const p = JSON.parse(localStorage.getItem("solar-chart") || "{}");
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}

export default function PowerChart({ data, onCompareRequest }) {
  const [prefs] = useState(preferences);
  const [mode, setMode] = useState(
    prefs.mode === "compare" ? "compare" : "timeline",
  );
  const [compareMetric, setCompareMetric] = useState(
    fields.some((field) => field.key === prefs.compareMetric)
      ? prefs.compareMetric
      : "pvPower",
  );
  const [visible, setVisible] = useState(
    () =>
      new Set(
        Array.isArray(prefs.series)
          ? prefs.series
          : metrics.map((m) => m.toggle),
      ),
  );
  const [selection, setSelection] = useState({ range: "", days: [] });
  const [position, setPosition] = useState(null);
  const [width, setWidth] = useState(900);
  const host = useRef(null),
    id = useId();
  useEffect(() => {
    try {
      localStorage.setItem(
        "solar-chart",
        JSON.stringify({ mode, series: [...visible], compareMetric }),
      );
    } catch {}
  }, [mode, visible, compareMetric]);
  useEffect(() => {
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(240, Math.min(900, entries[0].contentRect.width))),
    );
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  const series = data?.chart_series || data?.series || [];
  const range = `${data?.start}/${data?.end}`;
  const days = useMemo(
    () => (data ? SolarChart.daysBetween(data.start, data.end) : []),
    [data?.start, data?.end],
  );
  const populated = useMemo(() => {
    const found = new Set();
    for (const packet of series)
      for (const field of fields) {
        if (mode === "compare" && field.key !== compareMetric) continue;
        if (
          typeof packet.values?.[field.key] !== "number" ||
          !Number.isFinite(packet.values[field.key])
        )
          continue;
        const time = Date.parse(packet.times?.[field.key] || packet.time);
        if (Number.isFinite(time)) found.add(SolarChart.localParts(time).day);
      }
    return found;
  }, [series, mode, compareMetric]);
  const selectedDays = selection.range === range ? selection.days : days;
  const compare = mode === "compare",
    activeFields = fields.filter((f) =>
      compare ? f.key === compareMetric : visible.has(f.toggle),
    );
  const start = Date.parse(data?.chart_start),
    end = Date.parse(data?.chart_end);
  const tracks = useMemo(
    () =>
      SolarChart.prepare(series, activeFields, {
        mode,
        start,
        end,
        days: selectedDays,
      }),
    [series, mode, start, end, visible, compareMetric, selectedDays.join(",")],
  );
  const points = tracks.flatMap((t) => t.points),
    ready = points.length > 0;
  const bounds = { left: 42, right: width - 15, top: 15, bottom: 235 };
  const axisStart = compare ? 0 : start,
    axisEnd = compare ? 86400 : end;
  const xTicks = width < 400 ? 2 : 4;
  const x = (p) =>
    bounds.left +
    ((p - axisStart) / (axisEnd - axisStart)) * (bounds.right - bounds.left);
  const limit =
    Math.ceil(points.reduce((m, p) => Math.max(m, p.value), 0.5) * 2) / 2;
  const y = (value) =>
    bounds.bottom - (value / limit) * (bounds.bottom - bounds.top);
  const positions = compare
    ? Array.from({ length: 289 }, (_, i) => i * 300)
    : [...new Set(points.map((p) => p.time))].sort((a, b) => a - b);
  function nearestIndex(value) {
    let found = 0,
      distance = Infinity;
    positions.forEach((p, i) => {
      if (Math.abs(p - value) < distance) {
        found = i;
        distance = Math.abs(p - value);
      }
    });
    return found;
  }
  const index = position === null ? 0 : nearestIndex(position),
    inspection = position === null ? null : positions[index];
  function chooseDays(values) {
    setSelection({ range, days: values });
    setPosition(null);
  }
  function inspectPointer(event) {
    const rect = event.currentTarget.ownerSVGElement.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    const value =
      axisStart +
      ((px - bounds.left) / (bounds.right - bounds.left)) *
        (axisEnd - axisStart);
    setPosition(positions[nearestIndex(value)]);
  }
  function inspectKey(event) {
    if (
      ![
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
      ].includes(event.key)
    )
      return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? positions.length - 1
          : index + (["ArrowRight", "ArrowUp"].includes(event.key) ? 1 : -1);
    setPosition(positions[Math.max(0, Math.min(positions.length - 1, next))]);
  }
  const readingGroups = (compare ? selectedDays : [null]).map((day) => ({
    day,
    values: activeFields.map((field) => {
      const track = tracks.find(
        (t) => t.field.key === field.key && t.day === day,
      );
      const point =
        inspection === null
          ? null
          : SolarChart.nearest(
              track?.points || [],
              inspection,
              compare ? 450 : 450000,
              compare ? "x" : "time",
            );
      return { field, point };
    }),
  }));
  const inspectionHeading =
    inspection === null
      ? ""
      : compare
        ? `${clock(inspection)} · UK local time`
        : stamp(inspection);
  const description =
    inspection === null
      ? "Use arrow keys to inspect readings"
      : `${inspectionHeading}; ${readingGroups.map((group) => `${group.day ? dateLabel(group.day) : "Readings"}: ${group.values.map(({ field, point }) => `${field.label} ${point ? `${point.value.toFixed(2)} kW at ${stamp(point.time)}` : "no nearby reading"}`).join(", ")}`).join("; ")}`;
  if (!data) return null;
  return (
    <section className="power-chart" ref={host} aria-label="Power usage">
      <div className="power-chart-heading">
        <div>
          <h2>Power usage</h2>
          <p>
            {compare
              ? "Each colour is a date, aligned to the same UK local clock."
              : "Power across your selected dates."}
          </p>
        </div>
        <SegmentedControl
          label="Chart view"
          value={mode}
          onChange={(next) => {
            // Changing the reporting range can remount the chart immediately.
            try {
              localStorage.setItem(
                "solar-chart",
                JSON.stringify({
                  mode: next,
                  series: [...visible],
                  compareMetric,
                }),
              );
            } catch {}
            setMode(next);
            setPosition(null);
            if (next === "compare" && data.start === data.end)
              onCompareRequest?.();
          }}
        >
          <SegmentedControlItem value="timeline" label="Timeline" />
          <SegmentedControlItem value="compare" label="Compare days" />
        </SegmentedControl>
      </div>
      {compare ? (
        <div className="power-chart-comparison-controls">
          <Selector
            label="Measurement"
            value={compareMetric}
            options={fields.map((field) => ({
              value: field.key,
              label: field.label,
            }))}
            onChange={(next) => {
              if (fields.some((field) => field.key === next)) {
                setCompareMetric(next);
                setPosition(null);
              }
            }}
          />
          <p className="power-chart-range-context">
            Comparing {dateLabel(data.start)}
            {data.start !== data.end ? ` – ${dateLabel(data.end)}` : ""}. Change
            dates using the period controls above.
          </p>
        </div>
      ) : (
        <div className="power-chart-metrics" aria-label="Chart metrics">
          {metrics.map((metric) => (
            <div key={metric.toggle} className="power-chart-metric">
              <span
                className="power-chart-swatch"
                style={{ background: metric.color }}
              />
              <CheckboxInput
                label={metric.label}
                value={visible.has(metric.toggle)}
                onChange={(checked) => {
                  setVisible((previous) => {
                    const next = new Set(previous);
                    checked
                      ? next.add(metric.toggle)
                      : next.delete(metric.toggle);
                    return next;
                  });
                  setPosition(null);
                }}
              />
            </div>
          ))}
        </div>
      )}
      {compare && (
        <div className="power-chart-days">
          <div className="power-chart-day-actions">
            <span>
              {selectedDays.length} of {days.length} days selected
            </span>
            <Button
              variant="ghost"
              size="sm"
              label="Select all"
              isDisabled={selectedDays.length === days.length}
              onClick={() => chooseDays(days)}
            />
            <Button
              variant="ghost"
              size="sm"
              label="Clear selection"
              isDisabled={!selectedDays.length}
              onClick={() => chooseDays([])}
            />
          </div>
          <div
            className="power-chart-day-list"
            role="group"
            aria-label="Days shown on the chart"
          >
            {days.map((day) => (
              <div className="power-chart-day" key={day}>
                <span
                  className="power-chart-day-swatch"
                  style={{ background: SolarChart.dayColor(day) }}
                  aria-hidden="true"
                />
                <CheckboxInput
                  label={`${dateLabel(day)}${populated.has(day) ? "" : " · No readings"}`}
                  value={selectedDays.includes(day)}
                  onChange={(checked) =>
                    chooseDays(
                      checked
                        ? [...selectedDays, day].sort()
                        : selectedDays.filter((d) => d !== day),
                    )
                  }
                />
              </div>
            ))}
          </div>
        </div>
      )}
      {!compare && visible.has("battery") && (
        <p className="power-chart-battery-key">
          <span>Battery charge</span>
          <span>Battery discharge · dashed</span>
        </p>
      )}
      <div className="power-chart-plot">
        {ready ? (
          <svg
            viewBox={`0 0 ${width} 280`}
            role="group"
            aria-labelledby={`${id}-title ${id}-desc`}
          >
            <title id={`${id}-title`}>
              {compare
                ? "Daily power comparison"
                : "Power over the selected period"}
            </title>
            <desc id={`${id}-desc`}>
              Power in kilowatts.{" "}
              {compare
                ? "Colours identify dates for the selected measurement."
                : "Colours identify metrics."}
              Gaps remain empty. Use arrow keys to inspect, Home and End to
              jump.
            </desc>
            {Array.from({ length: 5 }, (_, i) => {
              const value = (limit * i) / 4;
              return (
                <g key={`y${i}`}>
                  <line
                    className="power-chart-grid"
                    x1={bounds.left}
                    x2={bounds.right}
                    y1={y(value)}
                    y2={y(value)}
                  />
                  <text
                    className="power-chart-axis"
                    x={bounds.left - 9}
                    y={y(value) + 4}
                    textAnchor="end"
                  >
                    {value.toFixed(1)}
                  </text>
                </g>
              );
            })}
            <text className="power-chart-axis" x={bounds.left} y="8">
              kW
            </text>
            {Array.from({ length: xTicks + 1 }, (_, i) => {
              const value = axisStart + ((axisEnd - axisStart) * i) / xTicks;
              const label = compare
                ? `${String((i * 24) / xTicks).padStart(2, "0")}:00`
                : data.start === data.end && i === xTicks
                  ? "24:00"
                  : new Intl.DateTimeFormat("en-GB", {
                      timeZone: "Europe/London",
                      ...(data.start === data.end
                        ? { hour: "2-digit", minute: "2-digit" }
                        : { day: "numeric", month: "short" }),
                    }).format(new Date(value));
              return (
                <text
                  key={`x${i}`}
                  className="power-chart-axis"
                  x={x(value)}
                  y="265"
                  textAnchor={
                    i === 0 ? "start" : i === xTicks ? "end" : "middle"
                  }
                >
                  {label}
                </text>
              );
            })}
            {tracks.flatMap((track, ti) =>
              track.segments.map((segment, si) => {
                const color = compare
                  ? SolarChart.dayColor(track.day)
                  : track.field.color;
                const dash =
                  !compare && track.field.key === "batDischargePower"
                    ? "5 3"
                    : "";
                return segment.length === 1 ? (
                  <circle
                    key={`${ti}/${si}`}
                    cx={x(segment[0].x)}
                    cy={y(segment[0].value)}
                    r="2"
                    fill={color}
                  />
                ) : (
                  <path
                    key={`${ti}/${si}`}
                    className="power-chart-line"
                    stroke={color}
                    strokeDasharray={dash}
                    d={segment
                      .map(
                        (p, i) =>
                          `${i ? "L" : "M"}${x(p.x).toFixed(2)},${y(p.value).toFixed(2)}`,
                      )
                      .join(" ")}
                  />
                );
              }),
            )}
            {inspection !== null && (
              <line
                className="power-chart-cursor"
                x1={x(inspection)}
                x2={x(inspection)}
                y1={bounds.top}
                y2={bounds.bottom}
              />
            )}
            <rect
              className="power-chart-hit"
              x={bounds.left}
              y={bounds.top}
              width={bounds.right - bounds.left}
              height={bounds.bottom - bounds.top}
              tabIndex="0"
              role="slider"
              aria-label={
                compare
                  ? "Inspect the same time across selected days"
                  : "Inspect power readings"
              }
              aria-valuemin="0"
              aria-valuemax={positions.length - 1}
              aria-valuenow={index}
              aria-valuetext={description}
              onPointerMove={inspectPointer}
              onPointerDown={inspectPointer}
              onFocus={() => {
                if (position === null) setPosition(positions[0]);
              }}
              onKeyDown={inspectKey}
            />
          </svg>
        ) : (
          <div className="power-chart-empty">
            <strong>
              {!activeFields.length
                ? "Choose a series"
                : compare && !selectedDays.length
                  ? "Choose days to compare"
                  : "No readings for this selection"}
            </strong>
            <p>
              {!activeFields.length
                ? "Select a metric above the chart."
                : compare && !selectedDays.length
                  ? "Select at least one day above the chart."
                  : series.length
                    ? "No values are available for the selected metrics and days. Try another metric or date range."
                    : data.first_sample_at
                      ? `Collection started ${stamp(data.first_sample_at)}. FoxESS is checked every five minutes.`
                      : "Readings will appear after collection. Earlier FoxESS history has not been imported."}
            </p>
          </div>
        )}
      </div>
      {ready && (
        <div className="power-chart-detail">
          {inspection === null ? (
            <p>
              Tap or move across the chart to see readings. Use arrow keys when
              the chart is focused. Readings within 7½ minutes are shown.
            </p>
          ) : (
            <>
              <strong>{inspectionHeading}</strong>
              {readingGroups.map((group) => (
                <div
                  className="power-chart-reading"
                  key={group.day || "timeline"}
                >
                  <strong>
                    {group.day ? dateLabel(group.day) : "Readings"}
                  </strong>
                  {group.values.map(({ field, point }) => (
                    <span key={field.key}>
                      <i
                        style={{
                          background: compare
                            ? SolarChart.dayColor(group.day)
                            : field.color,
                        }}
                      />
                      {field.label}{" "}
                      {point ? `${point.value.toFixed(2)} kW` : "—"}{" "}
                      <small>
                        ({point ? stamp(point.time) : "no nearby reading"})
                      </small>
                    </span>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}
