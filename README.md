# DeviceTrade POS

## Owner-only setup

The application no longer contains demo admin or demo booker credentials. Login is validated by the backend.

1. Open `backend/.env`.
2. Set unique owner values:
   - `MASTER_ADMIN_ID`
   - `MASTER_ADMIN_USERNAME`
   - `MASTER_ADMIN_PASSWORD`
3. Keep `backend/.env` and `backend/serviceAccountKey.json` private. They are ignored by Git.
4. Start the backend from `backend/` with `npm start`, or from the repository root with `npm --prefix backend start`.
5. Serve `frontend/` from a local web server and open the URL.

## Render deployment

Set the Render service root directory to `backend` and add `FIREBASE_SERVICE_ACCOUNT_JSON` as a secret environment variable containing the complete contents of `serviceAccountKey.json`. Create Firebase Storage in the Firebase console, then set `FIREBASE_STORAGE_BUCKET` to the exact bucket name shown there, such as `your-project.firebasestorage.app` or `your-project.appspot.com`. Do not commit the JSON key. The backend uses this environment variable in deployment and the local file when running locally.

Do not put real passwords in this README or in frontend files. The frontend only receives a short-lived server session after successful login.

## Access model

- The configured Master Admin is the owner account and has global access.
- Only the Master Admin can create, revoke, and activate subordinate admins.
- Each subordinate admin has an `adminId`; bookers and bookings created by that admin carry the same `adminId`.
- Products are assigned to an admin and inherited by that admin's bookers. Only active products in the owning admin's catalog can be selected for new bookings; legacy products without an owner remain shared and read-only to subordinate admins.
- An admin can access only their own bookers, bookings, deliveries, invoices, and profit data.
- The Master Admin can see all admin data.
- Revoking an admin or booker blocks new login and invalidates existing sessions on their next request, including after reactivation.
- Deleting an admin or booker removes their records and associated uploaded invoice files. Deletion reports an error if required cleanup fails.
- The Master Admin cannot be revoked from the UI or API.
- Booker passwords are not displayed in the application.

## Admin workflow

1. Sign in with the configured Master Admin credentials.
2. Open `Settings`.
3. Use `Add Admin Account` to create an active admin.
4. Use `Admin Access Control` to revoke or activate subordinate admins.
5. Open `Bookers` to create booker accounts under the signed-in admin and revoke or activate them.
6. In `Settings`, assign products to the owning admin, then deactivate products that should no longer be selectable.
7. Profit remains on the Home dashboard; there is no separate Profit navigation tab.

## Data and sync

- Firestore stores admins, bookers, orders, and invoice metadata.
- Google Sheets sync uses the configured spreadsheet ID and service account.
- Admin and booker Sheets rows include active state, ownership IDs, and session versions used to invalidate old sessions.
- Product catalog CSV files use `Product ID,Product Name,Target Price,Commission,Admin ID,Active`; quoted commas and newlines are supported.
- Order sheets keep `Product ID` in column N so existing ownership data in earlier columns remains in place.
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

Firebase connectivity checks:

```powershell
npm --prefix backend run check:firebase
```

For full connection checks, including a temporary Firestore write/read/delete and Storage upload/download/delete probe, run:

```powershell
npm --prefix backend run check:connections
```

The temporary records/files are deleted after the checks. The authenticated `GET /api/health/firebase` endpoint reports Firestore and Storage readiness. A missing Storage bucket does not prevent Firestore order sync, but invoice uploads require Firebase Storage to be enabled and `FIREBASE_STORAGE_BUCKET` to name the exact bucket created for the project. Choose the Storage region in Firebase Console before creating the bucket; the region cannot be changed afterward.

The project owner may create the default Storage bucket in the selected `FIREBASE_STORAGE_REGION` with `npm --prefix backend run create:storage`. The default region is `ASIA-SOUTH1`; this operation may require a Firebase Blaze plan and can incur Cloud Storage charges.
