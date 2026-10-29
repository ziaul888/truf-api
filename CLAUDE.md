# CLAUDE.md — Turf API (Champions Turf backend)

## Project Overview
REST API for the turf booking platform — v1.0.
Frontend lives in a separate repo (`turf-admin`, Next.js) and calls this API at `/api/v1`.
Stack: NestJS 12 (Express) · TypeScript (ESM) · PostgreSQL · Prisma · Stripe · SendGrid · Zod · Vitest

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

## Business rules (v1)
- Slots are 60 or 120 minutes (per ground, `slotDurationMinutes`), generated from opening/closing hours; a trailing partial slot is dropped
- Slots are stored rows, venue-local (`VENUE_TIMEZONE`, default Asia/Dhaka): a `date` plus whole hours, never UTC timestamps; weekends are Sat–Sun. Helpers live in `slots/venue-time.ts`
- Slots are generated up to `advanceBookingDays` ahead (hourly job + on ground create); generation never overwrites a stored slot. Ground schedule edits replace only future free slots — booked and blocked slots are never touched
- Venue closures (`Closure`) block the free slots in their range and are applied to slots generated later; lifting one frees only the blocks it made (`Slot.closureId`)
- Every block/unblock is logged in `SlotEvent`; slot status is only `available` | `held` | `booked` | `blocked` (payment state lives on the booking)
- No double-booking: take a slot with a conditional update (`where status = 'available'`) inside a transaction; `Booking.liveSlotId` (unique, cleared on cancel) is the database-level guard
- Admin-blocked slots are never bookable by customers
- Portal customers may instead choose cash at the venue (`payAtVenue`, setting `portalCashEnabled`): the slot is booked, the booking stays pending and unpaid until staff confirm it
- Portal card bookings pay in full through Stripe Checkout: checkout holds the slot (`held`, `holdMinutes`), the webhook confirms it, a sweep job releases lapsed holds. Portal bookings add the `serviceFee` setting, stored per booking
- Staff bookings (dashboard) may record `cash` or `bank_transfer`, in full, as an advance with a due date (partial), or not yet paid (pending). No UPI or wallets
- Customers may sign in with phone + SMS code (Twilio Verify, `customer_token` cookie keyed on the verified phone; login is optional, guest checkout stays). Signed in, checkout books on the verified phone and "My bookings" lists every booking for it. Every booking also has a signed link (`bookingToken`) to view, cancel and pay
- Every booking state change goes through `BookingCancellationService` / `StaffBookingsService` actions and writes a `BookingEvent`; never PATCH a status directly
- Cancellation = full refund to the original payment method: card via Stripe (502 `REFUND_FAILED` leaves the booking unchanged), cash and bank transfer marked refunded
- Per-ground hourly price, plus an optional peak price for set hour ranges (`peakPrice` + `peakRanges`); a slot's price is summed hour by hour (`slotPrice` in `grounds/ground-schedule.ts`)
- No other dynamic pricing, coupons, SMS (beyond sign-in codes), wallets, reviews or multi-branch

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
