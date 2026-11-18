/* Apply the saved preference before the stylesheet paints. */
(() => {
  try {
    const mode = localStorage.getItem("solar-theme");
    if (mode === "light" || mode === "dark")
      document.documentElement.dataset.theme = mode;
  } catch {
    /* System theme remains usable without storage. */
  }
  document.documentElement.dataset.astryxTheme = "neutral";
})();
