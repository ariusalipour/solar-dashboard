"use strict";
const $ = (id) => document.getElementById(id);
const state = {
  settings: null,
  start: "",
  end: "",
  loading: false,
  request: 0,
};
const zone = "Europe/London";
const money = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: "GBP",
      }).format(value)
    : "—";
const energy = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? `${value.toFixed(2)} kWh`
    : "—";
const power = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? `${value.toFixed(2)} kW`
    : "—";
const set = (id, value) => {
  $(id).textContent = value;
};
function localDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
function shiftDate(value, days) {
  const d = new Date(`${value}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function dateTime(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "Unknown time"
    : new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(d);
}
async function api(url, body) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers:
      body === undefined
        ? {}
        : { "Content-Type": "application/json", "X-Solar-Request": "1" },
    ...(body === undefined
      ? {}
      : { method: "POST", body: JSON.stringify(body) }),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      "The server could not complete this request. Please try again.",
    );
  }
  if (!response.ok) {
    if (response.status === 401 && url !== "/api/login") showLogin();
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : "Please check your entries and try again.",
    );
  }
  return data;
}
function showLogin() {
  $("login-view").hidden = false;
  $("dashboard-view").hidden = true;
  if ($("settings-dialog").open) $("settings-dialog").close();
}
function showDashboard() {
  $("login-view").hidden = true;
  $("dashboard-view").hidden = false;
}
function formMessage(id, message, error = false) {
  set(id, message);
  $(id).classList.toggle("error", error);
}
function busy(form, active) {
  form
    .querySelectorAll('button[type="submit"]')
    .forEach((b) => (b.disabled = active));
}
function openSettings() {
  $("settings-dialog").showModal();
}
function choosePeriod(period) {
  const today = localDate();
  state.end = period === "yesterday" ? shiftDate(today, -1) : today;
  state.start =
    period === "week"
      ? shiftDate(today, -6)
      : period === "month"
        ? shiftDate(today, -29)
        : state.end;
  $("range-start").value = state.start;
  $("range-end").value = state.end;
  document.querySelectorAll("[data-period]").forEach((b) => {
    const active = b.dataset.period === period;
    b.classList.toggle("active", active);
    b.setAttribute("aria-pressed", String(active));
  });
  refresh();
}
async function loadSettings() {
  state.settings = await api("/api/settings");
  const s = state.settings;
  set(
    "key-state",
    s.has_key
      ? "API key saved securely. Leave blank to keep the saved key."
      : "No key saved.",
  );
  $("api-key").placeholder = s.has_key
    ? "Saved key · enter only to replace"
    : "Paste your API key";
  const select = $("device");
  select.replaceChildren();
  let option = document.createElement("option");
  option.value = "";
  option.textContent = s.devices?.length
    ? "Select an inverter"
    : "Discover devices using API key";
  select.append(option);
  (s.devices || []).forEach((d, i) => {
    const o = document.createElement("option");
    o.value = d.sn;
    o.textContent = d.name || `Inverter ${i + 1}`;
    select.append(o);
  });
  select.value = s.selected_sn || "";
  renderTariffs(s.tariffs || []);
}
function renderTariffs(tariffs) {
  const host = $("tariff-history");
  host.replaceChildren();
  if (!tariffs.length) {
    host.textContent = "No tariffs saved yet.";
    return;
  }
  [...tariffs]
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from))
    .forEach((t) => {
      const row = document.createElement("div");
      row.className = "tariff-entry";
      const title = document.createElement("strong");
      title.textContent = `From ${t.effective_from}`;
      const details = document.createElement("span");
      details.textContent = `Peak ${t.peak_rate}p · Off-peak ${t.offpeak_rate}p (${t.offpeak_start}–${t.offpeak_end}) · Export ${t.export_rate}p · Standing ${t.standing_charge}p/day · ${t.timezone}`;
      row.append(title, details);
      host.append(row);
    });
}
async function refresh() {
  if ($("dashboard-view").hidden) return;
  const request = ++state.request;
  try {
    const data = await api(
      `/api/dashboard?start=${encodeURIComponent(state.start)}&end=${encodeURIComponent(state.end)}`,
    );
    if (request !== state.request) return;
    render(data);
    $("page-error").hidden = true;
  } catch (error) {
    if (request !== state.request) return;
    set("page-error", error.message);
    $("page-error").hidden = false;
  }
}
function render(data) {
  const c = { ...(data.costs || {}) },
    latest = data.latest,
    values = latest?.values || {};
  if ((data.series || []).length < 2) {
    [
      "import_kwh",
      "export_kwh",
      "peak_kwh",
      "offpeak_kwh",
      "peak_cost",
      "offpeak_cost",
      "import_cost",
      "export_credit",
      "net_cost",
    ].forEach((key) => (c[key] = null));
  }
  const hasReading = Boolean(latest);
  $("status-dot").classList.toggle("fresh", hasReading && !data.stale);
  set(
    "reading-status",
    hasReading
      ? data.stale
        ? "Last reading · delayed"
        : "Latest reading · up to date"
      : "Waiting for a reading",
  );
  set(
    "reading-time",
    hasReading
      ? `${dateTime(latest.time)} · ${zone}`
      : data.connected
        ? "Your inverter is connected. Waiting for collection."
        : "Connect your inverter to get started",
  );
  set("flow-state", data.stale ? "AWAITING FRESH DATA" : "LATEST READING");
  set("pv-value", power(values.pvPower));
  set("home-value", power(values.loadsPower));
  set(
    "grid-value",
    `${power(values.gridConsumptionPower)} / ${power(values.feedinPower)}`,
  );
  set(
    "battery-value",
    typeof values.SoC === "number" ? `${values.SoC.toFixed(0)}%` : "—",
  );
  set(
    "battery-detail",
    typeof values.batChargePower === "number" ||
      typeof values.batDischargePower === "number"
      ? `In ${power(values.batChargePower)} · Out ${power(values.batDischargePower)}`
      : "No battery reading available",
  );
  set(
    "flow-note",
    hasReading
      ? `${data.stale ? "Last recorded" : "Latest"} power · Grid values show import / export · ${dateTime(latest.time)}`
      : "Power readings will appear after your inverter is connected.",
  );
  ["net-cost", "net-cost-table"].forEach((id) => set(id, money(c.net_cost)));
  set("import-total", energy(c.import_kwh));
  set("export-total", energy(c.export_kwh));
  set("peak-energy", energy(c.peak_kwh));
  set("offpeak-energy", energy(c.offpeak_kwh));
  set("peak-cost", money(c.peak_cost));
  set("offpeak-cost", money(c.offpeak_cost));
  set("export-energy", energy(c.export_kwh));
  set(
    "export-credit",
    c.export_credit == null ? "—" : `−${money(c.export_credit)}`,
  );
  set("standing-cost", money(c.standing_charge));
  const days =
    Math.round(
      (new Date(data.end + "T12:00:00Z") -
        new Date(data.start + "T12:00:00Z")) /
        86400000,
    ) + 1;
  set("standing-days", `${days} ${days === 1 ? "day" : "days"}`);
  const count = (data.series || []).length,
    coverage = data.coverage?.percent || 0;
  set(
    "coverage-text",
    count < 2
      ? "Accumulating readings. Energy estimates need two samples, around five minutes apart."
      : `${coverage.toFixed(1)}% of elapsed time covered. Missing intervals are excluded from energy estimates.`,
  );
  const unpriced = c.unpriced_import_kwh || 0;
  set(
    "tariff-note",
    !data.tariff_configured
      ? "Add your tariff in Settings to calculate costs."
      : c.net_cost == null
        ? `Some dates have no applicable tariff${unpriced ? ` (${energy(unpriced)} of unpriced import)` : ""}. Add a tariff effective on or before your reporting dates. Costs remain unavailable until covered.`
        : "Estimated from measured intervals, assuming uniform energy flow within each interval. Includes full daily standing charges.",
  );
  set("range-caption", `${data.start} — ${data.end} · ${data.timezone}`);
  $("setup-notice").hidden = data.connected && data.tariff_configured;
  set(
    "collector-status",
    data.collector?.error
      ? `Collection issue: ${data.collector.error}`
      : `FoxESS Cloud · ${data.calls_today || 0} API calls in the past 24h · five-minute collection`,
  );
  renderChart(data);
}
function svgElement(name, attrs = {}, content) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
  if (content !== undefined) el.textContent = content;
  return el;
}
function renderChart(data) {
  const svg = $("energy-chart");
  svg.replaceChildren(
    svgElement(
      "title",
      { id: "chart-title" },
      "Energy readings over the selected period",
    ),
    svgElement(
      "desc",
      { id: "chart-desc" },
      `${data.series?.length || 0} readings. Solar generation, home consumption, grid import and export in kilowatts. Missing intervals are shown as gaps.`,
    ),
  );
  const series = (data.series || []).filter((s) =>
    Number.isFinite(Date.parse(s.time)),
  );
  const fields = [
    ["pvPower", "solar-line"],
    ["loadsPower", "home-line"],
    ["gridConsumptionPower", "grid-line"],
    ["feedinPower", "export-line"],
  ];
  const usable = series.filter((s) =>
    fields.some(([f]) => typeof s.values?.[f] === "number"),
  );
  $("chart-empty").hidden = usable.length >= 2;
  if (usable.length < 2) return;
  const left = 43,
    right = 1080,
    top = 15,
    bottom = 228;
  const plotTimes = series
    .flatMap((s) =>
      fields.map(([field]) => Date.parse(s.times?.[field] || s.time)),
    )
    .filter(Number.isFinite);
  const minimum = Math.min(...plotTimes),
    maximum = Math.max(...plotTimes);
  const max = Math.max(
    0.5,
    ...series.flatMap((s) =>
      fields.map(([f]) => (Number.isFinite(s.values?.[f]) ? s.values[f] : 0)),
    ),
  );
  const limit = Math.ceil(max * 2) / 2;
  const x = (t) =>
    left + ((t - minimum) / Math.max(1, maximum - minimum)) * (right - left);
  const y = (v) => bottom - (v / limit) * (bottom - top);
  for (let i = 0; i <= 4; i++) {
    const value = (limit * i) / 4,
      yy = y(value);
    svg.append(
      svgElement("line", {
        x1: left,
        y1: yy,
        x2: right,
        y2: yy,
        class: "chart-grid",
      }),
      svgElement(
        "text",
        { x: left - 9, y: yy + 3, "text-anchor": "end" },
        value.toFixed(1),
      ),
    );
  }
  for (let i = 0; i <= 4; i++) {
    const time = minimum + ((maximum - minimum) * i) / 4;
    const label = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      ...(data.start === data.end
        ? { hour: "2-digit", minute: "2-digit" }
        : { day: "numeric", month: "short", hour: "2-digit" }),
    }).format(new Date(time));
    svg.append(
      svgElement(
        "text",
        {
          x: x(time),
          y: 252,
          "text-anchor": i === 0 ? "start" : i === 4 ? "end" : "middle",
        },
        label,
      ),
    );
  }
  fields.forEach(([field, css]) => {
    let d = "",
      last = null;
    series.forEach((s) => {
      const value = s.values?.[field],
        time = Date.parse(s.times?.[field] || s.time);
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        !Number.isFinite(time)
      ) {
        last = null;
        return;
      }
      const move = last === null || time - last > 900000 || time <= last;
      d += `${move ? "M" : "L"}${x(time).toFixed(2)},${y(value).toFixed(2)} `;
      last = time;
    });
    if (d) svg.append(svgElement("path", { d, class: `plot-line ${css}` }));
  });
}
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  busy(event.currentTarget, true);
  formMessage("login-error", "");
  try {
    await api("/api/login", { password: $("password").value });
    $("password").value = "";
    showDashboard();
    await loadSettings();
    choosePeriod("today");
  } catch (error) {
    formMessage("login-error", error.message, true);
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
    set("page-error", error.message);
    $("page-error").hidden = false;
  }
});
$("settings-open").addEventListener("click", openSettings);
$("setup-open").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", () =>
  $("settings-dialog").close(),
);
$("connection-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  busy(event.currentTarget, true);
  formMessage("connection-message", "Checking your connection…");
  const body = {};
  if ($("api-key").value.trim()) body.api_key = $("api-key").value.trim();
  if ($("device").value) body.sn = $("device").value;
  try {
    const result = await api("/api/connection", body);
    $("api-key").value = "";
    await loadSettings();
    formMessage(
      "connection-message",
      result.connected
        ? "Connected. Your first reading is ready."
        : "Devices found. Choose your inverter above and save again.",
    );
    await refresh();
  } catch (error) {
    formMessage("connection-message", error.message, true);
  } finally {
    busy($("connection-form"), false);
  }
});
$("tariff-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  busy(event.currentTarget, true);
  formMessage("tariff-message", "");
  const body = Object.fromEntries(new FormData(event.currentTarget));
  ["peak_rate", "offpeak_rate", "export_rate", "standing_charge"].forEach(
    (k) => (body[k] = Number(body[k])),
  );
  try {
    await api("/api/tariffs", body);
    await loadSettings();
    formMessage(
      "tariff-message",
      "Tariff saved. Your costs have been updated.",
    );
    await refresh();
  } catch (error) {
    formMessage("tariff-message", error.message, true);
  } finally {
    busy($("tariff-form"), false);
  }
});
document.querySelectorAll("[data-period]").forEach((button) =>
  button.addEventListener("click", () => {
    set("range-error", "");
    choosePeriod(button.dataset.period);
  }),
);
$("range-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const start = $("range-start").value,
    end = $("range-end").value;
  const days = (new Date(end) - new Date(start)) / 86400000;
  if (days < 0 || days > 30 || end > localDate()) {
    set("range-error", "Choose up to 31 days, ending today or earlier.");
    return;
  }
  set("range-error", "");
  state.start = start;
  state.end = end;
  document.querySelectorAll("[data-period]").forEach((b) => {
    b.classList.remove("active");
    b.setAttribute("aria-pressed", "false");
  });
  refresh();
});
(async () => {
  const today = localDate();
  $("range-start").max = today;
  $("range-end").max = today;
  $("tariff-form").elements.effective_from.value = today;
  try {
    const session = await api("/api/session");
    if (!session.authenticated) {
      showLogin();
      return;
    }
    showDashboard();
    await loadSettings();
    choosePeriod("today");
  } catch (error) {
    showLogin();
    formMessage("login-error", error.message, true);
  }
})();
setInterval(() => {
  if (!document.hidden) refresh();
}, 60000);
