# turf-api update: settings pages

**For:** turf-admin (frontend). **Date:** 31 Oct 2026.

This implements the "Settings API" spec. All seven Settings pages can now save for real, and the Next.js in-memory website routes can be deleted. Everything below is live and covered by e2e tests.

- **Who:** admins and managers can **read**. Only admins can **save, upload or reset**; managers get `403 FORBIDDEN`. System status is **admin only**.
- **Saving:** each section is one JSON object. `PUT` takes any subset and returns the whole section.
- **"Last changed":** every section returns `updatedAt` and `updatedBy` (`{ id, name }`, or `null`). Show "Last changed by Manager, 2 hours ago" under the page title. Every change is recorded with the field names that changed.
- **Validation errors:** `details[].field` uses dotted paths, for example `sections.amenities.items.2.label`. Put the message under that input.
- **Images** are checked by their contents, not the file name. They're served from `/api/v1/uploads/…`, and replacing one deletes the old file.

---

## 0. Decisions

| Topic | What shipped |
|---|---|
| Venue profile | **One** profile, edited on **General**. The Website page no longer has its own contact block; the portal reads the venue profile |
| Locale and branding | Currency (BDT), timezone (Asia/Dhaka) and week start (Saturday) are **read-only**. Date and time format, favicon and primary colour are **removed**. The **logo stays** |
| Booking page | **No new fields.** It edits the live `/admin/settings/slots` |
| Stripe and SendGrid keys | **No key fields.** Payments and Notifications show read-only status |
| Customer emails | Confirmation and cancellation **always send**. Refund and blocked-slot emails can be switched off |
| System page | A health panel and "Reset settings". No wipe, no "clear unbooked slots", no backup download |
| Extras | Email log and a generated permissions list are both built |

---

## 1. General: venue profile

| Method & path | Body | Returns |
|---|---|---|
| `GET /admin/settings/venue` | — | Venue |
| `PUT /admin/settings/venue` | Any of the editable fields | Venue |
| `POST /admin/settings/venue/logo` | `multipart/form-data`, field **`logo`**: **PNG or JPG**, 200 KB at most | **201** Venue |
| `DELETE /admin/settings/venue/logo` | — | Venue (`logoUrl: null`; show the current icon) |
| `GET /venue` (public) | — | Venue without `supportEmail`, `updatedAt` and `updatedBy` |

```json
{
  "name": "Champions Turf", "tagline": "Banani, Dhaka", "phone": "+880 1700 000 000",
  "email": "hello@championsturf.com", "supportEmail": null,
  "address": "Plot 7, Road 11, Banani, Dhaka 1213", "openHours": "06:00 — 23:00",
  "mapUrl": "", "websiteUrl": "", "logoUrl": "/api/v1/uploads/venue/3f2c….png",
  "locale": { "currency": "BDT", "timezone": "Asia/Dhaka", "weekStartsOn": "sat" },
  "updatedAt": "…", "updatedBy": { "id": "uuid", "name": "Admin" }
}
```

| Field | Rules |
|---|---|
| `name` | Required, 2–60 |
| `tagline` | Max 40 |
| `phone` | Required, 10–20 characters, shown as typed |
| `email` | Required email |
| `supportEmail` | Email, or `null`. When `null`, `email` is used |
| `address` | Required, 5–160 |
| `openHours` | Required, max 40. Free text: each ground has its own real hours |
| `mapUrl`, `websiteUrl` | An `https://` link, or `""` |
| `logoUrl`, `locale` | Read-only |

**SVG logos aren't accepted,** because an SVG can carry scripts. Use PNG or JPG.

---

## 2. Website

| Method & path | Body | Returns |
|---|---|---|
| `GET /admin/settings/website` | — | Website |
| `PUT /admin/settings/website` | `{ hero?, sections?, social? }` | Website |
| `POST /admin/settings/website/images/:slot` | `:slot` is `hero` or `visit`. `multipart/form-data`, field **`image`**: JPG, PNG or WEBP, 2 MB at most | **201** Website |
| `GET /website` (public) | — | Website plus `venue` (the public venue profile), with no audit fields |

- **What a `PUT` replaces:**
  - `hero` and `social` replace those parts whole.
  - `sections` replaces only the sections it names, each one whole. For example, `{ "sections": { "sportChips": { … } } }` leaves the other sections alone.
