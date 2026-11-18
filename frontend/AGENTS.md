# Dashboard frontend

- Use actual Astryx components and consult the installed component documentation in `node_modules/@astryxdesign/core/src/<Component>/<Component>.doc.mjs` before choosing props. Package imports use `@astryxdesign/core/<Component>`.
- Use the prebuilt Neutral theme through `@astryxdesign/theme-neutral/built`. Import reset CSS, Astryx component CSS and theme CSS in that order. Fonts are bundled locally; keep scripts, fonts and styles same-origin under the existing CSP.
- Edit `frontend/src/`, not generated `app/web/`. Run `npm run build` before testing FastAPI's production UI. Vite emits hashed assets; do not reintroduce unversioned application bundles.
- Keep Cloudflare Access as the deployed sign-in method. A failed initial session request must show retry, never assume standalone password mode. Keep API AJAX/CSRF headers in `api.js`.
- Preserve the chart helper's per-field timestamps, missing-data gaps and UK clock-change handling. Battery charge and discharge are separate measurements. Chart controls do not change which dates are costed.
- Tariff prices are in pence. Use POST for effective-dated changes and PUT for explicit corrections. Never manufacture rates or classify import as peak/off-peak when corresponding pricing is unavailable.
- Validate with `npm test`, `npm run build` and Python tests, then browser-check desktop/mobile, both themes, tariff editing and comparison controls. Use an isolated synthetic database with collection disabled for form QA.
