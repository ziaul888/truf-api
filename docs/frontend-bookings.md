# turf-api update: bookings, checkout, customers, dashboard

**For:** turf-admin (frontend). **Date:** 29 Oct 2026.

This implements the "Bookings API" spec, including items 1 and 2 of "Ground & Slot Next Steps" (the checkout hold, and connecting bookings to slots). Everything below is live and covered by e2e tests, with Stripe and email mocked.

Conventions are unchanged from `docs/frontend-integration.md`:
- Every response uses the `{ success, data }` / `{ success: false, error, code, details }` envelope.
- Money is in the **smallest currency unit**: `150000` is ৳1,500.00.
- Dates are venue-local `"YYYY-MM-DD"` strings and hours are whole numbers.
- Paginated lists return `{ data, total, page, limit }`.

---

## 0. Decisions that shape the UI

| Topic | What shipped |
|---|---|
| Walk-in / phone bookings | Staff can book and record **cash**, **bank transfer**, **bKash** or **Nagad** (with an optional TrxID) |
| Portal payment | Customers choose **card** (Stripe, confirmed on payment), **cash at the venue** (pending until staff confirm), or **bKash / Nagad** (they send the total to the venue's number and enter the TrxID; pending until staff verify it in their own app). Admins can switch cash off with `portalCashEnabled`; bKash / Nagad are offered only while their number is set (`bkashNumber`, `nagadNumber`) |
| Partial payments | **Staff bookings only:** an advance plus an optional due date and note. Collect the rest later |
| Who confirms | Portal bookings confirm **automatically** when Stripe payment succeeds. The review queue (`status=pending`) holds staff bookings that aren't paid yet |
| How customers see bookings | Each booking has a signed link: `/confirmation/{id}?token=…`. Customers can also **sign in with their phone (SMS code)** to see **My bookings** (§2a). Login is optional for card: guest card checkout stays. Cash, bKash and Nagad need sign-in (§2) |
| Service fee | Comes from settings (`serviceFee`, default `5000` = ৳50), portal bookings only, and is stored on each booking. **Remove the hardcoded ৳50** and use `serviceFee` / `total` from the API |
| Payment methods | `card`, `cash`, `bank_transfer`, `bkash`, `nagad`. **Remove UPI** |
| Completed | A confirmed booking becomes `completed` automatically after its slot ends, and can no longer be cancelled |
| Receipt | **No PDF receipt in v1.** Remove or hide the Receipt button |

---

## 1. Statuses

| Field | Values |
|---|---|
| `status` (booking) | `pending` · `confirmed` · `cancelled` · `completed` · `no_show` |
| `paymentStatus` | `unpaid` · `partial` · `paid` · `refunded` · `failed` |
| Slot `status` | `available` · **`held`** (new: a customer is in Stripe checkout) · `booked` · `blocked` |
| Payment `method` | `card` · `cash` · `bank_transfer` · `bkash` · `nagad` |
| Booking `source` | `portal` · `staff` |

How they move together:

| Event | Booking | Payment status | Slot |
|---|---|---|---|
| Portal checkout started (card) | `pending` | `unpaid` | `held` (15 min) |
| Portal booking, pay at venue (cash) | `pending` | `unpaid` | `booked` |
| Portal booking, bKash / Nagad (payment `pending`) | `pending` | `unpaid` | `booked` |
| Staff verify the bKash / Nagad payment (payment `succeeded`) | `confirmed` | `paid` | `booked` |
| Staff reject it, or anyone cancels before verify (payment `failed`) | `cancelled` | `failed` | `available` |
| Stripe payment succeeded | `confirmed` | `paid` | `booked` |
| Hold lapsed / session expired | `cancelled` | `unpaid` | `available` |
| Staff booking, paid in full | `confirmed` | `paid` | `booked` |
| Staff booking, advance only | `confirmed` | `partial` | `booked` |
| Staff booking, not paid | `pending` | `unpaid` | `booked` |
| Cancelled with refund | `cancelled` | `refunded` | `available` |
| Staff block with `cancelBooking: true` | `cancelled` | `refunded` | `blocked` |
| Slot ended | `completed` | unchanged | `booked` |
| Staff mark no-show (slot started) | `no_show` | unchanged (an advance stays as revenue; the rest of the due is written off) | `booked` |
| Staff undo the no-show | `completed` if the slot ended, else `confirmed` | unchanged (the due comes back) | `booked` |

---

## 2. Portal (customers; sign-in only for cash, bKash and Nagad)

### `GET /api/v1/checkout/options`

```json
{ "cardEnabled": true, "cashEnabled": true, "wallets": [{ "method": "bkash", "number": "+8801700000000" }], "serviceFee": 5000, "currency": "bdt", "holdMinutes": 15 }
```
- **Load this on the checkout page.**
  - Show the card option only when `cardEnabled` is true: it needs both the Stripe key and the webhook secret. Otherwise `POST /checkout` with `card` returns `400 CARD_NOT_AVAILABLE`, and `canPay` is false on every booking.
  - Show the "Pay at venue (cash)" option only when `cashEnabled` is true.
  - Show a bKash / Nagad option for each entry in `wallets` (only the ones the admin has set a number for). Choosing one shows "Send ৳{total} to {number}", where the total includes the service fee, plus two required fields: the TrxID and the number the money was sent from.
  - Show the fee from `serviceFee`, not a hardcoded ৳50.

### `POST /api/v1/checkout`

```json
{ "groundId": "uuid", "date": "2026-11-02", "hour": 18, "customerName": "Rakib Hasan", "customerEmail": "rakib@example.com", "customerPhone": "01711000000", "paymentMethod": "card" }
```

- **`paymentMethod`:** `"card"` (the default), `"cash"`, `"bkash"` or `"nagad"`.
- **`reference`** (the TrxID) and **`payerNumber`** (the number the money was sent from): required for `bkash` and `nagad`, and refused (`400 VALIDATION_FAILED`) with `card` or `cash`. The TrxID is trimmed and uppercased, and must be 6–20 letters and digits; the number is any common phone format.
- **Response:** `{ bookingId, paymentMethod, checkoutUrl, confirmationUrl }`.
- **Cash, bKash and Nagad need a signed-in customer** (phone + SMS code, §2a): they book the slot with no money taken. A guest gets `401 SIGN_IN_REQUIRED` before anything is reserved; show a sign-in link that returns to the checkout. Card checkout stays open to guests.
- **At most 3 open unpaid portal bookings per phone:** pending cash bookings and bKash / Nagad bookings still being verified, whose slot hasn't started yet. Card checkouts don't count. A 4th is `409 TOO_MANY_OPEN_BOOKINGS` (nothing is reserved): the customer pays or cancels one first, or pays by card. Two requests at the very same moment may both get through; that's accepted.
- **Rate limit:** 5 checkouts per 10 minutes per IP + phone (the signed-in phone, else `customerPhone`), refused ones included. Then `429 TOO_MANY_ATTEMPTS`.
- **Card:** redirect to `checkoutUrl`, which is Stripe.
- **Cash:**
  - `checkoutUrl` is `null`. Go straight to `confirmationUrl`.
  - The slot is reserved, and the booking is `pending` with `payAtVenue: true` until staff confirm it. The customer gets a "booking received, pay at the venue" email with their link.
  - On the confirmation page, show "Reserved: waiting for confirmation. Pay ৳{total} in cash at the venue". Don't poll.
  - `400 CASH_NOT_AVAILABLE` when the setting is off.
- **bKash / Nagad:**
  - `checkoutUrl` is `null`. Go straight to `confirmationUrl`.
  - The slot is booked, the booking is `pending` (`payAtVenue: false`) and has a `pending` payment of the full total with the TrxID. The customer gets a "booking received" email saying the venue will verify the payment and confirm.
  - On the confirmation page, show "Payment received: the venue will verify it and confirm your booking". `walletPayment.status` is `pending` until then. Don't poll. Don't show an amount "due" or "to pay" meanwhile: the money isn't owed, it's being checked.
  - While it's under review the customer **can't cancel directly** (`canCancel` is false, `POST /cancel` is `409 PAYMENT_UNDER_REVIEW`). Before the cancellation cutoff they can **ask** the venue to cancel instead: see `POST /bookings/:id/cancel-request`.
  - `400 WALLET_NOT_AVAILABLE` when that wallet's number isn't set.
  - `409 REFERENCE_ALREADY_USED` when the TrxID is already on a pending or verified payment of that method (nothing is booked). A TrxID from a rejected payment can be used again.

- **`hour`:** the existing form posts `hour`, and `startHour` is accepted too.
- **Phone:** any common format; the API normalises it.
- **`201 { bookingId, checkoutUrl }`:** do `window.location.href = checkoutUrl`. The slot is held for 15 minutes.
- **Errors:**
  - `409 SLOT_NOT_AVAILABLE`: just taken. Refresh the picker.
  - `400 OUTSIDE_BOOKING_WINDOW`: beyond the booking window, or within 2 hours of the start.
  - `400 SLOT_IN_PAST`.
  - `400 GROUND_CLOSED`: the ground doesn't open that day.
  - `404 GROUND_NOT_FOUND`.
  - `401 SIGN_IN_REQUIRED`: cash, bKash or Nagad without a signed-in customer.
  - `409 TOO_MANY_OPEN_BOOKINGS`: already 3 open unpaid bookings on the phone.
  - `429 TOO_MANY_ATTEMPTS`: more than 5 checkouts in 10 minutes. Ask them to wait a few minutes.
  - `502 PAYMENT_PROVIDER_ERROR`: Stripe is unavailable or not configured. Show `error`.
- **Return URLs:**
  - On payment success, Stripe sends the customer to `{PUBLIC_APP_URL}/confirmation/{bookingId}?token=…`.
  - Cancelling at Stripe returns them to `/grounds/{groundId}`.

### `GET /api/v1/bookings/:id?token=…`: the confirmation page

Returns the public booking. `404 BOOKING_NOT_FOUND` without a valid token.

```json
{
  "id": "uuid", "bookingNumber": "CT-24A7F", "status": "confirmed", "paymentStatus": "paid",
  "ground": { "id": "uuid", "name": "Green Arena", "sport": "football", "format": "5x5", "address": "…", "coverPhoto": "/api/v1/uploads/…" },
  "slot": { "date": "2026-11-02", "startHour": 18, "endHour": 19 },
  "payAtVenue": false,
  "walletPayment": null,
  "amount": 150000, "serviceFee": 5000, "total": 155000, "paid": 155000, "due": 0,
  "createdAt": "…", "cancelledAt": null, "canCancel": true, "canPay": false,
  "cancelRequested": false, "canRequestCancel": false
}
```

- **`status: "no_show"`**: staff marked that the team didn't turn up. Show "No-show"; `due` is 0 and `canCancel`, `canPay` and `canRequestCancel` are all false. "My bookings" lists it under `past`.
- **Right after the Stripe redirect,** the webhook may not have arrived yet, so `status` can still be `pending`. Poll every 2 seconds for up to about 20 seconds, showing "Confirming your payment…", until it's `confirmed`.
- **Replace the hardcoded confirmation page** with this data.
- **`walletPayment`** is set when the customer paid by bKash / Nagad: `{ method, amount, reference, status }`. `status: "pending"` means the venue is still verifying it; `canPay` is false meanwhile.

### `POST /api/v1/bookings/:id/pay?token=…`: the "Pay now" button

- **When to show it:** when `canPay` is true, which means the booking has something `due`. That covers:
  - a pay-at-venue booking the customer would rather pay online;
  - an unpaid staff booking;
  - the rest after an advance.
- **What to show:** the amount, from `due` ("Pay ৳{due} now").
- **Returns** `{ bookingId, paymentMethod: "card", checkoutUrl, confirmationUrl, amount }`. Redirect to `checkoutUrl`.
- **After payment,** Stripe returns the customer to the same confirmation page. Poll as above until `paid` goes up, or `due` reaches 0.
  - A **pending** booking that becomes paid in full is **confirmed automatically**, and the customer gets the confirmation email.
  - A part payment only updates `paid` and `due`.
- **Errors:**
  - `409 NOTHING_DUE`: already paid, or cancelled.
  - `409 PAYMENT_UNDER_REVIEW`: a bKash / Nagad payment is still being verified.
  - `400 CARD_NOT_AVAILABLE`: card payment is off (no Stripe key or webhook secret). The same applies to `POST /bookings/:id/checkout`.
  - `404` without a valid token.
  - `502 PAYMENT_PROVIDER_ERROR`.
- **A card checkout that's still in progress** gets its open Stripe page back, the same as `POST /bookings/:id/checkout`.
- **Paid twice by accident** (for example, also in cash at the counter): if money arrives when nothing is owed, it's refunded in full automatically, and the customer is emailed.

### `POST /api/v1/bookings/:id/cancel?token=…`
- **What it does:** full refund to the card, frees the slot and emails the customer. Returns the updated public booking.
- **When to show the button:** only when `canCancel` is true. That means portal bookings outside the cancellation cutoff (default 2 hours before the start), and not while a bKash / Nagad payment is under review.
- **Errors:**
  - `409 PAYMENT_UNDER_REVIEW`: a bKash / Nagad payment is being verified; offer "Request cancellation" instead
  - `400 CANCELLATION_WINDOW_PASSED`
  - `409 BOOKING_ALREADY_CANCELLED`
  - `409 BOOKING_COMPLETED`
  - `502 REFUND_FAILED`

### `POST /api/v1/bookings/:id/cancel-request?token=…`
- **When:** `canRequestCancel` is true: a portal bKash / Nagad payment is under review, no request was sent yet, and it's before the cancellation cutoff. Show "Request cancellation"; once sent, `cancelRequested` is true: show "Cancellation requested".
- **What it does:** records the request (`cancel_requested` event), emails staff (the Notifications page's recipients, or every active admin) and returns the updated public booking. The booking stays as it is: staff then **Verify and cancel with a refund** (paid back by hand; the customer gets the cancellation email with the refund) or **Reject** the payment.
- **Errors:** `404` without a valid token, `400 CANCELLATION_WINDOW_PASSED` (inside the cutoff, or not a portal booking), `409 CANCEL_ALREADY_REQUESTED`, `409 NOT_UNDER_REVIEW` (nothing is being verified: cancel directly).

### `POST /api/v1/bookings/:id/checkout?token=…`
"Complete payment" for a `pending` booking while its hold lasts. Returns `{ bookingId, checkoutUrl }`. Once the hold is gone it returns `409 BOOKING_NOT_PENDING`.

### Slot picker
- Held slots already come back as `available: false` from `GET /grounds/:id/slots`, so nothing changes there.

---

## 2a. Customer sign-in (phone + SMS code) and My bookings

Optional. Guests can still book, and signed links keep working. The session is an httpOnly **`customer_token`** cookie, separate from the staff `admin_token`, lasting 30 days (`CUSTOMER_SESSION_DAYS`). It goes through the same `/api/v1` proxy, so it stays first-party.

| Method & path | Body / query | Returns |
|---|---|---|
| `POST /customer/auth/send-code` | `{ phone }` (any common format) | `{ sent: true }`. An SMS with a 6-digit code, valid 10 minutes |
| `POST /customer/auth/verify` | `{ phone, code, name?, email? }` | Sets the cookie. Returns the session `{ phone, customerId, name, email, needsProfile }`. With `name` + `email`, a **new** number's customer record is created right away (a known customer's details are not changed) |
| `POST /customer/auth/profile` | `{ name, email }` (signed in) | The updated session. Creates the customer record for a new number, or updates name and email |
| `GET /customer/auth/me` | — | The session, or `401 UNAUTHENTICATED` when signed out. Call it on page load |
| `POST /customer/auth/logout` | — | `{ loggedOut: true }`. Clears the cookie and signs out **every device** |
| `GET /customer/bookings` | `scope` (`upcoming` default, or `past`), `page`, `limit` | `{ data, total, page, limit }`. Each item is the public booking (§2) plus `confirmationUrl` |

**Sign-in screen:**
1. Phone field → `send-code` → show the code field ("We sent a code to 01711…").
2. Code field → `verify` → go back to where they came from.
3. "Resend code" after 60 seconds.

**The session and new customers:**
- `needsProfile: true` means the number has no customer record yet (`customerId`, `name`, `email` are `null`).
- **Right after `verify`, if `needsProfile` is true, show a "Your name and email" step** and post it to `/customer/auth/profile`. That creates the customer, so they appear in the dashboard's Customers list straight away.
- Or collect name and email on the sign-in form and send them with `verify`. They're used only if the number is new.
- If neither happens, the first booking still creates the record.

**Checkout when signed in:**
- **Prefill** name, email and phone from `/customer/auth/me`, and make the phone **read-only**. The booking always goes on the verified phone, whatever is posted.
- The name and email posted update the customer's record. A guest checkout never changes it.

**My bookings page** (`/bookings/me`, which can come back now):
- Two tabs: Upcoming (soonest first) and Past (latest first, including cancelled and completed).
- Shows **every booking made with that phone**: guest bookings from before sign-in, and staff bookings.
- Abandoned card checkouts that were never paid are left out.
- Each row links to its `confirmationUrl`. View, Cancel (`canCancel`) and Pay now (`canPay`) work there exactly as in §2.

**Errors:**

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Not a valid phone number, or the code isn't 4–10 digits |
| 400 | `INVALID_CODE` | Wrong, expired or already-used code. Show "Wrong code" and let them retry or resend |
| 400 | `INVALID_PHONE` | Twilio can't send SMS to the number |
| 429 | `TOO_MANY_ATTEMPTS` | More than 3 codes per 10 minutes, or 5 code tries per minute, for the number |
| 429 | `TOO_MANY_CODES` | Twilio's own per-number limit |
| 502 | `SMS_PROVIDER_ERROR` | SMS couldn't be sent. Show "Try again shortly" |
| 401 | `UNAUTHENTICATED` | `/me`, `/customer/bookings` without a valid session. Show the sign-in screen |

---

## 3. Dashboard: bookings (`/api/v1/admin/bookings`, admin + manager)

### The booking object
```json
{
  "id": "uuid", "bookingNumber": "CT-24A7F", "source": "staff",
  "status": "confirmed", "paymentStatus": "partial",
  "ground": { "id": "uuid", "name": "Green Arena", "sport": "football" },
  "slot": { "id": "uuid", "date": "2026-11-02", "startHour": 18, "endHour": 19 },
  "customer": { "id": "uuid", "name": "Rakib Hasan", "phone": "+8801711000000", "email": "rakib@example.com" },
  "contact": { "name": "Rakib Hasan", "email": "rakib@example.com", "phone": "+8801711000000" },
  "amount": 150000, "serviceFee": 0, "total": 150000, "paid": 50000, "due": 100000,
  "dueDate": "2026-11-01", "dueNote": "Rest at the counter", "notes": null,
  "createdBy": { "id": "uuid", "name": "Manager" },
  "confirmedAt": "…", "cancelledAt": null, "cancelReason": null, "createdAt": "…", "updatedAt": "…"
}
```
- `ground.name` holds the ground's name. The old mock put it in `groundId` by mistake.
- `contact` holds the details given for *this* booking. A portal checkout never overwrites the customer record.
- `payAtVenue: true` means a portal customer chose cash. These bookings appear in the review queue: confirm them, then record the cash with `POST /:id/payments` when the customer pays. Recording a payment on a pending booking also confirms it (and emails the confirmation). The public booking includes `payAtVenue` too.
- `walletPayment` (or `null`) is the bKash / Nagad payment a portal customer sent: `{ method, amount, reference, payerNumber, status }`. While `status` is `pending` the booking is in the review queue: staff check their own bKash / Nagad app for that TrxID and sender, then **Verify** (`POST /:id/confirm`) or **Reject** (`POST /:id/cancel` with `refund: false, rejectWalletPayment: true`). It is not money owed meanwhile: it's left out of dues, overdue, reminders, the due digest and customer due amounts, and "Collect payment" is refused (`409 PAYMENT_UNDER_REVIEW`); hide that button.
- `cancelRequestedAt` is set when the customer asked to cancel while the payment was under review: show a "Cancel requested" badge.
- A verified bKash / Nagad payment counts as received (revenue, Today's Money) on the day it was **verified**.

### Endpoints

| Method & path | Body / query | Returns |
|---|---|---|
| `GET /admin/bookings` | `status`, `paymentStatus`, `groundId`, `customerId`, `from`+`to` (slot date, together), `search` (booking number, name, phone), `sort` (`created` default, or `slot`), `due` (`overdue`, `today`, `any`; see the dashboard doc), `page`, `limit` | `{ data, total, page, limit, counts: { pending, confirmed, cancelled, completed, no_show } }`. The counts ignore `status`, for the stat cards. `status=no_show` is a valid filter |
| `GET /admin/bookings/upcoming?limit=5` | — | The next pending or confirmed bookings (dashboard home) |
| `GET /admin/bookings/:id` | — | Booking plus `payments[]`, `events[]` (timeline, newest first) and `customer.totalBookings` |
| `POST /admin/bookings` | See "New Booking" below | **201** booking |
| `POST /admin/bookings/:id/confirm` | `{ markPaid?: false, method?: "cash", reference?, notifyCustomer?: true }` | Booking. Works for unpaid staff bookings, portal pay-at-venue bookings and portal bKash / Nagad bookings (**Verify**: the pending payment becomes `succeeded`, recorded by you, and the booking `confirmed` and `paid`). `method` is `cash`, `bank_transfer`, `bkash` or `nagad`; `reference` is an optional TrxID for `bkash` / `nagad`. `409 BOOKING_NOT_PENDING` (also for portal card bookings, which confirm by payment, and when the payment was handled meanwhile). `409 BOOKING_CHANGED` (cancelled meanwhile). `409 WALLET_PAYMENT_EXCEEDS_DUE` (other payments already cover it: reject it instead). `409 REFERENCE_ALREADY_USED` |
| `POST /admin/bookings/:id/cancel` | `{ reason?, refund: boolean, notifyCustomer?: true, rejectWalletPayment?: false }` | Booking. **Also use it for "Decline" and for rejecting a bKash / Nagad payment** (`refund: false`, `rejectWalletPayment: true`: the payment becomes `failed` and the event says e.g. "bKash payment (TrxID …) rejected"; allowed even after the slot has ended). Frees the slot. Card payments are refunded through Stripe; cash, bank transfers, bKash and Nagad are marked refunded (pay those back by hand). `409 VERIFY_OR_REJECT` for any cancel of an unverified payment without `rejectWalletPayment: true`. `409 PAYMENT_ALREADY_HANDLED` when `rejectWalletPayment` but it was verified meanwhile. `409 BOOKING_CHANGED` when another action changed it at the same moment (any Stripe refund already made is still recorded on the payment, with a `refunded` event) |
| `POST /admin/bookings/:id/payments` | `{ amount, method: "cash" \| "bank_transfer" \| "bkash" \| "nagad", reference?, note? }` | **201** booking. `reference`: optional TrxID, `bkash` / `nagad` only. On a pending booking it also confirms it (`confirmed` event, confirmation email). `409 BOOKING_NOT_PENDING` on a portal card booking still waiting for its card payment. `409 BOOKING_CHANGED` when it was cancelled at the same moment. `400 PAYMENT_EXCEEDS_DUE`, `409 REFERENCE_ALREADY_USED`, `409 PAYMENT_UNDER_REVIEW` (verify or reject the customer's bKash / Nagad payment first), `409 BOOKING_NO_SHOW` (undo the no-show first) |
| `POST /admin/bookings/:id/no-show` | `{ reason? }` (up to 500 characters) | Booking, now `no_show`. For a `pending`, `confirmed` or `completed` booking once its slot has **started** (venue time). Payments and `paymentStatus` don't change, so an advance stays as revenue; `due` becomes 0 (the rest is written off, and the booking leaves dues, overdue, reminders, the due digest, customer due amounts and the CSV due column). The slot stays booked; no email. Logs a `no_show` event, e.g. "No-show: 60000 due written off: Phone off" (amounts in the smallest unit, like other events) or "No-show: no due written off". `409 BOOKING_ALREADY_CANCELLED`, `409 ALREADY_NO_SHOW`, `409 VERIFY_OR_REJECT` (a bKash / Nagad payment under review), `409 BOOKING_NOT_PENDING` (a portal card checkout still in Stripe), `409 SLOT_NOT_STARTED`, `409 BOOKING_CHANGED` (changed at the same moment) |
| `POST /admin/bookings/:id/undo-no-show` | — | Booking, back to `completed` if the slot has ended, else `confirmed` (`confirmedAt` set if it was never confirmed); the due comes back. Logs a `completed` or `confirmed` event "No-show undone". `409 NOT_NO_SHOW`, `409 BOOKING_CHANGED` |
| `PATCH /admin/bookings/:id` | `{ notes?, dueDate?, dueNote? }` (`null` clears) | Booking |
| `POST /admin/bookings/:id/resend-confirmation` | — | `{ sent: boolean }`. `sent: false` if email isn't configured. `409 BOOKING_NOT_CONFIRMED` |

**Payments in the detail view:** `{ id, method, amount, status, cardLast4, stripePaymentIntentId, reference, payerNumber, note, recordedBy, createdAt, refundedAt }`. `reference` is the bKash / Nagad TrxID; `payerNumber` the number a portal customer sent from.

**Events in the detail view:** `{ id, type, detail, user, createdAt }`. `type` is one of `created`, `payment_received`, `confirmed`, `cancelled`, `refunded`, `email_sent`, `completed`, `cancel_requested`, `no_show`. Use these for the Activity timeline instead of the invented one.

**No generic status PATCH:**
- The list page's inline Pending→Confirmed dropdown should call `confirm`.
- Any "Cancelled" choice should call `cancel` (ask whether to refund).

### New Booking form: `POST /admin/bookings`
```json
{
  "slotId": "uuid",
  "customer": { "id": "uuid (optional)", "name": "Walk In", "phone": "01711000000", "email": "walk@in.com" },
  "payment": { "type": "partial", "method": "cash", "amount": 50000, "dueDate": "2026-11-01", "note": "Rest at the counter" },
  "notes": "optional staff note"
}
```
- **`payment.type`:**
  - `full`: confirmed and paid.
  - `partial`: confirmed and partial. `amount` is the advance and must be below the total.
  - `none`: pending and unpaid.
- **`method`** is required unless `type` is `none`: `cash`, `bank_transfer`, `bkash` or `nagad`. `payment.reference` is an optional TrxID for `bkash` / `nagad`, refused with `type: "none"` (nothing is paid).
- **Pick the slot** from `GET /admin/slots?groundId&date&status=available&openDaysOnly=true`. The price is the slot's `price`, with no service fee.
- **The customer** is found or created by phone, and staff edits update the name and email. Send `customer.id` to book for a known customer.
- **Errors:** `409 SLOT_NOT_AVAILABLE`, `400 SLOT_IN_PAST`, `400 GROUND_CLOSED` (a day the ground doesn't open, with no staff override), `400 PAYMENT_EXCEEDS_DUE`, `404 CUSTOMER_NOT_FOUND`, `409 REFERENCE_ALREADY_USED` (that TrxID is already recorded for that method).

---

## 4. Dashboard: customers (`/api/v1/admin/customers`, admin + manager)

| Method & path | Body / query | Returns |
|---|---|---|
| `GET /admin/customers` | `search`, `tag` (`vip` \| `regular` \| `new`), `hasDue` (`true`/`false`), `sort` (`lastBooking` default, `totalSpent`, `bookings`, `since`, `due`; always high → low), `page`, `limit` | `{ data, total, page, limit, stats: { total, newThisMonth, withDuePayments, totalDueAmount, totalRevenue } }` |
| `GET /admin/customers/search?phone=` | Any format | `{ id, name, phone, email }` or `null`. Use it to fill the New Booking form |
| `GET /admin/customers/:id` | — | Customer plus `recentBookings` (latest 20, booking objects), `duePayments[]` (`{ bookingId, bookingNumber, amount, dueDate }`), `favoriteGround` (`{ id, name, bookings }` or `null`) |
| `POST /admin/customers` | `{ name, phone, email, adminNote? }` | **201** customer. `409 CUSTOMER_PHONE_TAKEN` |
| `PATCH /admin/customers/:id` | Any of the above | Customer. `409 CUSTOMER_PHONE_TAKEN` |
| `DELETE /admin/customers/:id` | **admin only** | `{ deleted: true }` (soft delete). `409 CUSTOMER_HAS_UPCOMING_BOOKINGS` |

**The customer object:** `{ id, name, phone, email, adminNote, createdAt, bookings, totalSpent, lastBooking, dueAmount, tag }`.
- `createdAt` is the "customer since" date.
- `bookings` counts bookings that weren't cancelled.
- `tag`: 10 or more bookings = `vip`, 3–9 = `regular`, otherwise `new`.

**"Collect due" button:** call `POST /admin/bookings/:bookingId/payments` for the due booking. Due amounts can't be edited on the customer.

---

## 5. Dashboard home

`GET /api/v1/admin/dashboard/stats`:
```json
{
  "todayRevenue": 450000, "todayRevenueTrend": 12.5,
  "todayBookings": 9, "todayBookingsTrend": -10,
  "totalCustomers": 240, "totalCustomersTrend": 3.4,
  "activeGrounds": 4, "activeGroundsTrend": 0,
  "bookingsTodayByGround": [{ "groundId": "uuid", "bookings": 3 }]
}
```
- **Trends** are the % change against the same day last week (customers and grounds: against a week ago). A trend is **`null` when last week was 0**: show "New". The attention cards, today-by-ground and recent activity are in [`docs/frontend-dashboard.md`](frontend-dashboard.md).
- **Revenue** is payments received today minus refunds made today.
- **`bookingsTodayByGround`** gives the ground cards their "today's bookings" number.
- **Upcoming list:** use `GET /admin/bookings/upcoming?limit=5`.

---

## 6. Slots: what changed

- **`slot.booking`** is now filled for held and booked slots: `{ id, bookingNumber, customerName, paymentStatus }`. Link it to the booking detail.
- **`slot.heldUntil`** is set while `status` is `held`. Show "Customer paying… (until 18:05)".
- **`GET /admin/slots`:**
  - `stats` gains `held`.
  - `status=held` is a valid filter.
- **Calendar** (`/admin/slots/calendar`):
  - It now also includes held slots.
  - Booked and held slots carry `bookingId`, `customerName`, `customerPhone`, `amount` and `advancePaid`.
- **Blocking a booked slot:** `POST /admin/slots/:id/block` now accepts `{ reason, note?, cancelBooking: true }`.
  - It cancels the booking with a full refund, emails the customer if `notifyCustomerOnBlock` is on, and blocks the slot.
  - It returns `cancelledBooking: true`.
  - Without the flag: `409 SLOT_HAS_BOOKING`.
  - On a booking whose bKash / Nagad payment isn't verified yet: `409 VERIFY_OR_REJECT`, and nothing changes. Tell staff to verify or reject that booking first, then block. The block form's warning should become a checkbox ("Cancel and refund the booking").
- **Blocking a held slot** returns `409 SLOT_NOT_AVAILABLE`, because a customer is paying for it.

### Settings: `/admin/settings/slots` has two new fields

| Field | Type | Default |
|---|---|---|
| `holdMinutes` | int 5–30 | 15 |
| `serviceFee` | int, smallest unit, 0–1000000 | 5000 |
| `portalCashEnabled` | boolean | `true` |
| `bkashNumber` | phone, or `null` / `""` for off. Admin only, like every setting | `null` |
| `nagadNumber` | phone, or `null` / `""` for off | `null` |

---

## 7. New error codes

| Status | `code` | When |
|---|---|---|
| 404 | `BOOKING_NOT_FOUND` | Unknown id, or a public request with a bad token |
| 404 | `CUSTOMER_NOT_FOUND` | Unknown customer |
| 409 | `SLOT_NOT_AVAILABLE` | Slot held, booked or blocked, or just taken |
| 400 | `OUTSIDE_BOOKING_WINDOW` | Portal: beyond `advanceBookingDays`, or inside the cutoff |
| 400 | `GROUND_CLOSED` | Portal and staff: a new booking on a day the ground doesn't open |
| 409 | `BOOKING_NOT_PENDING` | Confirming a booking that isn't pending, a portal booking, or resuming payment after the hold |
| 409 | `BOOKING_NOT_CONFIRMED` | Resending a confirmation for a booking that isn't confirmed |
| 409 | `BOOKING_ALREADY_CANCELLED` | Cancelling twice, or paying a cancelled booking |
| 409 | `BOOKING_COMPLETED` | Cancelling after the slot ended, or cancelling a no-show (undo it first) |
| 409 | `SLOT_NOT_STARTED` | Marking a no-show before the slot has started |
| 409 | `ALREADY_NO_SHOW` / `NOT_NO_SHOW` | Marking a no-show twice / undoing one on a booking that isn't a no-show |
| 409 | `BOOKING_NO_SHOW` | Collecting a payment on a no-show (undo it first) |
| 400 | `CANCELLATION_WINDOW_PASSED` | Customer cancelling inside the cutoff, or a staff booking through the link |
| 400 | `PAYMENT_EXCEEDS_DUE` | Recording more than is owed, or an "advance" that covers the whole price |
| 502 | `REFUND_FAILED` | Stripe refused the refund; nothing changed |
| 502 | `PAYMENT_PROVIDER_ERROR` | Stripe unavailable or not configured |
| 400 | `CASH_NOT_AVAILABLE` | Portal cash chosen while `portalCashEnabled` is off |
| 400 | `WALLET_NOT_AVAILABLE` | Portal bKash / Nagad chosen while its number isn't set |
| 409 | `REFERENCE_ALREADY_USED` | A bKash / Nagad TrxID already recorded for that method (portal or staff) |
| 401 | `SIGN_IN_REQUIRED` | Portal cash, bKash or Nagad checkout without a signed-in customer |
| 409 | `TOO_MANY_OPEN_BOOKINGS` | Portal cash, bKash or Nagad checkout with 3 open unpaid bookings on the phone already |
| 429 | `TOO_MANY_ATTEMPTS` | More than 5 portal checkouts in 10 minutes per IP + phone |
| 409 | `PAYMENT_UNDER_REVIEW` | "Pay now", "Collect payment" or a customer cancel while a bKash / Nagad payment is being verified |
| 409 | `VERIFY_OR_REJECT` | Any cancel of an unverified bKash / Nagad payment other than Reject (staff cancel without `rejectWalletPayment`, or blocking the slot over it) |
| 409 | `PAYMENT_ALREADY_HANDLED` | "Reject" after the payment was verified meanwhile |
| 409 | `BOOKING_CHANGED` | Verify and Reject (or a cancel) on the same booking at the same moment: the other one won |
| 409 | `WALLET_PAYMENT_EXCEEDS_DUE` | Verify when other payments already cover the booking |
| 409 | `CANCEL_ALREADY_REQUESTED` / `NOT_UNDER_REVIEW` | Cancel request sent twice / with nothing under review |
| 409 | `NOTHING_DUE` | "Pay now" on a booking that is paid up or cancelled |
| 409 | `CUSTOMER_PHONE_TAKEN` | Duplicate phone |
| 409 | `CUSTOMER_HAS_UPCOMING_BOOKINGS` | Deleting a customer with upcoming bookings |

---

## 8. Checklist

- [ ] Portal checkout loads `/checkout/options`, offers card and (if `cashEnabled`) "Pay at venue", posts `paymentMethod`, and redirects to `checkoutUrl` (card) or `confirmationUrl` (cash); hardcoded ৳50 removed
- [ ] Bookings list, detail and review queue show a "Pay at venue" badge when `payAtVenue`; settings page has the `portalCashEnabled` switch
- [ ] Confirmation page uses `GET /bookings/:id?token=` (polls while `pending`); Cancel button when `canCancel`; **"Pay ৳{due} now" button when `canPay`** (calls `POST /bookings/:id/pay`, redirects to `checkoutUrl`)
- [ ] Customer sign-in (phone → SMS code → name/email step when `needsProfile`), `/customer/auth/me` on load, Sign out; checkout prefilled with the phone read-only when signed in
- [ ] My Bookings page from `GET /customer/bookings` (Upcoming / Past tabs), each row opening its `confirmationUrl`
- [ ] Bookings list: server-side filters, `counts` for stat cards, inline confirm/cancel through the actions
- [ ] Booking detail: payments, Activity timeline from `events`, cancel (with refund choice), collect payment, resend confirmation; receipt button hidden
- [ ] Confirm Bookings page: `status=pending` list, Confirm (with "mark paid" and email toggle), Decline = cancel with `reason`; bKash / Nagad bookings show method, TrxID and sender, with Verify / Reject
- [ ] Portal checkout offers each of `wallets` with "Send ৳{total} to {number}", TrxID and sender fields
- [ ] New Booking form: slot picker from `/admin/slots`, phone lookup from `/admin/customers/search`, full / partial / none payment
- [ ] Customers list and detail from `/admin/customers`; "collect due" records a booking payment
- [ ] Dashboard home: `/admin/dashboard/stats` and `/admin/bookings/upcoming`
- [ ] Slots: `held` status and `heldUntil`, `slot.booking` link, calendar customer fields, block form "cancel and refund" checkbox
- [ ] Slot settings page: `holdMinutes` and `serviceFee`
- [ ] UPI removed everywhere
