"use strict";
const $ = (id) => document.getElementById(id);
const zone = "Europe/London";
const state = {
  settings: null,
  data: null,
  start: "",
  end: "",
  period: "today",
  request: 0,
  editing: null,
  page: "overview",
  authenticated: false,
  chartIndex: null,
};
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const pounds = (value) =>
  finite(value)
    ? new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: "GBP",
      }).format(value)
    : "—";
const kwh = (value) =>
  finite(value)
    ? `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(value)} kWh`
    : "—";
const kw = (value) => (finite(value) ? `${value.toFixed(2)} kW` : "—");
const pence = (value, unit) =>
  `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 3 }).format(value)}${unit}`;
function text(id, value) {
  $(id).textContent = value;
}
function localDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
function shiftDate(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function dateLabel(value, year = false) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    ...(year ? { year: "numeric" } : {}),
    timeZone: zone,
  }).format(new Date(`${value}T12:00:00Z`));
}
function stamp(value) {
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
function message(id, value, error = false) {
  text(id, value);
  $(id).classList.toggle("error", error);
}
function busy(form, value) {
  form.querySelectorAll('button[type="submit"]').forEach((button) => {
    button.disabled = value;
  });
  form.setAttribute("aria-busy", String(value));
}
async function api(url, body, method = "POST") {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...(body === undefined
      ? {}
      : {
          method,
          headers: {
            "Content-Type": "application/json",
            "X-Solar-Request": "1",
          },
          body: JSON.stringify(body),
        }),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      "Unable to load the dashboard. Check your connection and try again.",
    );
  }
  if (!response.ok) {
    if (response.status === 401 && url !== "/api/login") showLogin();
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : "Unable to save. Check the fields and try again.",
    );
  }
  return data;
}
function showLogin() {
  state.authenticated = false;
  $("login-view").hidden = false;
  $("app-view").hidden = true;
}
function showApp() {
  state.authenticated = true;
  $("login-view").hidden = true;
  $("app-view").hidden = false;
  showPage();
}
function pageError(error) {
  const host = $("page-error");
  const copy = document.createElement("span");
  copy.textContent = error.message;
  const retry = document.createElement("button");
  retry.className = "button small";
  retry.textContent = "Retry";
  retry.addEventListener("click", async () => {
    retry.disabled = true;
    if (!state.settings) await startDashboard();
    else await refresh();
    retry.disabled = false;
  });
  host.replaceChildren(copy, document.createTextNode(" "), retry);
  host.hidden = false;
}
async function startDashboard() {
  showApp();
  try {
    await loadSettings();
    setPeriod("today");
    $("page-error").hidden = true;
  } catch (error) {
    if (state.authenticated) pageError(error);
    $("overview-loading").hidden = true;
  }
}
function showPage() {
  const name = location.hash.slice(1);
  state.page = ["overview", "tariff", "connection"].includes(name)
    ? name
    : "overview";
  const titles = {
    overview: ["Overview", "Solar, grid usage and electricity costs."],
    tariff: [
      "Electricity tariff",
      "Set the rates used to calculate grid costs.",
    ],
    connection: ["Connection", "Manage your FoxESS Cloud connection."],
  };
  document
    .querySelectorAll("[data-view]")
    .forEach((view) => (view.hidden = view.dataset.view !== state.page));
  document.querySelectorAll("[data-page]").forEach((link) => {
    if (link.dataset.page === state.page)
      link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  text("page-title", titles[state.page][0]);
  text("page-subtitle", titles[state.page][1]);
  document.title = `Solar — ${titles[state.page][0]}`;
  $("custom-dates").open = false;
}
window.addEventListener("hashchange", () => {
  if (location.hash === "#main") {
    $("main").focus({ preventScroll: true });
    return;
  }
  showPage();
  $("main").focus({ preventScroll: true });
});
function setPeriod(period) {
  const today = localDate();
  state.period = period;
  state.end = period === "yesterday" ? shiftDate(today, -1) : today;
  state.start =
    period === "week"
      ? shiftDate(today, -6)
      : period === "month"
        ? shiftDate(today, -29)
        : state.end;
  $("range-start").value = state.start;
  $("range-end").value = state.end;
  updatePeriodButtons();
  refresh();
}
function updatePeriodButtons() {
  document
    .querySelectorAll("[data-period]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.period === state.period),
      ),
    );
}
function powerValue(id, value, unit = "kW") {
  const element = $(id);
  element.replaceChildren();
  if (!finite(value)) {
    element.textContent = "—";
    return;
  }
  element.append(
    document.createTextNode(
      unit === "%" ? Math.round(value).toString() : value.toFixed(2),
    ),
  );
  const suffix = document.createElement("span");
  suffix.className = "value-unit";
  suffix.textContent = unit;
  element.append(suffix);
}
function activeTariff() {
  return [...(state.settings?.tariffs || [])]
    .reverse()
    .find((t) => t.effective_from <= localDate());
}
async function loadSettings(preferDate = null) {
  state.settings = await api("/api/settings");
  renderSettings();
  const tariffs = state.settings.tariffs || [];
  const tariff = preferDate
    ? tariffs.find((t) => t.effective_from === preferDate)
    : activeTariff();
  setTariffEditor(tariff || null);
}
function renderSettings() {
  const settings = state.settings;
  text(
    "connection-tag",
    settings.connected
      ? "Connected"
      : settings.has_key
        ? "Select inverter"
        : "Not connected",
  );
  text(
    "connection-summary",
    settings.connected
      ? "Connected to your selected inverter. Leave the key blank to keep the saved connection."
      : "Connect with an API key. Your FoxESS password is not needed.",
  );
  text(
    "key-state",
    settings.has_key
      ? "API key saved. Leave blank to keep it, or enter a replacement."
      : "The key is stored privately on your server.",
  );
  $("api-key").placeholder = settings.has_key
    ? "Saved key — enter only to replace"
    : "Enter your FoxESS API key";
  $("api-key").required = !settings.has_key;
  const select = $("device");
  select.replaceChildren();
  if ((settings.devices || []).length > 1 && !settings.selected_sn) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Select an inverter";
    select.append(option);
  }
  (settings.devices || []).forEach((device, index) => {
    const option = document.createElement("option");
    option.value = device.sn;
    option.textContent = `${device.name || "Inverter"} · ${device.sn.slice(-6)}`;
    select.append(option);
  });
  select.value = settings.selected_sn || "";
  select.required = !settings.connected && settings.devices?.length > 1;
  select.disabled = settings.connected;
  $("device-field").hidden = !settings.devices?.length;
  text(
    "save-connection",
    settings.connected
      ? "Update connection"
      : settings.devices?.length > 1
        ? "Connect inverter"
        : "Connect FoxESS",
  );
  const current = activeTariff();
  $("current-tariff-empty").hidden = !!current;
  $("current-tariff-content").hidden = !current;
  text(
    "tariff-summary-date",
    current
      ? `From ${dateLabel(current.effective_from, true)}`
      : "Not configured",
  );
  if (current) {
    text("current-peak", pence(current.peak_rate, "p/kWh"));
    text("current-offpeak", pence(current.offpeak_rate, "p/kWh"));
    text("current-export", pence(current.export_rate, "p/kWh"));
    text("current-standing", pence(current.standing_charge, "p/day"));
    text(
      "schedule-description",
      `Off-peak ${current.offpeak_start}–${current.offpeak_end}`,
    );
    renderSchedule(current);
  }
  const host = $("tariff-history");
  host.replaceChildren();
  if (!settings.tariffs?.length) {
    host.textContent = "No tariffs saved.";
    return;
  }
  [...settings.tariffs].reverse().forEach((tariff) => {
    const row = document.createElement("div");
    row.className = "tariff-history-row";
    const details = document.createElement("div");
    const heading = document.createElement("strong");
    heading.textContent = `From ${dateLabel(tariff.effective_from, true)}${tariff.effective_from > localDate() ? " · Scheduled" : ""}`;
    const summary = document.createElement("p");
    summary.textContent = `Peak ${tariff.peak_rate}p · Off-peak ${tariff.offpeak_rate}p (${tariff.offpeak_start}–${tariff.offpeak_end}) · Export ${tariff.export_rate}p · Standing ${tariff.standing_charge}p/day`;
    details.append(heading, summary);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "button small";
    edit.textContent = "Edit";
    edit.setAttribute(
      "aria-label",
      `Edit tariff from ${dateLabel(tariff.effective_from, true)}`,
    );
    edit.addEventListener("click", () => {
      setTariffEditor(tariff);
      $("tariff-editor-title").scrollIntoView({ block: "start" });
      $("tariff-form").elements.peak_rate.focus({ preventScroll: true });
    });
    row.append(details, edit);
    host.append(row);
  });
}
function setTariffEditor(tariff, newChange = false) {
  const form = $("tariff-form");
  form.reset();
  state.editing = newChange ? null : tariff?.effective_from || null;
  if (tariff)
    for (const [key, value] of Object.entries(tariff)) {
      if (form.elements.namedItem(key))
        form.elements.namedItem(key).value = value;
    }
  if (!state.editing) {
    let candidate = localDate();
    const dates = new Set(
      (state.settings?.tariffs || []).map((t) => t.effective_from),
    );
    while (dates.has(candidate)) candidate = shiftDate(candidate, 1);
    form.elements.effective_from.value = candidate;
  }
  form.elements.effective_from.readOnly = !!state.editing;
  text(
    "tariff-editor-title",
    state.editing
      ? "Edit tariff"
      : newChange
        ? "Add a rate change"
        : "Add tariff",
  );
  text("save-tariff", state.editing ? "Save corrections" : "Save tariff");
  $("new-tariff").hidden = !state.settings?.tariffs?.length || newChange;
  $("cancel-tariff-edit").hidden = !state.settings?.tariffs?.length;
  $("correction-warning").hidden = !state.editing;
  text(
    "tariff-date-hint",
    state.editing
      ? "The start date is fixed. Add a rate change to use different rates from a new date."
      : "Choose when these rates started. Earlier dates keep their existing tariff.",
  );
  message("tariff-message", "");
  schedulePreview();
}
function schedulePreview() {
  const form = $("tariff-form"),
    start = form.elements.offpeak_start.value,
    end = form.elements.offpeak_end.value;
  const flat =
    form.elements.peak_rate.value !== "" &&
    Number(form.elements.peak_rate.value) ===
      Number(form.elements.offpeak_rate.value);
  text(
    "schedule-preview",
    flat
      ? "Both rates are equal: the same import price applies all day."
      : start && end
        ? `Off-peak ${start}–${end}${start > end ? " (overnight)" : ""}. Peak rates apply outside this window. Times use Europe/London.`
        : "Times use Europe/London and can cross midnight.",
  );
}
function svgNode(name, attributes = {}, content) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes))
    element.setAttribute(key, String(value));
  if (content !== undefined) element.textContent = content;
  return element;
}
function renderSchedule(tariff) {
  const svg = $("schedule-chart");
  svg.replaceChildren();
  const minute = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const start = minute(tariff.offpeak_start),
    end = minute(tariff.offpeak_end);
  svg.append(
    svgNode(
      "title",
      {},
      `Off-peak from ${tariff.offpeak_start} to ${tariff.offpeak_end}, UK local time`,
    ),
    svgNode("rect", {
      x: 0,
      y: 0,
      width: 720,
      height: 13,
      rx: 3,
      class: "schedule-peak",
    }),
  );
  const intervals =
    start < end
      ? [[start, end]]
      : [
          [0, end],
          [start, 1440],
        ];
  if (tariff.peak_rate === tariff.offpeak_rate)
    svg.append(
      svgNode("rect", {
        x: 0,
        y: 0,
        width: 720,
        height: 13,
        rx: 3,
        class: "schedule-offpeak",
      }),
    );
  else
    intervals.forEach(([a, b]) =>
      svg.append(
        svgNode("rect", {
          x: a / 2,
          y: 0,
          width: (b - a) / 2,
          height: 13,
          rx: 2,
          class: "schedule-offpeak",
        }),
      ),
    );
  [0, 6, 12, 18, 24].forEach((hour, index) =>
    svg.append(
      svgNode(
        "text",
        {
          x: hour * 30,
          y: 34,
          "text-anchor": index === 0 ? "start" : index === 4 ? "end" : "middle",
          class: "schedule-text",
        },
        `${String(hour).padStart(2, "0")}:00`,
      ),
    ),
  );
}
async function refresh() {
  if (!state.authenticated) return;
  const request = ++state.request;
  try {
    const data = await api(
      `/api/dashboard?start=${state.start}&end=${state.end}`,
    );
    if (request !== state.request) return;
    state.data = data;
    renderDashboard(data);
    $("page-error").hidden = true;
  } catch (error) {
    if (request !== state.request) return;
    if (state.authenticated) pageError(error);
  } finally {
    $("overview-loading").hidden = true;
  }
}
function renderDashboard(data) {
  const connected = data.connected,
    latest = data.latest,
    values = latest?.values || {},
    hasIntervals = Boolean(data.has_energy_intervals);
  $("setup-section").hidden = connected;
  $("overview-content").hidden = !connected;
  const current = activeTariff();
  $("tariff-step").classList.toggle("done", !!current);
  text("tariff-step", current ? "✓" : "2");
  text("setup-tariff-action", current ? "Edit tariff" : "Add tariff");
  text(
    "setup-tariff-text",
    current
      ? `Peak ${current.peak_rate}p · Off-peak ${current.offpeak_rate}p (${current.offpeak_start}–${current.offpeak_end})`
      : "Import rates, off-peak hours and export payments.",
  );
  $("connection-dot").classList.toggle("connected", connected && !data.stale);
  $("connection-dot").classList.toggle("warning", connected && data.stale);
  text(
    "header-status-text",
    !connected
      ? "Not connected"
      : !latest
        ? "Waiting for readings"
        : data.stale
          ? "Readings delayed"
          : "Connected",
  );
  text(
    "reading-time",
    latest
      ? `${data.stale ? "Last reading" : "Updated"} ${stamp(latest.time)}`
      : "Waiting for first reading",
  );
  powerValue("pv-value", values.pvPower);
  powerValue("home-value", values.loadsPower);
  text("grid-import", kw(values.gridConsumptionPower));
  text("grid-export", kw(values.feedinPower));
  powerValue("battery-value", values.SoC, "%");
  text(
    "battery-detail",
    finite(values.batChargePower) && values.batChargePower > 0
      ? `Charging · ${kw(values.batChargePower)}`
      : finite(values.batDischargePower) && values.batDischargePower > 0
        ? `Discharging · ${kw(values.batDischargePower)}`
        : finite(values.SoC)
          ? "Charge level"
          : "Not reported by inverter",
  );
  const issue =
    data.collector?.error ||
    (latest && data.stale
      ? "The latest reading is more than 15 minutes old. Collection will retry automatically."
      : "");
  $("collector-notice").hidden = !issue;
  text("collector-notice", issue);
  text("connection-last-reading", stamp(latest?.time));
  text("api-calls", String(data.calls_today || 0));
  message(
    "connection-collection-error",
    data.collector?.error || "",
    !!data.collector?.error,
  );
  const c = data.costs || {};
  const energyValue = (value) => (hasIntervals ? value : null);
  text("net-cost", pounds(hasIntervals ? c.net_cost : null));
  text("import-total", kwh(energyValue(c.import_kwh)));
  text("export-total", kwh(energyValue(c.export_kwh)));
  text("peak-energy", kwh(energyValue(c.peak_kwh)));
  text("offpeak-energy", kwh(energyValue(c.offpeak_kwh)));
  text("export-energy", kwh(energyValue(c.export_kwh)));
  text("peak-cost", pounds(hasIntervals ? c.peak_cost : null));
  text("offpeak-cost", pounds(hasIntervals ? c.offpeak_cost : null));
  text(
    "export-credit",
    hasIntervals && finite(c.export_credit)
      ? `−${pounds(c.export_credit)}`
      : "—",
  );
  text("standing-cost", pounds(c.standing_charge));
  const days =
    Math.round((new Date(data.end) - new Date(data.start)) / 86400000) + 1;
  text(
    "standing-days",
    `${new Intl.NumberFormat("en-GB").format(days)} ${days === 1 ? "day" : "days"}`,
  );
  text(
    "cost-status",
    !hasIntervals
      ? "Waiting for valid grid meter readings."
      : !data.tariff_configured
        ? "Add your electricity tariff to calculate costs."
        : c.net_cost === null
          ? "No tariff covers part of this period. Add the missing rates."
          : data.coverage.percent < 99
            ? "Partial estimate · gaps in readings are excluded."
            : "Import + standing charge − export credit.",
  );
  text(
    "cost-tariff-action",
    data.tariff_configured
      ? "View electricity tariff →"
      : "Set electricity tariff →",
  );
  text(
    "coverage-text",
    hasIntervals
      ? `${data.coverage.percent.toFixed(1)}% of elapsed time covered · ${data.interval_count} measured intervals`
      : "No valid grid meter intervals in this period",
  );
  text(
    "range-caption",
    data.start === data.end
      ? dateLabel(data.start, true)
      : `${dateLabel(data.start)} – ${dateLabel(data.end, true)}`,
  );
  renderChart(data);
}
const chartFields = [
  { key: "pvPower", label: "Solar", css: "solar-line" },
  { key: "loadsPower", label: "Home", css: "home-line" },
  { key: "gridConsumptionPower", label: "Import", css: "grid-line" },
  { key: "feedinPower", label: "Export", css: "export-line" },
];
function renderChart(data) {
  const svg = $("energy-chart");
  const hadFocus = svg.contains(document.activeElement);
  const previousTime = state.chartTime;
  svg.replaceChildren(
    svgNode("title", { id: "chart-title" }, "Power over the selected period"),
    svgNode(
      "desc",
      { id: "chart-desc" },
      "Solar, home consumption, grid import and export in kilowatts. Missing readings appear as gaps. Use the arrow keys to inspect readings.",
    ),
  );
  const visible = new Set(
    [...document.querySelectorAll("[data-series]:checked")].map(
      (input) => input.dataset.series,
    ),
  );
  const fields = chartFields.filter((field) => visible.has(field.key));
  const series = (data.series || []).filter((sample) =>
    finite(Date.parse(sample.time)),
  );
  text(
    "chart-sample-count",
    `${series.length} ${series.length === 1 ? "reading" : "readings"}`,
  );
  const usable = series.filter((sample) =>
    fields.some((field) => finite(sample.values?.[field.key])),
  );
  const ready = usable.length >= 2;
  $("chart-empty").hidden = ready;
  if (!ready) {
    const noFields = fields.length === 0,
      hasAny = series.length > 0,
      isBeforeCollection =
        data.first_sample_at &&
        Date.parse(data.chart_end) <= Date.parse(data.first_sample_at);
    text(
      "chart-empty-title",
      noFields
        ? "Choose a series"
        : hasAny
          ? "Waiting for more readings"
          : "No readings for this period",
    );
    text(
      "chart-empty-text",
      noFields
        ? "Select Solar, Home, Import or Export above the chart."
        : hasAny
          ? "The chart needs two readings with power values. FoxESS is checked every five minutes."
          : isBeforeCollection
            ? `Collection started ${stamp(data.first_sample_at)}. Earlier FoxESS history has not been imported.`
            : data.end < localDate()
              ? "No readings were stored for these dates. Earlier FoxESS history has not been imported."
              : "New readings will appear here after the next collection.",
    );
    $("show-today").hidden = noFields || state.period === "today";
    text("chart-detail", "");
    return;
  }
  const start = Date.parse(data.chart_start),
    end = Date.parse(data.chart_end);
  const bounds = { left: 42, right: 885, top: 15, bottom: 235 };
  const limit = Math.max(
    0.5,
    Math.ceil(
      Math.max(
        ...usable.flatMap((sample) =>
          fields.map((field) => Math.max(0, sample.values?.[field.key] || 0)),
        ),
      ) * 2,
    ) / 2,
  );
  const x = (time) =>
      bounds.left +
      ((time - start) / (end - start)) * (bounds.right - bounds.left),
    y = (value) =>
      bounds.bottom - (value / limit) * (bounds.bottom - bounds.top);
  for (let i = 0; i <= 4; i++) {
    const value = (limit * i) / 4;
    svg.append(
      svgNode("line", {
        x1: bounds.left,
        y1: y(value),
        x2: bounds.right,
        y2: y(value),
        class: "chart-grid",
      }),
      svgNode(
        "text",
        {
          x: bounds.left - 9,
          y: y(value) + 4,
          "text-anchor": "end",
          class: "chart-axis-label",
        },
        value.toFixed(1),
      ),
    );
  }
  for (let i = 0; i <= 4; i++) {
    const time = start + ((end - start) * i) / 4;
    let label = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      ...(data.start === data.end
        ? { hour: "2-digit", minute: "2-digit" }
        : { day: "numeric", month: "short" }),
    }).format(new Date(time));
    if (data.start === data.end && i === 4) label = "24:00";
    svg.append(
      svgNode(
        "text",
        {
          x: x(time),
          y: 265,
          "text-anchor": i === 0 ? "start" : i === 4 ? "end" : "middle",
          class: "chart-axis-label",
        },
        label,
      ),
    );
  }
  fields.forEach((field) => {
    let path = "",
      last = null;
    series.forEach((sample) => {
      const value = sample.values?.[field.key],
        time = Date.parse(sample.times?.[field.key] || sample.time);
      if (!finite(value) || !finite(time) || time < start || time > end) {
        last = null;
        return;
      }
      const move = last === null || time - last > 900000 || time <= last;
      path += `${move ? "M" : "L"}${x(time).toFixed(2)},${y(value).toFixed(2)} `;
      last = time;
    });
    if (path)
      svg.append(svgNode("path", { d: path, class: `plot-line ${field.css}` }));
  });
  const cursor = svgNode("line", {
    x1: bounds.left,
    x2: bounds.left,
    y1: bounds.top,
    y2: bounds.bottom,
    class: "chart-cursor",
    visibility: "hidden",
  });
  svg.append(cursor);
  const hit = svgNode("rect", {
    x: bounds.left,
    y: bounds.top,
    width: bounds.right - bounds.left,
    height: bounds.bottom - bounds.top,
    class: "chart-hit",
    tabindex: 0,
    role: "slider",
    "aria-label": "Inspect power readings",
    "aria-valuemin": 0,
    "aria-valuemax": series.length - 1,
    "aria-valuenow": 0,
  });
  svg.append(hit);
  let index = 0;
  function inspect(next) {
    index = Math.max(0, Math.min(series.length - 1, next));
    const sample = series[index];
    state.chartTime = sample.time;
    const lineX = x(Date.parse(sample.time));
    cursor.setAttribute("x1", lineX);
    cursor.setAttribute("x2", lineX);
    cursor.setAttribute("visibility", "visible");
    hit.setAttribute("aria-valuenow", index);
    const detail = $("chart-detail");
    detail.replaceChildren();
    const descriptions = [
      stamp(sample.time),
      ...fields.map(
        (field) => `${field.label} ${kw(sample.values?.[field.key])}`,
      ),
    ];
    descriptions.forEach((value) => {
      const span = document.createElement("span");
      span.textContent = value;
      detail.append(span);
    });
    hit.setAttribute("aria-valuetext", descriptions.join(" · "));
  }
  function inspectPointer(event) {
    const rect = svg.getBoundingClientRect(),
      point = ((event.clientX - rect.left) / rect.width) * 900,
      time =
        start +
        ((point - bounds.left) / (bounds.right - bounds.left)) * (end - start);
    let closest = 0,
      distance = Infinity;
    series.forEach((sample, i) => {
      const delta = Math.abs(Date.parse(sample.time) - time);
      if (delta < distance) {
        distance = delta;
        closest = i;
      }
    });
    inspect(closest);
  }
  hit.addEventListener("pointermove", inspectPointer);
  hit.addEventListener("pointerdown", inspectPointer);
  hit.addEventListener("focus", () => inspect(index));
  hit.addEventListener("keydown", (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      inspect(
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? series.length - 1
            : index + (event.key === "ArrowRight" ? 1 : -1),
      );
    }
  });
  text("chart-detail", "Select a point on the chart to inspect a reading.");
  const previousIndex = series.findIndex(
    (sample) => sample.time === previousTime,
  );
  if (previousIndex >= 0) inspect(previousIndex);
  if (hadFocus) hit.focus({ preventScroll: true });
}
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  busy(event.currentTarget, true);
  message("login-error", "");
  try {
    await api("/api/login", { password: $("password").value });
    $("password").value = "";
    await startDashboard();
  } catch (error) {
    message("login-error", error.message, true);
  } finally {
    busy($("login-form"), false);
  }
});
$("logout").addEventListener("click", async () => {
  try {
    await api("/api/logout", {});
    showLogin();
    $("password").focus();
  } catch (error) {
    text("page-error", error.message);
    $("page-error").hidden = false;
  }
});
$("connection-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  busy(event.currentTarget, true);
  message("connection-message", "Connecting…");
  const body = {};
  if ($("api-key").value.trim()) body.api_key = $("api-key").value.trim();
  if ($("device").value) body.sn = $("device").value;
  try {
    const result = await api("/api/connection", body);
    $("api-key").value = "";
    await loadSettings();
    message(
      "connection-message",
      result.connected
        ? "Connected. Readings are collected every five minutes."
        : "API key saved. Select an inverter above, then connect.",
    );
    await refresh();
  } catch (error) {
    message("connection-message", error.message, true);
  } finally {
    busy($("connection-form"), false);
  }
});
$("tariff-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  busy(event.currentTarget, true);
  message("tariff-message", "");
  const body = Object.fromEntries(new FormData(event.currentTarget));
  body.timezone = zone;
  ["peak_rate", "offpeak_rate", "export_rate", "standing_charge"].forEach(
    (key) => (body[key] = Number(body[key])),
  );
  if (body.offpeak_start === body.offpeak_end) {
    message(
      "tariff-message",
      "Choose different start and end times. For a flat tariff, use equal peak and off-peak rates.",
      true,
    );
    busy(event.currentTarget, false);
    return;
  }
  try {
    const editing = state.editing;
    await api(
      editing ? `/api/tariffs/${editing}` : "/api/tariffs",
      body,
      editing ? "PUT" : "POST",
    );
    await loadSettings(body.effective_from);
    message(
      "tariff-message",
      editing
        ? "Corrections saved. Cost estimates have been recalculated."
        : "Tariff saved.",
    );
    await refresh();
  } catch (error) {
    message("tariff-message", error.message, true);
  } finally {
    busy($("tariff-form"), false);
  }
});
$("new-tariff").addEventListener("click", () => {
  setTariffEditor(
    activeTariff() || state.settings?.tariffs?.at(-1) || null,
    true,
  );
  $("tariff-form").elements.effective_from.focus();
});
$("cancel-tariff-edit").addEventListener("click", () =>
  setTariffEditor(activeTariff() || null),
);
$("tariff-form").addEventListener("input", schedulePreview);
document.querySelectorAll("[data-period]").forEach((button) =>
  button.addEventListener("click", () => {
    message("range-error", "");
    $("custom-dates").open = false;
    setPeriod(button.dataset.period);
  }),
);
$("show-today").addEventListener("click", () => setPeriod("today"));
document.querySelectorAll("[data-series]").forEach((input) =>
  input.addEventListener("change", () => {
    if (state.data) renderChart(state.data);
  }),
);
$("range-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const start = $("range-start").value,
    end = $("range-end").value,
    days = (new Date(end) - new Date(start)) / 86400000;
  if (!start || !end || days < 0 || days > 30 || end > localDate()) {
    message(
      "range-error",
      "Choose up to 31 days, ending today or earlier.",
      true,
    );
    return;
  }
  message("range-error", "");
  state.start = start;
  state.end = end;
  state.period = "custom";
  updatePeriodButtons();
  $("custom-dates").open = false;
  refresh();
});
(async () => {
  const today = localDate();
  $("range-start").max = today;
  $("range-end").max = today;
  try {
    const session = await api("/api/session");
    if (!session.authenticated) {
      showLogin();
      return;
    }
    await startDashboard();
  } catch (error) {
    showLogin();
    message(
      "login-error",
      `${error.message} Reload to retry checking your sign-in.`,
      true,
    );
  }
})();
setInterval(() => {
  if (!document.hidden) {
    if (state.period === "today" && state.end !== localDate())
      setPeriod("today");
    else refresh();
  }
}, 60000);
