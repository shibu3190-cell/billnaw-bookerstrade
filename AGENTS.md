# AGENTS.md

This repository contains the DeviceTrade POS application: a Node/Express backend for authentication, Firebase/Google Sheets sync, and delivery/invoice workflows, plus a static frontend served from the `frontend/` directory.

## Primary documentation

- [README.md](README.md) is the canonical setup and deployment guide.
- [backend/package.json](backend/package.json) defines the backend scripts and dependencies.
- [backend/server.js](backend/server.js) is the main application entry point.

## Working conventions

- Treat the backend as the source of truth for authentication and authorization. The frontend is thin and depends on server-issued sessions and API tokens.
- Keep owner-only secrets in backend/.env and backend/serviceAccountKey.json. Do not commit real credentials or production keys.
- Respect the ownership model in the application: a Master Admin sees all data; subordinate admins only see their own bookers, bookings, deliveries, invoices, and profit data.
- Preserve session-based auth, API key validation, and Firestore/Sheets sync behavior when making changes to backend flows.
- Do not add demo admin credentials or password values into frontend code or docs.

## Common commands

From the repository root:

- Validate the frontend and backend syntax:
  - `node --check frontend/app.js`
  - `node --check backend/server.js`
- Start the backend:
  - `npm --prefix backend start`
- Run backend tests:
  - `npm --prefix backend test`
- Check Firebase connectivity:
  - `npm --prefix backend run check:firebase`
- Run broader connectivity checks (includes temporary Firestore/Storage probes):
  - `npm --prefix backend run check:connections`

## Environmental requirements

- The backend expects configuration values such as `MASTER_ADMIN_ID`, `MASTER_ADMIN_USERNAME`, `MASTER_ADMIN_PASSWORD`, `API_SECRET_TOKEN`, `SPREADSHEET_ID`, and Firebase credentials.
- In Render or similar deployment environments, set the service root to `backend` and provide `FIREBASE_SERVICE_ACCOUNT_JSON` as a secret.
- Firebase Storage is required for invoice uploads; missing or misconfigured bucket settings can break that workflow even if Firestore still works.

## Safe change guidance

- Prefer minimal backend edits that preserve the existing access-control flow and secret loading logic.
- When editing sync logic, keep Firestore and Google Sheets behavior consistent with the existing ownership and adminId conventions.
- Validate with the lightweight syntax checks and the relevant backend checks before considering a change complete.