- **Shape and limits** are exactly the existing form's (`src/validations/website-settings.ts`), minus `contact`, which moved to the venue profile.
- **`imageUrl`** is either an uploaded file (`/api/v1/uploads/website/<uuid>.<ext>`) or an `https://` link.
  - **Upload** with the images endpoint. It sets `hero.imageUrl` or `sections.visitUs.imageUrl` and deletes the previous upload.
  - **Stop using** the old `/api/settings/website/images/…?v=` URLs.
- **Defaults:** a fresh install starts with the defaults from `src/services/website-settings.ts`.
- **Portal home page:** one request to `GET /website`.
- **Caching:** the public `GET /venue` and `GET /website` are cached for 60 seconds on the server. A save clears the cache straight away.

---

## 3. Booking

There's nothing new. The page edits `GET/PUT /admin/settings/slots`: `advanceBookingDays`, `cancellationCutoffHours`, `autoGenerate`, `holdMinutes`, `serviceFee` and `portalCashEnabled`.
- That endpoint now also returns `updatedAt` and `updatedBy`.
- **Remove from the page:**
  - minimum advance booking (the cutoff does this);
  - slot length, opening and closing time, and peak pricing (these are per ground);
  - customer partial payments, auto-confirm, price override and "show price".

---

## 4. Payments: `GET /admin/settings/payments/status` (read-only)

```json
{
  "stripe": {
    "configured": true, "mode": "test",
    "webhook": { "configured": true, "lastEventAt": "2026-10-31T09:58:00.000Z", "lastEventOk": true },
    "currency": "bdt"
  },
  "methods": { "card": true, "cash": true, "bankTransfer": true },
  "portalCashEnabled": true
}
```
- **`mode`:** `test` or `live`, from the key itself. It's `null` when Stripe isn't set up. No part of any key is ever returned.
- **`webhook.lastEventAt`:** when the last signed webhook arrived.
  - `lastEventOk` is `false` if handling it failed.
  - Show a warning when Stripe is configured but no webhook has arrived in 7 days.
- **Keep the "Pay at venue" switch.** It saves through `/admin/settings/slots` (`portalCashEnabled`).
- **Remove from the page:** the key and webhook-secret fields, the test-mode switch (it follows the key), and everything about receipts.

---

## 5. Notifications

| Method & path | Body | Returns |
|---|---|---|
| `GET /admin/settings/notifications` | — | Notifications |
| `PUT /admin/settings/notifications` | Any subset of `email`, `customer` and `staff` | Notifications |
| `POST /admin/settings/notifications/test` | `{ to? }` (default: you) | `{ sent: true }`. At most **5 an hour** per user |
| `GET /admin/settings/notifications/log?page&limit` | — | `{ data: [{ id, to, subject, kind, ok, error, createdAt }], total, page, limit }`, newest first |

```json
{
  "email": {
    "configured": true, "fromEmail": "no-reply@championsturf.com",
    "fromName": null, "replyTo": null,
    "effectiveFromName": "Champions Turf", "effectiveReplyTo": "support@championsturf.com"
  },
  "customer": { "bookingConfirmed": true, "bookingCancelled": true, "refundIssued": true, "slotBlocked": true },
  "staff": { "recipients": ["owner@championsturf.com"], "newBooking": false, "customerCancelled": true, "dueDigest": true },
  "updatedAt": "…", "updatedBy": { "id": "uuid", "name": "Admin" }
}
```

**The `email` block:**
- **`configured` and `fromEmail`** are read-only. `fromEmail` is the `EMAIL_FROM` env var, which must be a verified SendGrid sender. The spec's `SENDGRID_FROM_EMAIL` is this same variable.
- **`fromName` and `replyTo`:**
  - `null` means "follow the venue": its name, and its support email (or its email).
  - Show `effectiveFromName` and `effectiveReplyTo` as the placeholders.
  - Send `null` to go back to following the venue.

**Customer emails:**
- **`bookingConfirmed` and `bookingCancelled`** are always `true`. Show them as locked switches. Sending `false` returns `400`.
- **`slotBlocked`** is the same setting as `notifyCustomerOnBlock` in slot settings, so both pages agree.

**Staff emails:**
- **`recipients`:** 0–5 emails. Empty means every active admin.
- **`newBooking`:** the same setting as `notifyAdminOnBooking` in slot settings.
- **`customerCancelled`:** an email to staff when a customer cancels through their link.
- **`dueDigest`:** one email from 09:00 venue time listing overdue and due-today bookings, using the same rules as the dashboard cards. It isn't sent when the list is empty.

