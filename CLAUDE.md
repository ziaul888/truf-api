# CLAUDE.md — Turf API (Champions Turf backend)
## Project Overview
REST API for the turf booking platform — v1.0.

Frontend lives in a separate repo (`turf-admin`, Next.js) and calls this API at `/api/v1`.

Stack: NestJS 12 (Express) · TypeScript (ESM) · PostgreSQL · Prisma · Stripe · SendGrid · Zod · Vitest

## Senior Engineering & Agent Workflow

- Act as a senior NestJS/TypeScript engineer: prioritize correctness, readability, maintainability, and secure defaults.
- Before editing, inspect the relevant module, current Git branch/status, existing contracts, and related tests.
- Plan nontrivial changes, identify affected endpoints and migrations, then implement the smallest coherent change.
- Keep controllers thin and services focused; reuse existing modules, Zod schemas, DTOs, helpers, and error conventions.
- Follow the existing ESM `.js` relative-import convention and use the installed Yarn scripts.
- Protect concurrency-sensitive booking operations with atomic conditional writes and database constraints; preserve idempotency for payment/webhook actions.
- Never expose secrets, modify production data, or run destructive migrations without explicit approval.
- Verify changed code with relevant lint, unit tests, e2e tests, and build where available; report any skipped checks.
- Review `git diff` before completion. Never commit or push without explicit approval.

## Frontend Coordination (Minimal)

- Frontend is a separate sibling repository at `../turf-admin`.
- This backend owns API contracts and business logic; coordinate changes to `/api/v1` consumers when necessary.
- For cross-repository changes, read `../turf-admin/CLAUDE.md` before editing frontend code, if the directory is accessible.
- Check Git status and report verification separately for each changed repository.

## Architecture
```

src/

├── main.ts                 # Bootstrap only — wiring lives in app.setup.ts

├── app.setup.ts            # Global prefix, Helmet, CORS, cookies, filter, interceptor

├── app.module.ts           # Imports every feature module

├── config/env.ts           # Zod-validated env vars — import `env`, never read process.env elsewhere

├── common/                 # Cross-cutting pieces shared by all modules

│   ├── app-error.ts        # Throw for known, user-facing failures

│   ├── api-response.ts     # { success, data } / { success: false, error } types

│   ├── filters/            # AllExceptionsFilter → error envelope

│   ├── interceptors/       # ResponseInterceptor → success envelope

│   └── pipes/              # ZodValidationPipe

└── <feature>/              # One folder per domain: auth, grounds, slots, bookings, …

    ├── <feature>.module.ts

    ├── <feature>.controller.ts   # Thin: validate → call service → return data

    ├── <feature>.service.ts      # All business logic

    ├── <feature>.schemas.ts      # Zod schemas + inferred input types

    └── <feature>.service.spec.ts

test/                       # e2e tests (Supertest) — *.e2e-spec.ts

```

## Conventions
- ESM: relative imports end in `.js` (e.g. `./auth.service.js`), even from `.ts` files

- Named exports only; `kebab-case.ts` files; max 300 lines per file, 40 per function

- Controllers stay thin — no Prisma or Stripe calls in controllers

- Validate every body, query and param with `ZodValidationPipe` and a schema from `<feature>.schemas.ts` (no class-validator)

- Controllers return plain data; `ResponseInterceptor` wraps it as `{ success: true, data }`

- Known failures: `throw new AppError(message, status, CODE)`; `AllExceptionsFilter` formats every error and hides unknown ones behind a 500

- List endpoints return `{ data, total, page, limit }` (the interceptor wraps that as `data`)

- Never return Prisma models directly — map to a DTO; never return password hashes, secrets or tokens

- Never log passwords, card data or tokens

- Uploaded files go to `UPLOAD_DIR` (local disk) and are served at `/api/v1/uploads`; check file type by magic bytes, never trust the client's MIME type

## API rules
- Everything is under `/api/v1`; dashboard endpoints under `/api/v1/admin`

- Status codes: 200 · 201 · 400 · 401 · 403 · 404 · 409 · 429 · 500 (502 when Stripe fails)

- Staff auth: JWT in an httpOnly `admin_token` cookie; roles `admin` and `manager` only. Customer auth: separate `customer_token` (`/api/v1/customer/*`)

