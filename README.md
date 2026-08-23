# DeviceTrade POS

## Owner-only setup

The application no longer contains demo admin or demo booker credentials. Login is validated by the backend.

1. Open `backend/.env`.
2. Set unique owner values:
   - `MASTER_ADMIN_ID`
   - `MASTER_ADMIN_USERNAME`
   - `MASTER_ADMIN_PASSWORD`
3. Keep `backend/.env` and `backend/serviceAccountKey.json` private. They are ignored by Git.
4. Start the backend from `backend/` with `npm start`.
5. Serve `frontend/` from a local web server and open the URL.

## Render deployment

Set the Render service root directory to `backend` and add `FIREBASE_SERVICE_ACCOUNT_JSON` as a secret environment variable containing the complete contents of `serviceAccountKey.json`. Do not commit the JSON key. The backend uses this environment variable in deployment and the local file when running locally.

Do not put real passwords in this README or in frontend files. The frontend only receives a short-lived server session after successful login.

## Access model

- The configured Master Admin is the owner account and has global access.
- Only the Master Admin can create, revoke, and activate subordinate admins.
- Each subordinate admin has an `adminId`; bookers and bookings created by that admin carry the same `adminId`.
- An admin can access only their own bookers, bookings, deliveries, invoices, and profit data.
- The Master Admin can see all admin data.
- A revoked admin or booker cannot log in.
- The Master Admin cannot be revoked from the UI or API.
- Booker passwords are not displayed in the application.

## Admin workflow

1. Sign in with the configured Master Admin credentials.
2. Open `Settings`.
3. Use `Add Admin Account` to create an active admin.
4. Use `Admin Access Control` to revoke or activate subordinate admins.
5. Open `Bookers` to create booker accounts under the signed-in admin and revoke or activate them.
6. Profit remains on the Home dashboard; there is no separate Profit navigation tab.

## Data and sync

- Firestore stores admins, bookers, orders, and invoice metadata.
- Google Sheets sync uses the configured spreadsheet ID and service account.
- Admin and booker Sheets rows include active state and ownership IDs.
- API requests require the configured API token; privileged lifecycle operations also require a server-issued login session.

## Verification commands

From the repository root:

```powershell
node --check frontend/app.js
node --check backend/server.js
```

From `backend/`:

```powershell
npm start
```

Health check:

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:5000/api/health -Headers @{ 'x-api-key' = $env:API_SECRET_TOKEN }
```

The Google Sheets import and write paths require valid Firebase credentials, spreadsheet access, and non-empty owner environment values.