**Test email errors:** `400 EMAIL_NOT_CONFIGURED` without SendGrid, `502 EMAIL_PROVIDER_ERROR` with SendGrid's reason, and `429 TOO_MANY_ATTEMPTS`.

**The log:**
- It lists **every attempt**, including failed ones and "not configured".
- `to` is masked (`ra***@example.com`).
- `kind` is one of `booking_confirmed`, `booking_received`, `booking_cancelled`, `refund_issued`, `payment_due`, `staff_new_booking`, `staff_customer_cancelled`, `staff_due_digest` or `test`.

**Remove from the page:** the SendGrid API key field.

---

## 6. Access: no new settings endpoint

Rebuild the page from `GET /admin/users`: active staff and their roles, linking to Staff for changes.
- **The roles table:** use `GET /admin/auth/permissions` (admin and manager). It returns `{ admin: string[], manager: string[] }`, for example `"PUT /admin/settings/venue"`.
  - It's generated from the API's own route guards, so it can't drift.
  - Group it by path for the table.
- **Fixed facts to show:**
  - Sessions last 8 hours.
  - 5 login attempts per minute.
  - Signing out ends every session.
- **Remove:** Super Admin, Attendant and the email invite box.

---

## 7. System

| Method & path | Who | Returns |
|---|---|---|
| `GET /admin/system/status` | **admin** | See below |
| `POST /admin/settings/reset` | **admin** | `{ sections?: ["slots", "notifications", "website"] }`; all three when left out. Returns the reset sections |

```json
{
  "version": "0.0.1", "startedAt": "…",
  "database": { "ok": true },
  "counts": { "grounds": 3, "slots": 1602, "bookings": 13, "customers": 4, "payments": 9 },
  "jobs": {
    "slotGeneration": { "lastRunAt": "…", "ok": true },
    "holdExpiry": { "lastRunAt": "…", "ok": true },
    "completion": null, "dueReminders": null, "dueDigest": null
  },
  "integrations": { "stripe": true, "sendgrid": false, "twilio": false }
}
```
- **Jobs:**
  - A job is `null` until it first runs after a restart. The hourly jobs run within an hour of `startedAt`.
  - A failed run has `ok: false` and `error`, with the message only.
- **Counts** leave out soft-deleted rows. Nothing secret is ever included.
- **No database size:** reading it needs raw SQL, which the API doesn't use.
- **Reset:**
  - It never touches the venue profile, grounds, bookings, customers or payments.
  - Resetting `notifications` also restores the two notify switches in slot settings.
- **Remove from the page:** backups, "Clear all unbooked slots" and "Wipe all data".

---

## 8. Errors

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Any invalid field; `details[].field` uses dotted paths |
| 400 | `IMAGE_REQUIRED`, `INVALID_IMAGE_TYPE`, `IMAGE_TOO_LARGE` | Logo and website image uploads (`413` above 1 MB for the logo, or 5 MB for website images) |
| 400 | `EMAIL_NOT_CONFIGURED` | Test email without SendGrid |
| 403 | `FORBIDDEN` | A manager saving, uploading, resetting or reading system status |
| 429 | `TOO_MANY_ATTEMPTS` | More than 5 test emails in an hour |
| 502 | `EMAIL_PROVIDER_ERROR` | SendGrid refused the test email |

---

## 9. Checklist

- [ ] General: `/admin/settings/venue` with a real save; locale read-only; logo upload and remove; date and time format, favicon and colour removed
- [ ] Website: `/admin/settings/website` and its image upload; Next.js `/api/settings/website*` routes and in-memory stores deleted; contact block moved to General; portal home reads `GET /website`, and its header and footer read `venue`
- [ ] Booking: edits `/admin/settings/slots`; duplicate and out-of-scope fields removed
- [ ] Payments: read-only status from `/admin/settings/payments/status`; key fields and receipts removed; "Pay at venue" switch kept
- [ ] Notifications: real preferences; confirmation and cancellation shown locked; test email button; email log table; SendGrid key field removed
- [ ] Access: staff from `/admin/users`, roles table from `/admin/auth/permissions`, invites and extra roles removed
- [ ] System: health panel from `/admin/system/status` (admins only), "Reset settings"; backups, clear and wipe removed
- [ ] Every page shows "Last changed by …" from `updatedAt` / `updatedBy`
