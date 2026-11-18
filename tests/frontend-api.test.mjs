import test from "node:test";
import assert from "node:assert/strict";
import { api, ApiError } from "../frontend/src/api.js";

test("API requests retain Access AJAX and mutation CSRF protection", async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ saved: true }) };
  };
  try {
    await api("/api/settings");
    await api("/api/tariffs/2026-01-01", { peak_rate: 20 }, "PUT");
    assert.equal(requests[0].options.credentials, "same-origin");
    assert.equal(
      requests[0].options.headers["X-Requested-With"],
      "XMLHttpRequest",
    );
    assert.equal(requests[0].options.method, undefined);
    assert.equal(requests[1].options.method, "PUT");
    assert.equal(requests[1].options.headers["X-Solar-Request"], "1");
    assert.equal(
      requests[1].options.headers["Content-Type"],
      "application/json",
    );
    assert.deepEqual(JSON.parse(requests[1].options.body), { peak_rate: 20 });
  } finally {
    globalThis.fetch = original;
  }
});

test("expired Access returns to sign-in even when the edge sends a non-JSON body", async () => {
  const original = globalThis.fetch,
    originalWindow = globalThis.window;
  const events = [];
  globalThis.window = { dispatchEvent: (event) => events.push(event.type) };
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => {
      throw Error("HTML body");
    },
  });
  try {
    await assert.rejects(
      api("/api/settings"),
      (error) => error instanceof ApiError && error.status === 401,
    );
    assert.deepEqual(events, ["solar-session-expired"]);
    events.length = 0;
    await assert.rejects(
      api("/api/login", { password: "incorrect" }),
      (error) => error.status === 401,
    );
    assert.equal(events.length, 0);
  } finally {
    globalThis.fetch = original;
    globalThis.window = originalWindow;
  }
});

test("field validation errors remain actionable and HTML failures stay generic", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({
      ok: false,
      status: 422,
      json: async () => ({ detail: "Choose a unique start date." }),
    });
    await assert.rejects(
      api("/api/tariffs", {}),
      (error) =>
        error.message === "Choose a unique start date." && error.status === 422,
    );
    globalThis.fetch = async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw Error("private upstream content");
      },
    });
    await assert.rejects(
      api("/api/dashboard"),
      (error) => error.status === 502 && !error.message.includes("private"),
    );
  } finally {
    globalThis.fetch = original;
  }
});
