import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import { SideNav, SideNavItem } from "@astryxdesign/core/SideNav";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Banner } from "@astryxdesign/core/Banner";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Selector } from "@astryxdesign/core/Selector";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { DateRangeInput } from "@astryxdesign/core/DateRangeInput";
import { api } from "./api.js";
import {
  dateLabel,
  finite,
  kw,
  kwh,
  localDate,
  pounds,
  shiftDate,
  stamp,
} from "./format.js";
import PowerChart from "./PowerChart.jsx";

const TariffPage = lazy(() =>
  import("./SettingsPages.jsx").then((module) => ({
    default: module.TariffPage,
  })),
);
const ConnectionPage = lazy(() =>
  import("./SettingsPages.jsx").then((module) => ({
    default: module.ConnectionPage,
  })),
);

const pages = {
  overview: ["Overview", "Solar power, grid usage and electricity costs."],
  tariff: [
    "Electricity tariff",
    "Manage the prices used to estimate your grid costs.",
  ],
  connection: [
    "Connection",
    "Manage your FoxESS Cloud connection and collection status.",
  ],
};
function readPage() {
  return Object.hasOwn(pages, location.hash.slice(1))
    ? location.hash.slice(1)
    : "overview";
}
function readTheme() {
  try {
    const value = localStorage.getItem("solar-theme");
    return ["light", "dark", "system"].includes(value) ? value : "system";
  } catch {
    return "system";
  }
}
function initialPeriod() {
  try {
    return JSON.parse(localStorage.getItem("solar-chart") || "{}")?.mode ===
      "compare"
      ? "week"
      : "today";
  } catch {
    return "today";
  }
}
function periodRange(period) {
  const today = localDate(),
    end = period === "yesterday" ? shiftDate(today, -1) : today;
  return {
    start:
      period === "week"
        ? shiftDate(today, -6)
        : period === "month"
          ? shiftDate(today, -29)
          : end,
    end,
  };
}
function rangeValid(range) {
  return (
    range?.start &&
    range?.end &&
    range.start <= range.end &&
    range.end <= localDate() &&
    (Date.parse(range.end) - Date.parse(range.start)) / 86400000 <= 30
  );
}
function ThemePicker({ value, onChange }) {
  return (
    <div className="solar-theme-picker">
      <Selector
        label="Theme"
        isLabelHidden
        size="sm"
        value={value}
        onChange={onChange}
        options={[
          { value: "system", label: "System theme" },
          { value: "light", label: "Light theme" },
          { value: "dark", label: "Dark theme" },
        ]}
      />
    </div>
  );
}
function SolarMark() {
  return (
    <svg className="solar-mark" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
    </svg>
  );
}

