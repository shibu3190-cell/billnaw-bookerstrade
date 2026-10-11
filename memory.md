# DeviceTrade POS - System Memory & Architecture Reference

## 1. Project Overview & Architecture
DeviceTrade POS is a device trading and trade-in logistics management application consisting of:
- **Backend**: Node.js/Express (`backend/server.js`) providing session-based authentication, role-based authorization, rate limiting, and dual sync with Firebase Firestore and Google Sheets.
- **Frontend**: Lightweight vanilla HTML5/CSS/JavaScript client (`frontend/app.js`, `frontend/index.html`, `frontend/style.css`) supporting PWA features, offline queues, and responsive desktop/mobile UI.
- **Data Persistence**:
  - Cloud Firestore: Primary fast transactional database (`admins`, `customers`, `products`, `orders`, `invoiceFiles`).
  - Google Sheets API v4: Real-time mirror for operational reporting (`Orders`, `Deliveries_OTP`, `Delivery_Packages`, `Admins`, `Customers`, `Products`, `Settlements`).
  - Firebase Storage: Storage bucket for GST bill/invoice image and PDF attachments.
  - IndexedDB (`devicetrade-local`): Client-side offline cache and outbox sync queue.

---

## 2. Actor Roles & Ownership Hierarchy

| Role | Scope | Capabilities | Restrictions |
| :--- | :--- | :--- | :--- |
| **Master Admin** | Global (all admins, bookers, orders, products) | Create/deactivate subordinate admins; view/edit all products, bookers, bookings, deliveries, invoices, and settlements; scope down into any specific admin portal view via selector. | Protected account; ID cannot be aliased or modified by subordinate admins. |
| **Subordinate Admin** | Scoped to own `adminId` | Create/manage assigned bookers; manage own product catalog and commissions; approve bookings; mark deliveries; execute booker settlements; view own lifetime metrics. | Strictly denied access (403) to other admins' products, bookers, orders, deliveries, and invoices. |
| **Booker (Customer)** | Scoped to own `customerId` and owning `adminId` | View assigned catalog products; create bookings (`Pending Approval`); submit delivery packages with recipient details and GST invoices; view own delivery dispatches and invoice gallery. | Cannot approve orders, settle balances, register other bookers, or view any orders/invoices outside own account. |

---

## 3. Core Pipelines & Workflows

### A. Product Catalog Pipeline
- Products belong to an Admin (`adminId`).
- Only active products in the owning admin's catalog can be booked.
- The product catalog index (`AppState.productIndexById` and `AppState.productIndexByName`) must be refreshed immediately upon any product creation, edit, or status toggle.

### B. Order & Booking Pipeline
- **Booking Creation**: Bookers create orders in `Pending Approval` state. Admin self-orders (`ADMIN-SELF-<adminId>`) or admin-created bookings start in `Booked` state.
- **Order ID vs. Merchant Order ID**:
  - `Order ID`: Unique internal system identifier (e.g. `DT9X42A...` or `OD...`), auto-generated in the background.
  - `Merchant Order ID`: External marketplace order ID (e.g. Flipkart `OD4029102931` or Amazon `402-1234567-1234567`), entered by booker/admin.
  - Both Quick Booking and Quick Delivery capture and store both `order.merchantOrderId` and `order.id`.
- **Product Entry Alignment**:
  - Both Quick Booking and Quick Delivery display catalog products with Buy Price and Commission.
  - Freeform Custom Devices: When "Other" is selected, users can enter any custom device model with custom card price and default commission.

### C. Delivery & Package DO Pipeline (Day-wise & Booker-wise DO Sequence)
- **Daily DO Sequence per Booker**:
  - On any given date, each Booker has their own continuous sequential DO queue:
    `Booker A on 2026-10-11: DO1, DO2, DO3...`
    `Booker B on 2026-10-11: DO1, DO2, DO3...`
  - Resets to `DO1` each day for each booker.
- **No Legacy Delivery**: Every delivery (single or multi-package) creates a structured package record with `doNumber`, ensuring `"Legacy delivery"` never displays.
- Parcel limit: Maximum parcels per order cannot exceed `order.quantity` (enforced with 409 conflict).

### D. GST Invoicing & Storage
- Invoices can be attached per package or per order (PDF, PNG, JPG).
- Invoices are uploaded to Firebase Storage and metadata recorded in Firestore `invoiceFiles`.
- Access control strictly enforces that only the Booker, Owning Admin, or Master Admin can view or download the invoice.

### E. Financial Settlement Pipeline
- When an order is delivered, admins can record partial or full payments via `/api/orders/settle`.
- Updates `totalSettled` on the Booker account and `settledAmount` on the Order record.
- When `advancePaid + settledAmount >= payableAmount`, order automatically transitions to `Settled` status with `settledAt` timestamp.

---

## 4. Current Fine-Tuning Focus & Known Issues Under Investigation
1. **Quick Booking vs Quick Delivery Add Product Alignment**:
   - Product dropdown in Quick Delivery (`direct-delivery-product`) must match Quick Booking (`modal-order-product`) in presentation, displaying product target price and commission.
   - Dynamic synchronization between custom model entry and locked model fields.
2. **Merchant Order ID vs Order ID Distinction**:
   - Clear separation between internal POS Order ID (auto-generated) and external Merchant Order ID (entered by user or optional).
   - Consistent labeling across Quick Booking and Quick Delivery modals.
3. **Delivery Order (DO) Function Uniformity**:
   - Eliminating the "Legacy delivery" fallback by ensuring every delivery submission (single or multi-package) creates a structured package record with proper DO sequence (`DO1`, `DO2`...).
   - Ensuring Today's Dispatches view accurately displays DO sequence numbers and package progress.
