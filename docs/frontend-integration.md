# Connecting turf-admin to turf-api

This guide connects the Next.js frontend (`turf-admin`) to the real backend (`turf-api`, NestJS). It covers what the API offers today, how to connect it, and exactly what to change in the frontend.

Today **authentication**, **staff user management**, **grounds**, **slots**, **bookings**, **checkout**, **customers** and **dashboard stats** are live in the API. Bookings, checkout, customers and the dashboard are documented in [`docs/frontend-bookings.md`](frontend-bookings.md), reports in [`docs/frontend-reports.md`](frontend-reports.md), the dashboard home in [`docs/frontend-dashboard.md`](frontend-dashboard.md), settings in [`docs/frontend-settings.md`](frontend-settings.md), and the newest slot features (closures, history, bulk actions) in [`docs/frontend-slots-update.md`](frontend-slots-update.md).

---

## 1. How the pieces fit

```
Browser ──► turf-admin (Next.js, :3000) ──rewrite /api/v1/*──► turf-api (NestJS, :4000)
```

- The browser only ever calls `localhost:3000/api/v1/...`.
- Next.js forwards (rewrites) those requests to `turf-api`.
- Because the browser sees a single origin, the auth cookie is **first-party**. You don't need CORS or `withCredentials`.

---

## 2. Setup

### 2.1 Run the backend

The backend lives in `turf-api`. Its database runs in Docker.

```bash
cd turf-api
docker compose up -d     # Postgres
yarn start:dev           # API on http://localhost:4000/api/v1
```

To check it's running, open `http://localhost:4000/api/v1/health`. It should return `{ "success": true, "data": { "status": "ok", ... } }`.

**Dev login:** email `admin@example.com`. The password is `SEED_ADMIN_PASSWORD` in `turf-api/.env`; ask the backend owner for it. It is not written here on purpose.

### 2.2 Add the proxy in `next.config.mjs`

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: { remotePatterns: [{ protocol: "https", hostname: "**" }] },
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: `${process.env.API_PROXY_TARGET ?? "http://localhost:4000"}/api/v1/:path*`,
      },
    ];
  },
};