- The frontend proxies `/api/v1/*` to this server, so cookies stay first-party

## Database (Prisma)
- Always `prisma migrate dev` — never edit the DB by hand

- Use `$transaction` for anything that must be atomic (booking + slot status)

- Soft-delete bookings, payments, customers (`deletedAt`) — never hard-delete

- Index `groundId`, `date`, `status`; no raw SQL

- "No raw SQL" means queries. Migration DDL Prisma can't express may be hand-written in the migration, with a schema comment pointing to it (e.g. the partial unique index on `Payment(method, reference)`)

- Before committing a migration, run `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` against the test DB and make sure it doesn't drop `Payment_method_reference_key`

## Business rules (v1)
- Slots are 60, 90 or 120 minutes (per ground, `slotDurationMinutes`), generated from whole opening/closing hours in steps of that length; a trailing partial slot is dropped. 90-minute slots start on the half hour too (`startHour` + `startMinute` 0/30; DTOs add `startMinute`, `endMinute`, `startTime`/`endTime` "HH:MM"); time checks go through `slotHour()` (`slots/slot-time.ts`), and prices are summed per half hour (half the hourly or peak price; peak ranges stay whole hours)

- Slots are stored rows, venue-local (`VENUE_TIMEZONE`, default Asia/Dhaka): a `date` plus start hour and minute, never UTC timestamps; weekends are Fri–Sat, weekdays are Sun–Thu. Helpers live in `slots/venue-time.ts`

- Slots are generated up to `advanceBookingDays` ahead (hourly job + on ground create); generation never overwrites a stored slot. Ground schedule edits replace only future free slots — booked and blocked slots are never touched

- Venue closures (`Closure`) block the free slots in their range and are applied to slots generated later; lifting one frees only the blocks it made (`Slot.closureId`)

- Every block/unblock is logged in `SlotEvent`; slot status is only `available` | `held` | `booked` | `blocked` (payment state lives on the booking)

- No double-booking: take a slot with a conditional update (`where status = 'available'`) inside a transaction; `Booking.liveSlotId` (unique, cleared on cancel) is the database-level guard; `BookingSlot.liveSlotId` (unique, `BookingSlot_liveSlotId_key`) is the same guard for each slot of a multi-slot booking

- One booking can hold up to 4 slots (`MAX_SLOTS_PER_BOOKING`, `bookings/booking-limits.ts`, sent as `maxSlotsPerBooking` in `GET /checkout/options`) of ONE ground and ONE date, consecutive or not, in `BookingSlot` rows; `Booking.slotId` / `liveSlotId` are the earliest ("primary") one. One booking number and one payment; `Booking.amount` is the sum of the slots' prices and the service fee is charged once (`total = amount + serviceFee`). Portal checkout takes `slots: [{ hour, minute? }]` (or the old single `hour`), staff booking `slotIds` (or the old `slotId`); `400 TOO_MANY_SLOTS`, `400 SLOTS_MUST_SHARE_GROUND_DATE`. All the slots are taken with ONE conditional update and the count must match, else the whole transaction rolls back (`409 SLOT_NOT_AVAILABLE`); a card payment confirms all of them or none (a late payment with any slot gone is refunded). Cancelling is all or nothing: it releases every slot and refunds as for one slot (no per-slot cancel, no partial refund); staff blocking one slot of a multi-slot booking cancels the whole booking and only that slot ends blocked. Time rules: the customer cutoff counts from the first live slot's start, "ended" is the last live slot's end (`bookings/booking-slots.ts`). Repeat bookings stay single-slot but still write one `BookingSlot` row per booking. Open-unpaid limit counts a booking as 1

- Admin-blocked slots are never bookable by customers

- New bookings on a day the ground is closed are refused for customers and staff (`400 GROUND_CLOSED`); existing bookings on such days stay and can be cancelled

- Portal customers may instead choose cash at the venue (`payAtVenue`, setting `portalCashEnabled`): the slot is booked, the booking stays pending and unpaid until staff confirm it

