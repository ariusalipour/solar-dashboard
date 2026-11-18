import React, { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { DateInput } from "@astryxdesign/core/DateInput";
import { TimeInput } from "@astryxdesign/core/TimeInput";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Selector } from "@astryxdesign/core/Selector";
import { dateLabel, localDate, pence, stamp } from "./format.js";
import "./settings.css";

const rates = [
  ["peak_rate", "Peak import", "p/kWh"],
  ["offpeak_rate", "Off-peak import", "p/kWh"],
  ["standing_charge", "Standing charge", "p/day"],
  ["export_rate", "Export credit", "p/kWh"],
];
const emptyTariff = () => ({
  effective_from: localDate(),
  peak_rate: null,
  offpeak_rate: null,
  offpeak_start: "",
  offpeak_end: "",
  export_rate: null,
  standing_charge: null,
});
const clock = (value) =>
  /^\d{2}:\d{2}$/.test(value || "") &&
  value < "24:00" &&
  Number(value.slice(3)) < 60;
const minute = (value) =>
  Number(value.slice(0, 2)) * 60 + Number(value.slice(3));

function Notice({ notice }) {
  return (
    <div
      className="solar-settings-notice"
      aria-live="polite"
      aria-atomic="true"
    >
      {notice && (
        <Banner
          status={notice.error ? "error" : "success"}
          title={notice.text}
          role={notice.error ? "alert" : "status"}
        />
      )}
    </div>
  );
}

function Schedule({ tariff }) {
  if (
    !clock(tariff?.offpeak_start) ||
    !clock(tariff?.offpeak_end) ||
    tariff.offpeak_start === tariff.offpeak_end
  ) {
    return (
      <p className="solar-settings-muted">
        Set the off-peak hours to preview your daily schedule.
      </p>
    );
  }
  const start = minute(tariff.offpeak_start),
    end = minute(tariff.offpeak_end);
  const windows =
    start < end
      ? [[start, end]]
      : [
          [0, end],
          [start, 1440],
        ];
  return (
    <div className="solar-settings-schedule">
      <svg
        viewBox="0 0 600 30"
        role="img"
        aria-label={`Off-peak ${tariff.offpeak_start} to ${tariff.offpeak_end}, ${start > end ? "overnight, " : ""}Europe/London`}
      >
        <rect
          className="solar-settings-peak-bar"
          x="1"
          y="5"
          width="598"
          height="18"
          rx="4"
        />
        {windows.map(([a, b]) => (
          <rect
            key={a}
            className="solar-settings-offpeak-bar"
            x={1 + (a / 1440) * 598}
            y="5"
            width={((b - a) / 1440) * 598}
            height="18"
            rx="3"
          />
        ))}
      </svg>
      <div className="solar-settings-schedule-axis" aria-hidden="true">
        {[0, 6, 12, 18, 24].map((hour) => (
          <span key={hour}>{`${String(hour).padStart(2, "0")}:00`}</span>
        ))}
      </div>
      <div className="solar-settings-schedule-key">
        <span>
          <i className="solar-settings-offpeak-dot" />
          Off-peak {tariff.offpeak_start}–{tariff.offpeak_end}
          {start > end ? " · overnight" : ""}
        </span>
        <span>
          <i className="solar-settings-peak-dot" />
          Peak outside these hours
        </span>
      </div>
      <p className="solar-settings-muted">
        UK local time · follows the summer and winter clock changes.
      </p>
    </div>
  );
}