export default nextConfig;
```

The existing mock routes under `src/app/api/*` (`/api/grounds`, `/api/bookings`, …) have no `v1` in their path, so they don't clash with the rewrite. Remove each one once the real endpoint replaces it.

### 2.3 Environment variables

`.env.local`:

```bash
NEXT_PUBLIC_API_URL=/api/v1             # relative, so browser calls go through the proxy
API_PROXY_TARGET=http://localhost:4000  # where turf-api runs (server-side only)
NEXT_PUBLIC_APP_NAME=Turf
```

Add the same keys, without real values, to `.env.example`.

`src/lib/api.ts` (axios) and `src/lib/api-client.ts` (fetch) both already read `NEXT_PUBLIC_API_URL`, so they need no URL changes. Update the fallback default in `src/lib/api.ts` from `http://localhost:5000/api` to `/api/v1` so it matches.

In production, set `API_PROXY_TARGET` to the deployed API URL (for example `https://api.example.com`).

---

## 3. API conventions

### 3.1 Every response uses the same envelope

**Success:**

```json
{ "success": true, "data": { ... } }
```

**Error:**

```json
{
  "success": false,
  "error": "Human-readable message, safe to show the user",
  "code": "MACHINE_READABLE_CODE",
  "details": [{ "field": "email", "message": "Enter a valid email" }]
}
```

- `code` is present on known errors. Branch on `code`, not on the message text.
- `details` is present only on validation errors (`400`). Use it to show a message under each form field.
- Unknown server errors return `500` with `"error": "Internal server error"` and no internals.

List endpoints, once they exist, return `data: { data: [...], total, page, limit }`.

### 3.2 Status codes and error codes

| Status | `code` | When | What the UI should do |
|---|---|---|---|
| 400 | `VALIDATION_FAILED` | Body, query or params failed validation | Show `details[].message` next to each field |
| 400 | `WRONG_PASSWORD` | Change password: the current password is wrong | Show `error` under "Current password" |
| 400 | `CANNOT_CHANGE_OWN_ACCESS` | An admin tried to change their own role or deactivate themselves | Show `error`; disable those controls on your own row |
| 401 | `INVALID_CREDENTIALS` | Wrong email or password, or the account is deactivated | Show `error` on the login form |
| 401 | `UNAUTHENTICATED` | No cookie, or it's invalid or expired | Redirect to `/login` |
| 403 | `FORBIDDEN` | Signed in, but the role isn't allowed | Show a "no permission" message |
| 400 | `INVALID_HOURS` | Editing one hour would put closing at or before opening | Show `error` under the hours fields |
| 400 | `INVALID_DAYS` | `availableDays` is `custom` but no days are picked | Show `error` under the days picker |
| 400 | `INVALID_PEAK_PRICING` | Peak price without ranges (or the reverse), a range outside opening hours, or overlapping ranges | Show `error` under the peak pricing fields |
| 400 | `PHOTO_REQUIRED`, `INVALID_PHOTO_TYPE`, `PHOTO_TOO_LARGE`, `TOO_MANY_PHOTOS`, `INVALID_PHOTO_ORDER` | Photo upload and reorder problems | Show `error` next to the photo picker |
| 404 | `PHOTO_NOT_FOUND` | Deleting a photo that isn't on the ground | Refresh the ground |
| 404 | `USER_NOT_FOUND` | No user with that id | Show "not found" |
| 404 | `GROUND_NOT_FOUND` | No ground with that id, or (public) it's inactive | Show "not found" |
| 404 | `SLOT_NOT_FOUND` | No slot with that id, or (single block) no slot starts at that hour | Refresh the slot list |
| 400 | `SLOT_IN_PAST` | Blocking or unblocking a slot that has started | Show `error`; refresh |
| 400 | `INVALID_DATE_RANGE` | `from` after `to`, a range longer than allowed, or generating from a past date | Show `error` under the date fields |
| 400 | `GROUND_CLOSED` | Generating or blocking only on days the ground doesn't open, or for an inactive ground | Show `error` |
| 409 | `SLOT_HAS_BOOKING` | Blocking a booked slot | Show `error` |
| 409 | `SLOT_ALREADY_BLOCKED`, `SLOT_NOT_BLOCKED` | Blocking twice, or unblocking a slot that isn't blocked | Refresh the slot |
| 409 | `SLOT_NOT_AVAILABLE` | A slot changed while saving (someone else acted first) | Refresh and try again |
| 404 | `CLOSURE_NOT_FOUND` | No closure with that id | Refresh the list |
| 409 | `CLOSURE_ALREADY_LIFTED` | Lifting a closure twice | Refresh the list |
| 409 | `EMAIL_TAKEN` | Creating or editing a user with an email that's already used | Show `error` under the email field |
| 429 | `TOO_MANY_ATTEMPTS` | Too many login attempts | Show `error`, disable the button for about a minute |
| 500 | (none) | Unexpected server error | Show a generic error |

### 3.3 Roles

There are only two roles: **`admin`** and **`manager`**. The role comes from the database, through the login response or `GET /me`.

- **Never let the user pick a role in the UI.**
- **There is no `super_admin` or `attendant`.**

---

## 4. Auth endpoints

All live under `/api/v1/admin/auth`.

### `POST /api/v1/admin/auth/login`

**Request body:**

```json
{ "email": "admin@example.com", "password": "..." }
```

- The email is trimmed and lowercased on the server, so `" Admin@Example.com "` works.
- The password must be 1–200 characters.

**Success (`200`)** sets the auth cookie and returns the user:

```json
{
  "success": true,
  "data": { "id": "5cc5…", "email": "admin@example.com", "name": "Admin", "role": "admin" }
}
```

**Errors:**
- `400 VALIDATION_FAILED`: invalid body.
- `401 INVALID_CREDENTIALS`: always the same message, `"Invalid email or password"`, whether the email exists or not.
- `429 TOO_MANY_ATTEMPTS`: more than **5 attempts per minute** for the same email (failed and successful attempts both count). **The API enforces this, so don't build a client-side counter or lock.**

### `POST /api/v1/admin/auth/logout`

- No body.
- Always returns `200 { "success": true, "data": { "loggedOut": true } }` and clears the cookie.
- Works even if the session has already expired.
- **Signs the user out on every device.** Every token the user holds is revoked on the server, so even a copied cookie stops working.

### `POST /api/v1/admin/auth/change-password`

Any signed-in user (admin or manager) can change **their own** password. This is the only self-service change: names, emails and roles are managed by admins.

**Request body:**

```json
{ "currentPassword": "...", "newPassword": "at least 12 characters" }
```

- **`200 { "passwordChanged": true }`:** the cookie is refreshed, so this session stays signed in. Every other session for this user is signed out.
- **`400 WRONG_PASSWORD`:** the current password is wrong. Note this is **400, not 401**, so the global 401 redirect won't fire.
- **`400 VALIDATION_FAILED`:** the new password is shorter than 12 characters, or the same as the current one.

### `GET /api/v1/admin/auth/me`

- **`200`** returns the signed-in user, in the same shape as the login response.
- **`401 UNAUTHENTICATED`** means the user isn't signed in.
- Use this to show the user's name and role in the dashboard header, and to check the session.

### The cookie

| Property | Value |
|---|---|
| Name | `admin_token` |
| Flags | `HttpOnly; SameSite=Lax; Path=/`, plus `Secure` in production |
| Lifetime | 8 hours |

- The browser's JavaScript **cannot read or write** this cookie. That's intended. Never set `admin_token` from frontend code.
- If a user is deactivated, or their role changes, the next request reflects it immediately.

---

## 4b. Users endpoints (admin only)

Staff accounts live under `/api/v1/admin/users`.
- A `manager` calling any of these gets `403 FORBIDDEN`. Hide the "Users" menu item for managers.
- There is no delete. Deactivate instead (`isActive: false`), which signs the user out immediately and blocks their logins.

**The user object** returned by every endpoint below:

```json
{
  "id": "uuid", "email": "manager@example.com", "name": "Manager", "role": "manager",
  "isActive": true, "createdAt": "2026-10-28T04:20:30.602Z", "updatedAt": "2026-10-28T04:20:30.602Z"
}
```

| Method & path | Body / query | Success | Errors |
|---|---|---|---|
| `GET /admin/users` | Query: `page` (default 1), `limit` (default 20, max 100), `search` (matches name or email) | `200 { data: User[], total, page, limit }`, newest first | — |
| `GET /admin/users/:id` | — | `200 User` | `400` bad id · `404 USER_NOT_FOUND` |
| `POST /admin/users` | `{ email, name, password, role? }`. Role defaults to `manager`; password needs 12+ characters | **`201`** `User` | `400` · `409 EMAIL_TAKEN` |
| `PATCH /admin/users/:id` | Any of `{ email, name, role, isActive }`, at least one | `200 User` | `400` (including `CANNOT_CHANGE_OWN_ACCESS`) · `404` · `409 EMAIL_TAKEN` |
| `POST /admin/users/:id/reset-password` | `{ password }` (12+ characters) | `200 User` | `400` · `404` |

Notes for the UI:
- **Reset password** is for a manager who forgot theirs, since there's no email reset in v1. The admin picks a new password and tells them. The user is signed out everywhere.
- **On the signed-in admin's own row**, disable the role and active controls. The API rejects those changes with `CANNOT_CHANGE_OWN_ACCESS`, which guarantees at least one active admin always remains.
- **Emails are stored lowercase and trimmed.** Display what the API returns.

---

## 4c. Grounds endpoints

**The ground object** (public version):

```json
{
  "id": "uuid", "name": "Green Arena", "description": null, "address": "Road 1, Dhaka",
  "mapUrl": "https://maps.app.goo.gl/abc123",
  "hourlyPrice": 1500, "openingHour": 6, "closingHour": 23,
  "sport": "football", "format": "5x5", "surface": "outdoor-turf", "dimensions": "28×18 m",
  "capacity": 10, "amenities": ["Floodlights", "Parking"],
  "availableDays": "custom", "customDays": ["fri", "sat"],
  "peakPrice": 2000, "peakRanges": [{ "fromHour": 17, "toHour": 22 }],
  "slotDurationMinutes": 60,
  "photos": ["/api/v1/uploads/grounds/<groundId>/3f2c….jpg"]
}
```

| Field | Type / allowed values | Rules |
|---|---|---|
| `name` | string | Required, max 100 |
| `hourlyPrice` | int, **smallest currency unit** (`1500` = 15.00) | Required, > 0. Divide by 100 to display; multiply by 100 when saving |
| `openingHour` | int 0–23 (`6` = 06:00) | Required |
| `closingHour` | int 1–24, after `openingHour` | Required. `23` means the last slot is 22:00–23:00 |
| `sport` | `football`, `cricket`, `badminton`, `tennis`, `hockey`, `basketball`, `other` | **Required on create** |
| `format` | `4x4`, `5x5`, `6x6`, `7x7`, `8x8`, `9x9`, `11x11`, `net`, `court` | Optional |
| `surface` | `outdoor-turf`, `indoor-court`, `covered-net` | Optional |
| `dimensions` | string, e.g. `"28×18 m"` | Optional, max 50 |
| `capacity` | int (players) | Optional, 1–1000 |
| `amenities` | string[] from: `Floodlights`, `Parking`, `Changing room`, `Washroom`, `Scoreboard`, `Drinking water`, `First aid`, `AC`, `CCTV`, `Seating area` | Optional, no repeats, max 10. Use these exact labels |
| `availableDays` | `everyday`, `weekdays`, `weekends`, `custom` | Default `everyday` |
| `customDays` | array of `mon` … `sun` | **Required, at least one, when `availableDays` is `custom`.** Ignored and stored as `[]` otherwise |
| `peakPrice` | int, smallest unit, or `null` | Optional. **When set, `hourlyPrice` is the off-peak price.** Must be set together with `peakRanges` |
| `peakRanges` | `[{ fromHour, toHour }]` (whole hours, `toHour` exclusive) | Optional, max 6. Each range must fall within opening hours, with `fromHour < toHour` and no overlaps. Send `peakPrice: null, peakRanges: []` to turn peak pricing off |
| `slotDurationMinutes` | `60` or `120` | Default `60`. Slots start at `openingHour` in steps of this length; a last slot that would run past closing is dropped (6–23 with 120 → 6, 8, …, 20) |
| `photos` | string[] of URLs, read-only | Managed through the photo endpoints below. The first one is the cover. Use the URLs as they are, because they go through the `/api/v1` proxy |
| `description`, `address` | string | Optional, max 2000 and 300; `null` when empty |
| `mapUrl` | string | Optional https map link (for example a Google Maps share link), max 500. `""` or `null` clears it. `400` with `field: "mapUrl"` for anything else. On the portal, open it from "Directions"; when it's `null`, fall back to the venue's `mapUrl`, then to a search link built from the address |

The **admin** version also has:

| Field | Meaning |
|---|---|
| `isActive` | `false` = deactivated: hidden from the portal and not bookable |
| `showOnPortal` | Default `true`. `false` hides the ground from the portal while it stays active (for example, bookable by staff only) |
| `internalNotes` | Staff-only notes, max 2000. **Never returned by the public endpoints** |
| `createdAt`, `updatedAt` | Timestamps |

The portal only ever sees grounds that are **both** `isActive` and `showOnPortal`.

**How a slot is priced:** hour by hour. Each hour inside a peak range costs `peakPrice`, and every other hour costs `hourlyPrice`. A 2-hour slot from 16 to 18, with peak from 17, costs `hourlyPrice + peakPrice`. The Slots API will return each slot's price, so the portal won't need to calculate it.

### Public (customer portal, no sign-in)

| Method & path | Query | Success | Errors |
|---|---|---|---|
| `GET /api/v1/grounds` | `page`, `limit`, `search` (name), `sport`, `format`, `surface` | `200 { data: Ground[], total, page, limit }`, sorted by name, **visible grounds only** | `400` for an unknown filter value |
| `GET /api/v1/grounds/:id` | — | `200 Ground` | `404 GROUND_NOT_FOUND`, also for inactive or hidden grounds |

The portal's filter sidebar can pass `sport`, `format` and `surface` straight through. The portal's sport list should match the 7 sports above. The admin form's list is the source of truth.

### Admin (`/api/v1/admin/grounds`)

| Method & path | Who | Body / query | Success | Errors |
|---|---|---|---|---|
| `GET /admin/grounds` | admin, manager | `page`, `limit`, `search`, `sport`, `format`, `surface`, `isActive` (`true` or `false`; omit for all) | `200 { data, total, page, limit }` | — |
| `GET /admin/grounds/:id` | admin, manager | — | `200 Ground` | `404` |
| `POST /admin/grounds` | **admin** | All fields from the tables above. Required: `name`, `sport`, `hourlyPrice`, `openingHour`, `closingHour` | **`201`** `Ground` | `400` (including `INVALID_DAYS`) · `403` for managers |
| `PATCH /admin/grounds/:id` | **admin** | Any subset of the fields. Send `null` to clear an optional one | `200 Ground` | `400` (including `INVALID_HOURS`, `INVALID_DAYS`) · `403` · `404` |

### Photos (`/api/v1/admin/grounds/:id/photos`, admin only)

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `POST /admin/grounds/:id/photos` | `multipart/form-data`, one file in the field **`photo`** | **`201`** the updated `Ground` (new photo added at the end) | `400` `PHOTO_REQUIRED`, `INVALID_PHOTO_TYPE`, `PHOTO_TOO_LARGE`, `TOO_MANY_PHOTOS` · `404` |
| `PUT /admin/grounds/:id/photos` | `{ "photos": ["<file name>", …] }`: every current photo exactly once, in the new order | `200 Ground` | `400 INVALID_PHOTO_ORDER` · `404` |
| `DELETE /admin/grounds/:id/photos/:fileName` | — | `200 Ground` | `404 PHOTO_NOT_FOUND` |

- **The file name** is the last part of the photo URL, for example `3f2c….jpg`.
- **Rules:** **JPG or PNG only**, **2 MB or smaller**, and **at most 5 photos** per ground. The admin form can show 2 slots if you prefer; the API allows up to 5 for the portal gallery.
  - The type is checked from the file's contents, so a renamed file is rejected.
  - Files over 5 MB are cut off early with `413`.
- **Upload example:**
  ```ts
  const form = new FormData();
  form.append("photo", file); // a File from <input type="file">
  await fetch(`/api/v1/admin/grounds/${id}/photos`, { method: "POST", body: form });
  // don't set Content-Type yourself: the browser adds the multipart boundary
  ```
- **With `next/image`,** the URLs are same-origin paths (`/api/v1/uploads/...`), so no extra `remotePatterns` are needed.

Notes for the UI:
- **Hide "Add ground" and the edit controls for managers.**
- **There's no delete.** To remove a ground, deactivate it (`isActive: false`): it disappears from the portal but stays in the dashboard and in past bookings.
- **Send numbers as JSON numbers,** not strings. `"1500"` is rejected with "Must be a number".
- **Convert time pickers to whole hours:** `"06:00"` → `6`.

---

## 4d. Slots endpoints

Slots are stored rows, one per bookable period on one ground. They're created from the ground's schedule: they start at `openingHour`, step by `slotDurationMinutes`, skip closed days, and drop a last slot that would run past `closingHour`. A background job keeps slots created up to `advanceBookingDays` ahead. Creating a ground also fills its slots right away.

**Times are venue-local (Asia/Dhaka).** `date` is `"YYYY-MM-DD"` and hours are whole integers. Don't convert them to UTC. "Today" and "already started" use the venue's clock. **Weekends are Sat–Sun**, as the ground form shows.

### The slot object (admin)

```json
{
  "id": "uuid",
  "groundId": "uuid",
  "groundName": "Green Arena",
  "date": "2026-10-30",
  "startHour": 18,
  "endHour": 19,
  "durationMinutes": 60,
  "price": 2500,
  "status": "blocked",
  "booking": null,
  "block": {
    "reason": "maintenance",
    "note": "Net repair",
    "blockedBy": { "id": "uuid", "name": "Manager" },
    "blockedAt": "2026-10-28T09:00:00.000Z"
  },
  "createdAt": "…",
  "updatedAt": "…"
}
```

- `status` is `available`, `held` (a customer is in Stripe checkout; see `heldUntil`), `booked` or `blocked`. There is **no `partial` status**: payment state is in `booking.paymentStatus`. `booking` is `{ id, bookingNumber, customerName, paymentStatus }` for held and booked slots, otherwise `null`.
- `price` was fixed when the slot was created (`slotPrice()`, peak hours included). Show it as is; don't recalculate it.
- `block` is `null` unless `status` is `blocked`. Block reasons: `maintenance`, `reserved`, `event`, `weather`, `other`. `note` is optional, up to 500 characters.

### Public (customer portal, no sign-in)

| Method & path | Query | Success | Errors |
|---|---|---|---|
| `GET /grounds/:id/slots` | `date`, **or** `from` + `to` (at most 14 days) | `200 [{ id, date, startHour, endHour, price, isPeak, available }]` | `400 VALIDATION_FAILED`, `INVALID_DATE_RANGE` · `404 GROUND_NOT_FOUND` (hidden or inactive) |

- `available` is `false` for booked, blocked and started slots, for slots inside the cancellation cutoff (default 2 hours), and for slots past the booking window. The response never says *why*.
- Closed days return `[]`.
- This replaces the slot picker's fake `hour % 4 !== 2` availability. Show more than the next 5 days if you like.

### Admin (`/api/v1/admin/slots`)

| Method & path | Who | Body / query | Success | Errors |
|---|---|---|---|---|
| `GET /admin/slots` | admin, manager | `groundId` (omit for all), `date` or `from`+`to`, `status`, `reason`, `page`, `limit` | `200 { data: Slot[], total, page, limit, stats }` | `400` |
| `GET /admin/slots/:id` | admin, manager | — | `200 Slot` | `404 SLOT_NOT_FOUND` |
| `POST /admin/slots/generate` | **admin** | `{ groundId: uuid \| "all", fromDate, toDate, dryRun? }` (at most 90 days, not in the past) | `200 { generated, skipped, days, slotsPerDay }` | `400 INVALID_DATE_RANGE`, `GROUND_CLOSED` · `403` · `404` |
| `POST /admin/slots/:id/block` | admin, manager | `{ reason, note? }` | `200 { slot, cancelledBooking: false }` | `400 SLOT_IN_PAST` · `404` · `409 SLOT_HAS_BOOKING`, `SLOT_ALREADY_BLOCKED` |
| `POST /admin/slots/:id/unblock` | admin, manager | — | `200 Slot` | `400 SLOT_IN_PAST` · `404` · `409 SLOT_NOT_BLOCKED` |
| `POST /admin/slots/block` | admin, manager | See block types below | `200 { blocked, skippedBooked, cancelledBookings }` | `400 GROUND_CLOSED`, `SLOT_IN_PAST`, `INVALID_DATE_RANGE` · `404` · `409` |
| `POST /admin/slots/unblock` | admin, manager | `{ groundId?, date }` | `200 { unblocked }` | `400` |
| `GET /admin/slots/calendar` | admin, manager | `from`, `to` (at most 62 days), `groundId?` | `200 { slots, totals }` | `400 INVALID_DATE_RANGE` |

- **`stats`** = `{ total, available, booked, blocked }` for the same ground and dates, **ignoring** the `status` and `reason` filters, so the stat cards stay put while you filter.
- **Generate** never overwrites. `skipExisting` may be sent but must be `true`, so remove the "No, overwrite existing slots" option. Use `dryRun: true` for the form's preview instead of the invented 12% figure. The custom-times inputs aren't used: hours and price always come from the ground.
- **Blocking a booked slot** returns `409 SLOT_HAS_BOOKING` unless the body has `cancelBooking: true`, which cancels the booking with a full refund and returns `cancelledBooking: true`. Bulk and full-day blocks still skip booked slots (`skippedBooked`).
- **Unblocking** sets the slot back to `available`. Every block and unblock is recorded (who and when) for the audit history.

**Block types for `POST /admin/slots/block`** (all need `groundId`, `date`, `reason`, and optionally `note`):

| `type` | Extra fields | Effect |
|---|---|---|
| `single` | `startHour` | Blocks the slot that starts at that hour (`404 SLOT_NOT_FOUND` if none) |
| `fullDay` | — | Blocks every free, upcoming slot that day; booked ones are counted in `skippedBooked` |
| `recurringWeekly` | `weekdays` (`mon`…`sun`), `untilDate` (at most a year), `startHour?` (omit for whole days) | Blocks matching slots from `date` to `untilDate`. Slots beyond the generated window are created first, so far-future blocks work |

**Calendar:** `slots` holds only booked and blocked slots: `{ id, groundId, groundName, date, startHour, endHour, status, note? }`. For blocked slots, `note` is `"reason: note"`. Customer and amount fields will come with bookings. `totals` = `[{ date, groundId, totalSlots }]`; use it instead of the hardcoded `DAILY_SLOTS`.

### Block history

| Method & path | Who | Query | Success |
|---|---|---|---|
| `GET /admin/slots/:id/history` | admin, manager | — | `200 [{ id, action, reason, note, user: { id, name } \| null, createdAt }]`, newest first · `404 SLOT_NOT_FOUND` |
| `GET /admin/slot-events` | admin, manager | `groundId?`, `from`+`to` (slot dates, together), `action?` (`block`, `unblock`, `close`, `reopen`), `userId?`, `page`, `limit` | `200 { data, total, page, limit }`; each event adds `slotId` (null once a free slot was regenerated), `groundId`, `groundName`, `date`, `startHour` |

### Bulk block / unblock by id

`POST /admin/slots/bulk` (admin, manager) with `{ ids: uuid[] (1–100), action: "block" | "unblock", reason?, note? }`. `reason` is required when blocking. Returns `200 { done, failed: [{ id, code, error }] }`.

Each id follows the single-slot rules (`SLOT_IN_PAST`, `SLOT_HAS_BOOKING`, `SLOT_ALREADY_BLOCKED`, `SLOT_NOT_BLOCKED`, `SLOT_NOT_FOUND`). A failed id doesn't undo the others. Switch the slot list's checkbox actions to this one call, and show the `failed` list.

### Venue closures

Close some or all grounds for a date range (Eid, a power cut). The closure itself is stored, so slots generated later on those days are created already blocked.

| Method & path | Who | Body / query | Success | Errors |
|---|---|---|---|---|
| `POST /admin/closures` | **admin** | `{ fromDate, toDate, groundIds?, reason, note?, publicLabel? }`. Omit `groundIds` (or send `[]`) for every ground, including grounds added later. At most 31 days, not in the past | **`201`** `{ closure, blocked, skippedBooked }` | `400 INVALID_DATE_RANGE` · `403` · `404 GROUND_NOT_FOUND` |
| `GET /admin/closures` | admin, manager | `page`, `limit` | `200 { data: Closure[], total, page, limit }`, newest first, lifted ones included | — |
| `DELETE /admin/closures/:id` | **admin** | — | `200 { unblocked }` | `404 CLOSURE_NOT_FOUND` · `409 CLOSURE_ALREADY_LIFTED` |
| `GET /closures` | public | `from`, `to` (at most 92 days) | `200 [{ fromDate, toDate, groundIds, label }]` | `400` |

- **The closure object:** `{ id, fromDate, toDate, groundIds, reason, note, publicLabel, createdBy, createdAt, liftedAt, liftedBy }`. `liftedAt` is `null` while it's in force.
- **Booked slots** are skipped and counted in `skippedBooked`, until the bookings module can cancel them.
- **Lifting** frees only the upcoming slots this closure blocked. Slots blocked separately stay blocked. The closure is kept for history with `liftedAt` set.
- **Customers:** closed days return `[]` from `GET /grounds/:id/slots`. Use `GET /closures` to show a reason, such as "Closed for Eid" (`label` is `publicLabel`, or `"Closed"`). The staff `note` and `reason` are never public.
- **In slot history**, closures show as `close` and `reopen` events. Slots generated already blocked by a closure have no event of their own: the closure is their record.

### Slot settings (`/api/v1/admin/settings/slots`)

| Method | Who | Body | Success |
|---|---|---|---|
| `GET` | admin, manager | — | `200 Settings` |
| `PUT` | **admin** | Any subset of the fields below | `200 Settings` |

| Field | Type | Default | Meaning |
|---|---|---|---|
| `advanceBookingDays` | int 1–365 | 30 | How far ahead customers can book, and how far slots are generated |
| `autoGenerate` | boolean | `true` | Turns the generation job on or off (it runs at startup and then hourly) |
| `cancellationCutoffHours` | int 0–72 | 2 | Customers can't book or cancel inside this window |
| `notifyCustomerOnBlock` | boolean | `true` | Stored now; emails start when SendGrid lands |
| `notifyAdminOnBooking` | boolean | `false` | Stored now; emails start when SendGrid lands |

Remove these from the settings page: **buffer minutes** (slots always start on the hour), **partial payments** (v1 uses Stripe Checkout only), and **peak hours, peak and off-peak prices and default slot length** (they're ground fields; link to the ground's edit page instead). Also drop the **30 min** and **Custom** slot lengths everywhere: the length comes from the ground, 60 or 120.

### When a ground's schedule changes

`PATCH /admin/grounds/:id` that changes hours, slot length, prices, days or `isActive` also replaces that ground's **future free** slots (available and never booked). Booked and blocked slots are never touched. The response then includes:

```json
"slotSync": { "removed": 40, "generated": 20, "kept": 2 }
```

Show something like "20 slots regenerated; 2 booked or blocked slots kept as they were." `slotSync` is missing when nothing slot-related changed.

---

## 5. Frontend changes to make

### 5.1 Login page: `src/app/(admin)/login/page.tsx`

Replace the demo login with a real API call.

**Remove:**
- `DEMO_CREDENTIALS` and the "Demo / Pass" hint box
- The role selector: the `roles` array, `selectedRole`, `handleRoleChange`, and the role buttons. Base the button label and colours on a single theme instead of the selected role.
- `attempts`, the client-side lock logic, and the 5-dot attempt indicator
- `document.cookie = ...`: the real cookie comes from the API
- The `setTimeout` fake delay

**Replace `handleLogin` with:**

```ts
async function handleLogin() {
  setError("");
  setLoading(true);
  try {
    const res = await fetch("/api/v1/admin/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const json = await res.json();
    if (!json.success) {
      setError(json.details?.[0]?.message ?? json.error);
      setLocked(json.code === "TOO_MANY_ATTEMPTS");
      return;
    }
    router.push(searchParams.get("from") ?? "/dashboard");
  } catch {
    setError("Cannot reach the server. Please try again.");
  } finally {
    setLoading(false);
  }
}
```

Notes:
- `searchParams` comes from `useSearchParams()`. A client page that uses it must be wrapped in a `<Suspense>` boundary.
- Only redirect to `from` if it starts with `/`, to avoid open redirects.
- After a `429`, unlock again after about 60 seconds, for example with a `setTimeout` that calls `setLocked(false)`.
- The CLAUDE.md rule "forms use react-hook-form + Zod" still applies, so use it if you're refactoring the form anyway.
- Update the footer and left-panel text: drop "Auto-lock after 5 failed attempts", and replace the Super Admin, Manager and Attendant capability list with Admin and Manager.

### 5.2 Handle `401` globally: `src/lib/api.ts`

```ts
api.interceptors.response.use(undefined, (err) => {
  if (err.response?.status === 401 && typeof window !== "undefined") {
    window.location.href = `/login?from=${encodeURIComponent(window.location.pathname)}`;
  }
  return Promise.reject(err);
});
```

Do the same in `src/lib/api-client.ts`: in `request()`, check `res.status === 401` before throwing.

### 5.3 Logout

Wherever the logout button lives (dashboard header or sidebar):

```ts
await fetch("/api/v1/admin/auth/logout", { method: "POST" });
router.push("/login");
router.refresh();
```

Also clear React Query's cache on logout (`queryClient.clear()`), so the next user can't see the previous user's data.

### 5.4 Current user

Add a `useMe()` hook, for example `src/hooks/useMe.ts`:

```ts
export interface AdminUser { id: string; email: string; name: string; role: "admin" | "manager"; }

export function useMe() {
  return useQuery<AdminUser>({
    queryKey: ["auth", "me"],
    queryFn: async () => (await api.get("/admin/auth/me")).data.data,
    retry: false,
  });
}
```

Use it to show the name and role, and to hide admin-only UI from managers. Hiding UI is only cosmetic: **the API enforces roles regardless.**

### 5.5 Route protection: `src/middleware.ts`

Leave it as it is. It redirects to `/login` when there's no `admin_token` cookie. That's enough because the API verifies the token on every request, and the 401 handler in 5.2 covers expired sessions.

- **Don't verify the JWT in the frontend.** The frontend doesn't have, and shouldn't have, `JWT_SECRET`. Remove that `TODO` comment.
- **Next 16 renames `middleware.ts` to `proxy.ts`.** The old name still works, with a deprecation warning, so rename it when convenient.

### 5.6 Server Components that call the API

Server-side code can't use the relative `/api/v1` path, and doesn't send the browser's cookie automatically. Forward the cookie yourself:

```ts
import { cookies } from "next/headers";

const res = await fetch(`${process.env.API_PROXY_TARGET}/api/v1/admin/auth/me`, {
  headers: { cookie: (await cookies()).toString() },
  cache: "no-store",
});
```

---

## 6. Checklist

- [ ] `rewrites()` added to `next.config.mjs`
- [ ] `.env.local` and `.env.example` updated (`NEXT_PUBLIC_API_URL=/api/v1`, `API_PROXY_TARGET`)
- [ ] Login page calls the real API; demo credentials, role picker, client lock and fake cookie removed
- [ ] Global 401 redirect in `api.ts` and `api-client.ts`
- [ ] Logout calls the API and clears the React Query cache
- [ ] `useMe()` used for the header name and role
- [ ] "Change password" form for every signed-in user (`POST /admin/auth/change-password`)
- [ ] Users page for admins: list with search, create, edit, deactivate, reset password; hidden for managers
- [ ] Grounds page uses `/admin/grounds` (create and edit for admins only); portal ground list and detail use `/grounds`; mock `src/app/api/grounds` routes removed
- [ ] Ground form: enable the sport, format, surface, dimensions, capacity, amenities, days, peak pricing, slot length, portal visibility and notes inputs; photo picker uses the photo endpoints
- [ ] Portal: hardcoded reviews and ratings removed
- [ ] Slots → All slots and Blocked use `GET /admin/slots` (server-side filters, `stats` for the cards); block and unblock call the API; "Unblock all today" calls `POST /admin/slots/unblock`
- [ ] Generate form: `POST /admin/slots/generate` with `dryRun` for the preview; overwrite option, custom times and 30-min/custom lengths removed
- [ ] Block form: the slot list comes from `GET /admin/slots?groundId&date`; it sends `type`, `date`, `weekdays`, `untilDate`, `reason` and `note`
- [ ] Slot settings page loads and saves `/admin/settings/slots`; buffer, partial payments and pricing fields removed
- [ ] Bookings calendar uses `GET /admin/slots/calendar`; `DAILY_SLOTS` removed
- [ ] Portal slot picker uses `GET /grounds/:id/slots`; fake availability removed
- [ ] Ground edit form shows the `slotSync` message after saving schedule changes
- [ ] Slot list checkbox actions use `POST /admin/slots/bulk` and show per-id failures
- [ ] Slot detail shows `GET /admin/slots/:id/history`; an activity page can use `GET /admin/slot-events`
- [ ] Closures page (admin): create, list and lift; the portal shows `GET /closures` labels on closed days
- [ ] **Manual test:**
  - [ ] Wrong password shows "Invalid email or password"
  - [ ] Correct login reaches `/dashboard`
  - [ ] Refresh keeps you signed in
  - [ ] Logout returns you to `/login`
  - [ ] Visiting `/dashboard` while logged out redirects to `/login`
  - [ ] 6 quick wrong attempts show the "Too many login attempts" message

---

## What's not available yet

These endpoints don't exist in `turf-api` yet. Keep the current mock data for these pages until they ship:

- PDF receipts. (Reports are live: see [`docs/frontend-reports.md`](frontend-reports.md). My bookings and customer sign-in: see `docs/frontend-bookings.md` §2a.)

The frontend's mock data differs from the API in places. When switching a page to the real API, map the fields like this:

| Frontend mock today | API (v1) |
|---|---|
| `pricePerHour` | `hourlyPrice`, an integer in the smallest currency unit (`1500` = 15.00) |
| `openingTime: "06:00"`, `closingTime: "23:00"` | `openingHour: 6`, `closingHour: 23` (whole hours) |
| `type` | `sport` |
| `size` | `dimensions` |
| `peakPricing: { pricePerHour, from, to }` | `peakPrice` + `peakRanges: [{ fromHour, toHour }]` |
| `offPeakPricing` | `hourlyPrice` (the off-peak price whenever `peakPrice` is set) |
| `todayBookings` | Comes with the bookings module |
| `rating`, `reviewCount`, reviews | **Not in v1. Remove the hardcoded reviews from the portal** |
| `branchId` | Not in v1: no multi-branch |
| Roles `super_admin`, `manager`, `attendant` | Roles `admin`, `manager` |

This guide will be updated as each module lands.