- Portal customers may also pay by bKash or Nagad, manually: offered only while the admin has set that number (`bkashNumber` / `nagadNumber` in slot settings) and left it switched on (`portalBkashEnabled` / `portalNagadEnabled`; off keeps the number). Card likewise needs `portalCardEnabled` as well as the Stripe keys; a card checkout already started can still finish, but "Pay now" on the booking link goes (`src/bookings/portal-methods.ts`). The customer sends the total (service fee included) to the number and enters the TrxID and the number they sent from. The slot is booked, the booking stays pending with a `pending` payment (`reference` = TrxID, `payerNumber`) until staff check their own bKash / Nagad app: Verify (confirm) marks it succeeded, Reject (cancel, `rejectWalletPayment`) marks it failed and frees the slot (allowed even after the slot ended). Verify and Reject are race-safe: one wins, the other gets 409. No bKash / Nagad API, no paying a due by wallet through the booking link. A TrxID is unique per method among payments that aren't failed or deleted (`409 REFERENCE_ALREADY_USED`; a rejected TrxID can be reused). These bookings are never card checkouts (`CARD_CHECKOUT_IN_PROGRESS`, `ABANDONED_CHECKOUT` exclude them) and, while under review (`WALLET_UNDER_REVIEW`), never money owed: no dues, reminders, digest or customer due amounts, and no collecting payment (`409 PAYMENT_UNDER_REVIEW`). The customer can't cancel directly then; before the cutoff they can send a cancel request (`cancelRequestedAt`, staff emailed), and staff verify and cancel with a refund, or reject. Staff can only Reject an unverified payment, not cancel it otherwise (`409 VERIFY_OR_REJECT`)

- Portal cash, bKash and Nagad checkouts need a signed-in customer (`401 SIGN_IN_REQUIRED`); at most 3 open unpaid per phone (`409 TOO_MANY_OPEN_BOOKINGS`, `bookings/checkout-limits.ts`); `POST /checkout` is rate limited, 5 per 10 minutes per IP + phone (`429 TOO_MANY_ATTEMPTS`)

- Portal card bookings pay in full through Stripe Checkout: checkout holds the slot (`held`, `holdMinutes`), the webhook confirms it, a sweep job releases lapsed holds. Portal bookings add the `serviceFee` setting, stored per booking

- Staff bookings (dashboard) may record `cash`, `bank_transfer`, `bkash` or `nagad` (optional TrxID for the last two), in full, as an advance with a due date (partial), or not yet paid (pending). No UPI or other wallets

- Staff may make a repeat booking (`BookingSeries`, `src/booking-series/`): one ground and start hour on chosen weekdays, either a fixed range (at most 31 days, all booked at once) or ongoing (`untilDate` null: booked up to the slots that exist, then the hourly slot job books new dates as slots are generated, until staff stop it). Each date is its own normal staff booking (`seriesId` set), confirmed from the start, no due date, no customer emails. A busy date (booked, held, blocked, closed, ended, no slot) is recorded as a skip and never retried; nothing free → `409 NOTHING_TO_BOOK`. Two extend runs never book a date twice (compare-and-set on `bookedThrough`, conditional slot update)