export function TariffPage({ settings, onSettingsChange, api }) {
  const tariffs = [...(settings?.tariffs || [])].sort((a, b) =>
    a.effective_from.localeCompare(b.effective_from),
  );
  const today = localDate();
  const active = [...tariffs]
    .reverse()
    .find((tariff) => tariff.effective_from <= today);
  const [form, setForm] = useState(emptyTariff);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [entryErrors, setEntryErrors] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const formElement = useRef(null);
  const heading = useRef(null);
  const trackEntryError = (field) => (error) =>
    setEntryErrors((previous) => ({ ...previous, [field]: !!error }));
  const update = (field, value) =>
    setForm((previous) => ({ ...previous, [field]: value }));
  const startNew = () => {
    setEditing(null);
    setForm(emptyTariff());
    setEntryErrors({});
    setSubmitted(false);
    setNotice(null);
  };
  const correct = (tariff) => {
    setEditing(tariff.effective_from);
    setForm({ ...tariff });
    setEntryErrors({});
    setSubmitted(false);
    setNotice(null);
    requestAnimationFrame(() => {
      heading.current?.focus();
      heading.current?.scrollIntoView({ block: "center" });
    });
  };
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setSubmitted(true);
    const failure = !form.effective_from
      ? "Choose an effective date."
      : rates.some(
            ([key]) =>
              form[key] == null ||
              !Number.isFinite(form[key]) ||
              form[key] < 0 ||
              form[key] > 1000000,
          )
        ? "Enter each rate in pence, including 0 where no charge or credit applies."
        : Object.values(entryErrors).some(Boolean)
          ? "Correct the highlighted fields before saving."
          : !clock(form.offpeak_start) || !clock(form.offpeak_end)
            ? "Choose both off-peak times."
            : form.offpeak_start === form.offpeak_end
              ? "Choose different start and end times. For a flat tariff, enter equal peak and off-peak rates."
              : !editing &&
                  tariffs.some(
                    (tariff) => tariff.effective_from === form.effective_from,
                  )
                ? "A tariff already starts on this date. Choose Correct on that tariff to fix a mistake."
                : null;
    if (failure) {
      setNotice({ error: true, text: failure });
      requestAnimationFrame(() => {
        formElement.current?.querySelector('[aria-invalid="true"]')?.focus();
      });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await api(
        editing ? `/api/tariffs/${editing}` : "/api/tariffs",
        { ...form, timezone: "Europe/London" },
        editing ? "PUT" : "POST",
      );
      const message = editing
        ? "Tariff corrected. Costs from this date have been recalculated."
        : "Tariff saved. Costs use these rates from its effective date.";
      setEditing(null);
      setForm(emptyTariff());
      setSubmitted(false);
      try {
        await onSettingsChange();
        setNotice({ text: message });
      } catch {
        setNotice({
          error: true,
          text: `${message} Refresh the page to see the latest values.`,
        });
      }
    } catch (error) {
      setNotice({
        error: true,
        text: error.message || "Could not save the tariff. Try again.",
      });
    } finally {
      setBusy(false);
    }
  }
  const fieldStatus = (field) => {
    if (!submitted) return undefined;
    let message;
    if (field === "effective_from") {
      if (!form[field]) message = "Choose an effective date.";
      else if (
        !editing &&
        tariffs.some((tariff) => tariff.effective_from === form[field])
      )
        message = "A tariff starts on this date. Correct it in Tariff history.";
    } else if (field.startsWith("offpeak_") && field !== "offpeak_rate") {
      if (!clock(form[field])) message = "Enter a time in 24-hour format.";
      else if (form.offpeak_start === form.offpeak_end)
        message = "Start and end must be different.";
    } else if (
      form[field] == null ||
      !Number.isFinite(form[field]) ||
      form[field] < 0 ||
      form[field] > 1000000
    ) {
      message = "Enter a rate in pence. Use 0 if none applies.";
    }
    return message ? { type: "error", message } : undefined;
  };
  return (
    <div className="solar-settings-page">
      <div className="solar-settings-layout">
        <div className="solar-settings-primary">
          <Card className="solar-settings-card">
            <div className="solar-settings-card-heading">
              <h2>Current tariff</h2>
              <Badge
                label={active ? "In effect" : "Not configured"}
                variant={active ? "success" : "warning"}
              />
            </div>
            {active ? (
              <>
                <p className="solar-settings-muted">
                  Effective {dateLabel(active.effective_from, true)}
                </p>
                <div className="solar-settings-rate-grid">
                  {rates.map(([key, label, unit]) => (
                    <div key={key}>
                      <span>{label}</span>
                      <strong>{pence(active[key], unit)}</strong>
                    </div>
                  ))}
                </div>
                <Schedule tariff={active} />
              </>
            ) : (
              <div className="solar-settings-empty">
                <h3>
                  {tariffs.length
                    ? "Your first tariff starts in the future"
                    : "Add your electricity rates"}
                </h3>
                <p>
                  Enter the rates from your supplier or bill. Costs stay
                  unavailable until a tariff covers the selected dates.
                </p>
              </div>
            )}
          </Card>
          <Card className="solar-settings-card">
            <div className="solar-settings-card-heading">
              <h2 ref={heading} tabIndex={-1}>
                {editing ? "Correct a saved tariff" : "Add a tariff change"}
              </h2>
              {editing && (
                <Button
                  label="Cancel correction"
                  variant="ghost"
                  isDisabled={busy}
                  onClick={startNew}
                />
              )}
            </div>
            <p className="solar-settings-muted">
              All prices are in pence. Enter 7.5 for 7.5p per kWh, or 0 where no
              charge or export credit applies.
            </p>
            {editing && (
              <Banner
                status="warning"
                title="Correcting this tariff recalculates costs from this date"
                description="Use a new effective date for a supplier price change. The previous values are retained in the correction history."
              />
            )}
            <form
              className="solar-settings-form"
              onSubmit={submit}
              ref={formElement}
              noValidate
              aria-busy={busy}
            >
              <DateInput
                label="Effective from"
                status={fieldStatus("effective_from")}
                onEntryErrorChange={trackEntryError("effective_from")}
                statusVariant="detached"
                value={form.effective_from || undefined}
                onChange={(value) => {
                  if (!editing) update("effective_from", value || "");
                }}
                isDisabled={busy || !!editing}
                isRequired
                presentation="native"
                description={
                  editing
                    ? "The effective date is locked for this correction."
                    : "Earlier dates keep their previous tariff."
                }
                width="100%"
              />
              <div className="solar-settings-input-grid">
                {rates.map(([key, label, unit]) => (
                  <NumberInput
                    key={key}
                    label={label}
                    status={fieldStatus(key)}
                    statusVariant="detached"
                    value={form[key]}
                    onChange={(value) => update(key, value)}
                    units={unit}
                    min={0}
                    max={1000000}
                    step={0.01}
                    hasClear
                    isRequired
                    isDisabled={busy}
                    isWheelEnabled={false}
                    width="100%"
                    onEntryErrorChange={trackEntryError(key)}
                  />
                ))}
              </div>
              <fieldset className="solar-settings-fieldset">
                <legend>Off-peak hours (UK local time)</legend>
                <div className="solar-settings-input-grid">
                  <TimeInput
                    label="Starts at"
                    status={fieldStatus("offpeak_start")}
                    onEntryErrorChange={trackEntryError("offpeak_start")}
                    statusVariant="detached"
                    value={form.offpeak_start || undefined}
                    onChange={(value) =>
                      update("offpeak_start", value?.slice(0, 5) || "")
                    }
                    hourFormat="24h"
                    presentation="native"
                    isRequired
                    isDisabled={busy}
                    width="100%"
                  />
                  <TimeInput
                    label="Ends at"
                    status={fieldStatus("offpeak_end")}
                    onEntryErrorChange={trackEntryError("offpeak_end")}
                    statusVariant="detached"
                    value={form.offpeak_end || undefined}
                    onChange={(value) =>
                      update("offpeak_end", value?.slice(0, 5) || "")
                    }
                    hourFormat="24h"
                    presentation="native"
                    isRequired
                    isDisabled={busy}
                    width="100%"
                  />
                </div>
                <Schedule tariff={form} />
              </fieldset>
              <Notice notice={notice} />
              <div className="solar-settings-actions">
                <Button
                  type="submit"
                  label={editing ? "Save correction" : "Save tariff"}
                  variant="primary"
                  isLoading={busy}
                />
                {editing && (
                  <Button
                    label="Add a new tariff instead"
                    variant="ghost"
                    isDisabled={busy}
                    onClick={startNew}
                  />
                )}
              </div>
            </form>
          </Card>
        </div>
        <aside className="solar-settings-secondary">
          <Card className="solar-settings-card">
            <h2>Tariff history</h2>
            <p className="solar-settings-muted">
              Price changes apply from their effective date.
            </p>
            {tariffs.length ? (
              <ol className="solar-settings-history">
                {[...tariffs].reverse().map((tariff) => (
                  <li key={tariff.effective_from}>
                    <div className="solar-settings-card-heading">
                      <strong>{dateLabel(tariff.effective_from, true)}</strong>
                      <Badge
                        label={
                          tariff.effective_from > today
                            ? "Scheduled"
                            : tariff === active
                              ? "Current"
                              : "Previous"
                        }
                        variant={tariff === active ? "success" : "neutral"}
                      />
                    </div>
                    <dl>
                      <div>
                        <dt>Peak import</dt>
                        <dd>{pence(tariff.peak_rate)}</dd>
                      </div>
                      <div>
                        <dt>Off-peak import</dt>
                        <dd>{pence(tariff.offpeak_rate)}</dd>
                      </div>
                      <div>
                        <dt>Off-peak hours</dt>
                        <dd>
                          {tariff.offpeak_start}–{tariff.offpeak_end}
                        </dd>
                      </div>
                      <div>
                        <dt>Standing charge</dt>
                        <dd>{pence(tariff.standing_charge, "p/day")}</dd>
                      </div>
                      <div>
                        <dt>Export credit</dt>
                        <dd>{pence(tariff.export_rate)}</dd>
                      </div>
                    </dl>
                    <Button
                      label={`Correct tariff from ${dateLabel(tariff.effective_from, true)}`}
                      size="sm"
                      variant="ghost"
                      isDisabled={busy}
                      onClick={() => correct(tariff)}
                    >
                      Correct tariff
                    </Button>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="solar-settings-empty">No tariffs saved yet.</p>
            )}
          </Card>
          <Card className="solar-settings-card" variant="muted">
            <h3>Reading your bill</h3>
            <p>
              Peak and off-peak prices apply to energy imported from the grid.
              Export credit reduces your estimated net cost.
            </p>
            <p>
              The standing charge applies once per UK calendar day, including a
              partially selected day.
            </p>
            <p>
              A flat tariff works too: enter the same peak and off-peak rate.
            </p>
          </Card>
        </aside>
      </div>
    </div>
  );
}

export function ConnectionPage({ settings, onSettingsChange, api, data }) {
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [devices, setDevices] = useState(settings?.devices || []);
  const [selected, setSelected] = useState(settings?.selected_sn || "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  useEffect(() => {
    setDevices(settings?.devices || []);
    setSelected(settings?.selected_sn || "");
  }, [settings]);
  const connected = !!settings?.connected;
  async function connect(event) {
    event.preventDefault();
    if (busy) return;
    if (!settings?.has_key && !key.trim()) {
      setNotice({ error: true, text: "Enter your FoxESS Cloud API key." });
      return;
    }
    if (devices.length > 1 && !selected && !key.trim()) {
      setNotice({ error: true, text: "Choose the inverter to track." });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const response = await api("/api/connection", {
        api_key: key.trim(),
        sn: selected || undefined,
      });
      setKey("");
      setShowKey(false);
      setDevices(response.devices || []);
      setSelected(response.selected_sn || "");
      const message = response.connected
        ? "Connection saved. Your first readings are ready."
        : "API key saved. Choose an inverter below, then save the connection.";
      try {
        await onSettingsChange();
        setNotice({ text: message });
      } catch {
        setNotice({
          error: true,
          text: `${message} Refresh the page to see the latest connection status.`,
        });
      }
    } catch (error) {
      setNotice({
        error: true,
        text:
          error.message ||
          "Could not connect. Check your API key and try again.",
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="solar-settings-page">
      <div className="solar-settings-layout">
        <Card className="solar-settings-card">
          <div className="solar-settings-card-heading">
            <h2>Cloud connection</h2>
            <Badge
              label={connected ? "Connected" : "Not connected"}
              variant={connected ? "success" : "warning"}
            />
          </div>
          <p className="solar-settings-muted">
            {connected
              ? "Readings refresh automatically every five minutes."
              : "Connect once to start collecting your home energy data."}
          </p>
          <form
            className="solar-settings-form"
            onSubmit={connect}
            aria-busy={busy}
          >
            <TextInput
              label="FoxESS API key"
              type={showKey ? "text" : "password"}
              value={key}
              onChange={setKey}
              autoComplete="off"
              isRequired={!settings?.has_key}
              isDisabled={busy}
              width="100%"
              placeholder={
                settings?.has_key
                  ? "Saved securely · leave blank to keep"
                  : "Paste your API key"
              }
              description={
                settings?.has_key
                  ? "A key is already saved. Enter a replacement only if it has changed."
                  : "Generate an API key in your FoxESS developer account."
              }
            />
            <div className="solar-settings-key-tools">
              <Button
                label={showKey ? "Hide API key" : "Show API key"}
                variant="ghost"
                size="sm"
                onClick={() => setShowKey((value) => !value)}
                isDisabled={busy || !key}
              />
              <a
                href="https://developer-eu.foxesscloud.com/apiKeys"
                target="_blank"
                rel="noopener noreferrer"
              >
                Open FoxESS developer portal ↗
              </a>
            </div>
            {devices.length > 0 && (
              <Selector
                label="Inverter"
                value={selected || undefined}
                options={devices.map((device) => ({
                  value: device.sn,
                  label: `${device.name} · ${device.sn}`,
                }))}
                onChange={setSelected}
                isRequired
                isDisabled={busy || !!settings?.selected_sn}
                disabledMessage={
                  settings?.selected_sn
                    ? "This dashboard is linked to this inverter to keep its history together."
                    : undefined
                }
                presentation="adaptive"
                width="100%"
                placeholder="Choose your inverter"
                description={
                  settings?.selected_sn
                    ? "This dashboard keeps one inverter’s history together."
                    : "Select the inverter installed at your home."
                }
              />
            )}
            <Notice notice={notice} />
            <div className="solar-settings-actions">
              <Button
                type="submit"
                label={
                  connected
                    ? "Save connection"
                    : devices.length > 1
                      ? "Save selected inverter"
                      : "Connect to FoxESS"
                }
                variant="primary"
                isLoading={busy}
              />
            </div>
          </form>
        </Card>
        <aside className="solar-settings-secondary">
          <Card className="solar-settings-card">
            <h2>Collection status</h2>
            <dl className="solar-settings-status">
              <div>
                <dt>Inverter</dt>
                <dd>{settings?.selected_sn || "Not selected"}</dd>
              </div>
              <div>
                <dt>Latest reading</dt>
                <dd>{stamp(data?.latest?.time)}</dd>
              </div>
              <div>
                <dt>Last successful collection</dt>
                <dd>{stamp(data?.collector?.last_success)}</dd>
              </div>
              <div>
                <dt>API calls in the last 24 hours</dt>
                <dd>{data?.calls_today ?? "—"}</dd>
              </div>
              <div>
                <dt>Refresh interval</dt>
                <dd>Every five minutes</dd>
              </div>
            </dl>
            {data?.collector?.error && (
              <Banner
                status="warning"
                title="Collection needs attention"
                description={data.collector.error}
              />
            )}
          </Card>
          <Card className="solar-settings-card" variant="muted">
            <h3>Your data stays at home</h3>
            <p>
              Your API key is stored on your server. The browser never receives
              the saved key.
            </p>
            <p>
              Collection reads measurements from FoxESS. It does not change
              inverter or battery settings.
            </p>
            <p>
              Changing to a different inverter requires a separate data volume,
              so two homes’ histories do not mix.
            </p>
          </Card>
        </aside>
      </div>
    </div>
  );
}