export default function App() {
  const [theme, setTheme] = useState(readTheme),
    [page, setPage] = useState(readPage),
    [status, setStatus] = useState("checking");
  const [authMode, setAuthMode] = useState("password"),
    [sessionError, setSessionError] = useState(""),
    [password, setPassword] = useState(""),
    [signingIn, setSigningIn] = useState(false),
    [signingOut, setSigningOut] = useState(false);
  const [settings, setSettings] = useState(null),
    [data, setData] = useState(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [settingsLoading, setSettingsLoading] = useState(false),
    [settingsError, setSettingsError] = useState("");
  const [period, setPeriod] = useState(initialPeriod),
    [range, setRange] = useState(() => periodRange(initialPeriod())),
    [dateError, setDateError] = useState(""),
    [tick, setTick] = useState(0);
  const alive = useRef(true),
    request = useRef(0),
    statusRef = useRef(status),
    authModeRef = useRef(authMode),
    generation = useRef(0),
    heading = useRef(null),
    rangeRef = useRef(range);
  statusRef.current = status;
  authModeRef.current = authMode;
  rangeRef.current = range;
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("solar-theme", theme);
    } catch {}
  }, [theme]);
  useEffect(() => {
    const change = () => {
      if (["#main", "#astryx-app-shell-main"].includes(location.hash)) return;
      setPage(readPage());
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    document.title = `Solar — ${pages[page][0]}`;
    if (status === "authenticated")
      heading.current?.focus({ preventScroll: true });
  }, [page]);
  useEffect(() => {
    const expired = () => {
      generation.current++;
      request.current++;
      setStatus(
        authModeRef.current === "cloudflare" ? "access-expired" : "login",
      );
      setSessionError("Your session has expired. Sign in again to continue.");
      setPassword("");
      setSettings(null);
      setData(null);
    };
    window.addEventListener("solar-session-expired", expired);
    return () => window.removeEventListener("solar-session-expired", expired);
  }, []);
  const checkSession = useCallback(async () => {
    setStatus("checking");
    setSessionError("");
    try {
      const session = await api("/api/session");
      if (!alive.current) return;
      setAuthMode(session.auth_mode || "password");
      setStatus(
        session.authenticated
          ? "authenticated"
          : session.auth_mode === "cloudflare"
            ? "access-expired"
            : "login",
      );
    } catch (e) {
      if (!alive.current) return;
      setSessionError(e.message);
      setStatus("session-error");
    }
  }, []);
  useEffect(() => {
    checkSession();
  }, [checkSession]);
  const loadSettings = useCallback(async () => {
    const current = generation.current;
    setSettingsLoading(true);
    try {
      const result = await api("/api/settings");
      if (alive.current && current === generation.current) {
        setSettings(result);
        setSettingsError("");
      }
      return result;
    } catch (e) {
      if (e.status !== 401 && alive.current) setSettingsError(e.message);
      throw e;
    } finally {
      if (alive.current && current === generation.current)
        setSettingsLoading(false);
    }
  }, []);
  const loadData = useCallback(async () => {
    if (statusRef.current !== "authenticated") return;
    const id = ++request.current,
      current = generation.current;
    setLoading(true);
    try {
      const result = await api(
        `/api/dashboard?start=${range.start}&end=${range.end}`,
      );
      if (
        alive.current &&
        id === request.current &&
        current === generation.current
      ) {
        setData(result);
        setError("");
      }
    } catch (e) {
      if (e.status !== 401 && alive.current && id === request.current)
        setError(e.message);
    } finally {
      if (alive.current && id === request.current) setLoading(false);
    }
  }, [range.start, range.end]);
  useEffect(() => {
    if (status === "authenticated") {
      loadSettings().catch(() => {});
    }
  }, [status, loadSettings]);
  useEffect(() => {
    if (status === "authenticated") loadData();
  }, [status, loadData, tick]);
  useEffect(() => {
    if (status !== "authenticated") return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      const next = period === "custom" ? rangeRef.current : periodRange(period);
      if (
        next.start !== rangeRef.current.start ||
        next.end !== rangeRef.current.end
      )
        setRange(next);
      else setTick((t) => t + 1);
    }, 60000);
    return () => clearInterval(timer);
  }, [status, period]);
  const settingsChanged = useCallback(async () => {
    await loadSettings();
    await loadData();
  }, [loadSettings, loadData]);
  function choosePeriod(next) {
    setPeriod(next);
    setRange(periodRange(next));
    setDateError("");
  }
  function chooseDates(next) {
    if (!next) return;
    if (!rangeValid(next)) {
      setDateError("Choose up to 31 days, ending today or earlier.");
      return;
    }
    setPeriod("custom");
    setRange(next);
    setDateError("");
  }
  async function signIn(event) {
    event.preventDefault();
    setSigningIn(true);
    setSessionError("");
    try {
      await api("/api/login", { password });
      setPassword("");
      setStatus("authenticated");
    } catch (e) {
      setSessionError(e.message);
    } finally {
      setSigningIn(false);
    }
  }
  async function signOut() {
    setSigningOut(true);
    setError("");
    try {
      await api("/api/logout", {});
      generation.current++;
      request.current++;
      setData(null);
      setSettings(null);
      if (authMode === "cloudflare") {
        location.assign("/cdn-cgi/access/logout");
        return;
      }
      setStatus("login");
      setSessionError("");
    } catch (e) {
      if (e.status !== 401) setError(e.message);
    } finally {
      setSigningOut(false);
    }
  }
  async function retry() {
    setError("");
    if (!settings || settingsError) await loadSettings().catch(() => {});
    await loadData();
  }
  const report =
    data?.start === range.start && data?.end === range.end ? data : null;
  const currentTariff = [...(settings?.tariffs || [])]
    .reverse()
    .find((t) => t.effective_from <= localDate());
  const title = pages[page];
  let content;
  if (status !== "authenticated")
    content = (
      <div className="solar-auth">
        <Card className="solar-auth-card" padding={6}>
          <div className="solar-auth-theme">
            <ThemePicker value={theme} onChange={setTheme} />
          </div>
          <div className="solar-brand">
            <SolarMark />
            <span>Solar</span>
          </div>
          {status === "checking" ? (
            <div role="status" className="solar-stack">
              <h1>Checking your access</h1>
              <p className="solar-muted">
                Connecting to your private dashboard…
              </p>
            </div>
          ) : status === "session-error" ? (
            <div className="solar-stack">
              <h1>Unable to connect</h1>
              <Banner
                status="error"
                title="Could not check your session"
                description={sessionError}
              />
              <Button label="Retry" variant="primary" onClick={checkSession} />
            </div>
          ) : status === "access-expired" ? (
            <div className="solar-stack">
              <h1>Sign in to your dashboard</h1>
              <p className="solar-muted">
                {sessionError ||
                  "Your Cloudflare Access session needs to be checked."}
              </p>
              <Button
                label="Continue with Cloudflare Access"
                variant="primary"
                onClick={() => location.assign("/")}
              />
            </div>
          ) : (
            <form className="solar-stack" onSubmit={signIn}>
              <div>
                <h1>Sign in</h1>
                <p className="solar-muted">
                  Enter your household password to view your energy data.
                </p>
              </div>
              <TextInput
                label="Household password"
                type="password"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
                isRequired
                required
                name="password"
                autoFocus
              />
              {sessionError && (
                <div role="alert">
                  <Banner status="error" title={sessionError} />
                </div>
              )}
              <Button
                label="Sign in"
                type="submit"
                variant="primary"
                width="100%"
                isLoading={signingIn}
              />
            </form>
          )}
        </Card>
      </div>
    );
  else
    content = (
      <AppShell
        height="auto"
        variant="section"
        contentPadding={0}
        className="solar-shell"
        topNav={
          <TopNav
            label="Household navigation"
            heading={
              <TopNavHeading
                heading="Solar"
                headingHref="#overview"
                logo={<SolarMark />}
              />
            }
            endContent={
              <div className="solar-top-actions">
                <ThemePicker value={theme} onChange={setTheme} />
                <Button
                  label="Sign out"
                  variant="ghost"
                  size="sm"
                  isLoading={signingOut}
                  onClick={signOut}
                />
              </div>
            }
          />
        }
        sideNav={
          <SideNav
            aria-label="Dashboard pages"
            footer={
              <div className="solar-nav-footer">
                <span>Private household dashboard</span>
                <span>Europe/London · GBP</span>
              </div>
            }
          >
            <SideNavItem
              label="Overview"
              href="#overview"
              isSelected={page === "overview"}
            />
            <SideNavItem
              label="Electricity tariff"
              href="#tariff"
              isSelected={page === "tariff"}
            />
            <SideNavItem
              label="Connection"
              href="#connection"
              isSelected={page === "connection"}
            />
          </SideNav>
        }
      >
        <div className="solar-app-content">
          <header className="solar-page-header">
            <div>
              <h1 ref={heading} tabIndex={-1}>
                {title[0]}
              </h1>
              <p className="solar-muted">{title[1]}</p>
            </div>
            <span
              className={`solar-connection-status ${data?.connected && !data?.stale ? "is-connected" : ""}`}
            >
              <span aria-hidden="true" />
              {!data
                ? "Loading connection…"
                : !data.connected
                  ? "Not connected"
                  : !data.latest
                    ? "Waiting for readings"
                    : data.stale
                      ? "Readings delayed"
                      : "Connected"}
            </span>
          </header>
          {(error || settingsError) && (
            <div className="solar-app-error" role="alert">
              <Banner
                status="error"
                title="Unable to update dashboard"
                description={settingsError || error}
                endContent={
                  <Button
                    label="Retry"
                    size="sm"
                    onClick={retry}
                    isLoading={loading || settingsLoading}
                  />
                }
              />
            </div>
          )}
          {page === "tariff" ? (
            settings ? (
              <Suspense
                fallback={<Loading message="Loading tariff settings…" />}
              >
                <TariffPage
                  settings={settings}
                  onSettingsChange={settingsChanged}
                  api={api}
                />
              </Suspense>
            ) : (
              <Loading message="Loading tariff settings…" />
            )
          ) : page === "connection" ? (
            settings ? (
              <Suspense
                fallback={<Loading message="Loading connection settings…" />}
              >
                <ConnectionPage
                  settings={settings}
                  data={data}
                  onSettingsChange={settingsChanged}
                  api={api}
                />
              </Suspense>
            ) : (
              <Loading message="Loading connection settings…" />
            )
          ) : !data ? (
            <Loading message="Loading energy data…" />
          ) : !data.connected ? (
            <Setup currentTariff={currentTariff} />
          ) : (
            <>
              <section
                className="solar-current"
                aria-labelledby="current-heading"
              >
                <div className="solar-section-title">
                  <h2 id="current-heading">Current power</h2>
                  <span className="solar-muted">
                    {data.latest
                      ? `${data.stale ? "Last reading" : "Updated"} ${stamp(data.latest.time)}`
                      : "Waiting for the first reading"}
                  </span>
                </div>
                <div className="solar-metrics">
                  <Metric
                    label="Solar"
                    value={kw(data.latest?.values?.pvPower)}
                    detail="Generation"
                    color="solar"
                  />
                  <Metric
                    label="Home"
                    value={kw(data.latest?.values?.loadsPower)}
                    detail="Consumption"
                    color="home"
                  />
                  <Card padding={4} className="solar-metric">
                    <h3>Grid</h3>
                    <div className="solar-grid-pair">
                      <span>
                        Import{" "}
                        <strong>
                          {kw(data.latest?.values?.gridConsumptionPower)}
                        </strong>
                      </span>
                      <span>
                        Export{" "}
                        <strong>{kw(data.latest?.values?.feedinPower)}</strong>
                      </span>
                    </div>
                    <p className="solar-muted">Current power</p>
                  </Card>
                  <Metric
                    label="Battery"
                    value={
                      finite(data.latest?.values?.SoC)
                        ? `${Math.round(data.latest.values.SoC)}%`
                        : "—"
                    }
                    detail={batteryDetail(data.latest?.values || {})}
                    color="battery"
                  />
                </div>
              </section>
              {(data.collector?.error || (data.stale && data.latest)) && (
                <div className="solar-collector-warning">
                  <Banner
                    status="warning"
                    title="Readings delayed"
                    description={
                      data.collector?.error ||
                      "The last reading is more than 15 minutes old. Collection will retry automatically."
                    }
                  />
                </div>
              )}
              <section
                className="solar-report"
                aria-labelledby="report-heading"
              >
                <div className="solar-report-toolbar">
                  <div>
                    <h2 id="report-heading">Usage &amp; costs</h2>
                    <p className="solar-muted">
                      {range.start === range.end
                        ? dateLabel(range.start, true)
                        : `${dateLabel(range.start)} – ${dateLabel(range.end, true)}`}
                    </p>
                  </div>
                  <div className="solar-range-controls">
                    <SegmentedControl
                      label="Reporting period"
                      value={period}
                      onChange={choosePeriod}
                      size="sm"
                    >
                      <SegmentedControlItem value="today" label="Today" />
                      <SegmentedControlItem
                        value="yesterday"
                        label="Yesterday"
                      />
                      <SegmentedControlItem value="week" label="7 days" />
                      <SegmentedControlItem value="month" label="30 days" />
                    </SegmentedControl>
                    <div className="solar-range-input">
                      <DateRangeInput
                        label="Custom date range"
                        isLabelHidden
                        value={range}
                        onChange={chooseDates}
                        max={localDate()}
                        maxRangeSpan={31}
                        hasClear={false}
                        numberOfMonths={1}
                        weekStartsOn="mon"
                        size="sm"
                        status={
                          dateError
                            ? { type: "error", message: dateError }
                            : undefined
                        }
                      />
                    </div>
                  </div>
                </div>
                {!report ? (
                  <Loading message="Loading selected dates…" />
                ) : (
                  <div className="solar-report-grid" aria-busy={loading}>
                    <div className="solar-chart-column">
                      <PowerChart
                        data={report}
                        onCompareRequest={() => choosePeriod("week")}
                      />
                      <Coverage data={report} />
                    </div>
                    <CostSummary data={report} />
                  </div>
                )}
              </section>
            </>
          )}
          <footer className="solar-footer">
            <span>FoxESS Cloud</span>
            <span>Europe/London · GBP</span>
          </footer>
        </div>
      </AppShell>
    );
  return (
    <Theme theme={neutralTheme} mode={theme}>
      {content}
    </Theme>
  );
}
function Loading({ message }) {
  return (
    <div className="solar-loading" role="status">
      {message}
    </div>
  );
}
function Metric({ label, value, detail, color }) {
  return (
    <Card padding={4} className={`solar-metric solar-metric-${color}`}>
      <h3>
        <span className="solar-metric-dot" aria-hidden="true" />
        {label}
      </h3>
      <div className="solar-metric-value">{value}</div>
      <p className="solar-muted">{detail}</p>
    </Card>
  );
}
function batteryDetail(values) {
  return finite(values.batChargePower) && values.batChargePower > 0
    ? `Charging · ${kw(values.batChargePower)}`
    : finite(values.batDischargePower) && values.batDischargePower > 0
      ? `Discharging · ${kw(values.batDischargePower)}`
      : finite(values.SoC)
        ? "Charge level"
        : "Not reported by inverter";
}
function Setup({ currentTariff }) {
  return (
    <section className="solar-setup" aria-labelledby="setup-heading">
      <div className="solar-setup-intro">
        <SolarMark />
        <h2 id="setup-heading">Connect your solar system</h2>
        <p className="solar-muted">
          Connect FoxESS Cloud to collect readings, then add your electricity
          tariff to estimate grid costs.
        </p>
      </div>
      <div className="solar-setup-step">
        <span className="solar-step-number">1</span>
        <div>
          <h3>Connect FoxESS Cloud</h3>
          <p className="solar-muted">
            Use an API key from your FoxESS account.
          </p>
        </div>
        <Button href="#connection" label="Connect" variant="primary" />
      </div>
      <div className="solar-setup-step">
        <span className="solar-step-number">{currentTariff ? "✓" : "2"}</span>
        <div>
          <h3>Set your electricity tariff</h3>
          <p className="solar-muted">
            {currentTariff
              ? `Peak ${currentTariff.peak_rate}p · Off-peak ${currentTariff.offpeak_rate}p`
              : "Peak and off-peak rates, hours and export payments."}
          </p>
        </div>
        <Button
          href="#tariff"
          label={currentTariff ? "Edit tariff" : "Add tariff"}
        />
      </div>
      <p className="solar-setup-note">
        Historical readings start when you connect. Your API key stays on your
        server.
      </p>
    </section>
  );
}
function CostSummary({ data }) {
  const c = data.costs || {},
    valid = data.has_energy_intervals,
    days =
      Math.round((Date.parse(data.end) - Date.parse(data.start)) / 86400000) +
      1;
  const status = !valid
    ? "Waiting for valid grid meter readings."
    : !data.tariff_configured
      ? "Add your electricity tariff to calculate costs."
      : c.net_cost === null
        ? "No tariff covers part of this period. Add the missing rates."
        : data.coverage?.percent < 99
          ? "Partial estimate · gaps in readings are excluded."
          : "Import + standing charge − export credit.";
  return (
    <Card padding={5} className="solar-cost">
      <div className="solar-cost-heading">
        <h3>Estimated grid cost</h3>
        <span>GBP</span>
      </div>
      <div className="solar-cost-total">
        {pounds(valid ? c.net_cost : null)}
      </div>
      <p className="solar-muted solar-cost-status">{status}</p>
      <dl className="solar-cost-breakdown">
        <CostRow
          title="Peak import"
          detail={kwh(valid && finite(c.peak_cost) ? c.peak_kwh : null)}
          value={pounds(valid ? c.peak_cost : null)}
        />
        <CostRow
          title="Off-peak import"
          detail={kwh(valid && finite(c.offpeak_cost) ? c.offpeak_kwh : null)}
          value={pounds(valid ? c.offpeak_cost : null)}
        />
        <CostRow
          title="Export credit"
          detail={kwh(valid ? c.export_kwh : null)}
          value={
            valid && finite(c.export_credit)
              ? `−${pounds(c.export_credit)}`
              : "—"
          }
        />
        <CostRow
          title="Standing charge"
          detail={`${days} ${days === 1 ? "day" : "days"}`}
          value={pounds(c.standing_charge)}
        />
      </dl>
      <div className="solar-cost-energy">
        <div>
          <span>Grid import</span>
          <strong>{kwh(valid ? c.import_kwh : null)}</strong>
        </div>
        <div>
          <span>Grid export</span>
          <strong>{kwh(valid ? c.export_kwh : null)}</strong>
        </div>
      </div>
      <a href="#tariff" className="solar-text-link">
        {data.tariff_configured
          ? "View electricity tariff"
          : "Set electricity tariff"}{" "}
        <span aria-hidden="true">→</span>
      </a>
    </Card>
  );
}
function CostRow({ title, detail, value }) {
  return (
    <div>
      <dt>
        {title}
        <span>{detail}</span>
      </dt>
      <dd>{value}</dd>
    </div>
  );
}
function Coverage({ data }) {
  return (
    <div className="solar-coverage">
      <span>
        {data.has_energy_intervals
          ? `${data.coverage.percent.toFixed(1)}% of elapsed time covered · ${data.interval_count} measured intervals`
          : "No valid grid meter intervals in this period"}
      </span>
      <details>
        <summary>How estimates work</summary>
        <p>
          Energy comes from changes in your inverter’s grid meter counters.
          Missing or inconsistent intervals are excluded. Energy is split evenly
          within an interval when it crosses a tariff boundary. Standing charges
          apply to full selected calendar days.
        </p>
      </details>
    </div>
  );
}