- Repeat-booking money is shown per calendar month but recorded per booking: a payment is spread over the bookings earliest first, each up to its due (a TrxID goes on the first payment row only; `400 AMOUNT_EXCEEDS_DUE` above what's due). Stopping (`409 SERIES_STOPPED` if already stopped) cancels the bookings from a date on that haven't started, through `BookingCancellationService`, refunded or not as staff choose

- Customers may sign in with phone + SMS code (Twilio Verify, `customer_token` cookie keyed on the verified phone; login is optional for card, guest card checkout stays). Signed in, checkout books on the verified phone and "My bookings" lists every booking for it. Every booking also has a signed link (`bookingToken`) to view, cancel and pay

- Optional live test customer: `LIVE_TEST_PHONE` (one dedicated E.164 number) plus `LIVE_TEST_OTP` (8–10 digits), both backend env values, permit fixed-code login for that number only, including production. Default off; normal customer sessions, rate limits and authorization still apply. Never expose the code to the frontend or logs. The global `TEST_OTP_CODE` remains forbidden in production. Setup and disabling: `docs/live-test-login.md`.

- Every booking state change goes through `BookingCancellationService` / `StaffBookingsService` actions and writes a `BookingEvent`; never PATCH a status directly

- Cancellation = full refund to the original payment method: card via Stripe (502 `REFUND_FAILED` leaves the booking unchanged), cash, bank transfer, bKash and Nagad marked refunded (paid back by hand). A bKash / Nagad payment not yet verified is marked failed instead

- Per-ground hourly price, plus an optional peak price for set hour ranges (`peakPrice` + `peakRanges`); a slot's price is summed half hour by half hour (`slotPrice` in `grounds/ground-schedule.ts`; an odd price over 90 minutes is rounded)

- Money due is overdue once its `dueDate` has passed, or, with no due date, once the slot has started (completed bookings still count). Portal card checkouts still in Stripe are never "due" or "to confirm" (`booking-due.ts`)

- Settings (`src/settings/`): venue, website and notification sections are JSON in `SettingsSection`, validated by their Zod schema; slot settings keep their typed table. Admin + manager read, admin writes; every change is audited in `SettingsEvent` (field names only). Secrets (Stripe, SendGrid, Twilio) stay in env and are only ever reported as configured/not. Confirmation and cancellation emails always send when the booking has an email; a customer's email is optional (phone is the key), and with none, customer emails are skipped. No data wipe or backup endpoints

- Reports (`/admin/reports`, admin + manager): revenue is dated by when money moved (payments received, by `Payment.receivedAt` with `createdAt` for older rows, minus refunds by `refundedAt`, as the dashboard does; a bKash / Nagad payment is received when staff verify it), bookings by slot date; abandoned card checkouts never count; weeks start on Saturday; exports are CSV only

- No other dynamic pricing, coupons, SMS (beyond sign-in codes), wallets (beyond manual bKash / Nagad), reviews or multi-branch

## Deploy notes (multi-slot bookings)
- Keep `MULTI_SLOT_BOOKINGS_ENABLED=false` (the default) throughout the rollout. Both booking services enforce a limit of 1 and `GET /checkout/options` reports 1. Docker runs migration `20261112090000_booking_slots` automatically before starting the new API. Existing multi-slot bookings can still be read, paid and cancelled if this flag is later turned off; it only limits new bookings.
- Roll out the backend with that flag off. Stop/drain **every** old API instance and its jobs: the old code knows nothing of `BookingSlot`, so it would confirm, cancel or release only a multi-slot booking's primary slot. Frontend single-slot requests use legacy `startHour`/`startMinute` or `slotId`, and missing capabilities mean a limit of 1, so the compatible frontend may deploy in either order while the gate stays off.
- Once no old instance is running, run `yarn db:reconcile:booking-slots` in the new container, using its normal production environment. This executes `prisma/rollouts/booking-slots.sql`, in one transaction, and is safe to repeat. It clears cancelled bookings' stale live indexes **before** inserting missing rows: an old instance may have rebooked a slot, so INSERT-first can hit a unique-index collision. Table locks keep booking writes out of this short repair transaction. Do not run this repair automatically on container startup, while old instances might still write.
- After reconciliation succeeds, set `MULTI_SLOT_BOOKINGS_ENABLED=true` on every new API instance. Verify `/api/v1/checkout/options` reports `maxSlotsPerBooking: 4`; frontend capability caches refresh within 60 seconds. Never roll back to a pre-multi-slot backend while multi-slot bookings exist; turn the flag off and keep the new readers/actions instead.
- Until reconciliation, booking paths (including repeat booking creation/extension) self-heal stale rows with `releaseStaleBookingSlots`; readers ignore live BookingSlot rows belonging to cancelled bookings.
- Before committing: use only the isolated test DB for `NODE_ENV=test yarn prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` and `yarn test:e2e`. Ensure the diff does not change `Payment_method_reference_key`. Never run these checks against the app/production DB.

## Testing
- Unit test every service (70% coverage target); e2e every endpoint with Supertest

- e2e tests call `configureApp()` so they run with the same prefix, filter and interceptor as production

- Mock Stripe and SendGrid; use a separate test database

## Commands
```bash

yarn start:dev        # Dev server with watch (port 4000)

yarn build            # Compile to dist/

yarn test             # Unit tests

yarn test:e2e         # e2e tests

yarn test:cov         # Coverage

yarn lint             # oxlint

```

## When in doubt — ask before implementing. Keep it simple. Ship v1 first.
