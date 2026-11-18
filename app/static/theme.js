/* Apply the theme before styles render, including on the sign-in screen. */
(() => {
  "use strict";
  const key = "solar-theme";
  const choices = new Set(["system", "light", "dark"]);
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  let preference = "system";
  try {
    const saved = localStorage.getItem(key);
    if (choices.has(saved)) preference = saved;
  } catch {
    // The control still works when browser storage is unavailable.
  }

  function apply() {
    const dark =
      preference === "dark" || (preference === "system" && system.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", dark ? "#141a23" : "#ffffff");
    document.querySelectorAll("[data-theme-select]").forEach((select) => {
      select.value = preference;
    });
  }

  apply();
  system.addEventListener("change", apply);
  window.addEventListener("storage", (event) => {
    if (event.key === key || event.key === null) {
      preference = choices.has(event.newValue) ? event.newValue : "system";
      apply();
    }
  });
  document.addEventListener("DOMContentLoaded", () => {
    apply();
    document.querySelectorAll("[data-theme-select]").forEach((select) => {
      select.addEventListener("change", () => {
        preference = choices.has(select.value) ? select.value : "system";
        try {
          localStorage.setItem(key, preference);
        } catch {
          /* Keep the session preference. */
        }
        apply();
      });
    });
  });
})();
