# turf-api update: dashboard home

**For:** turf-admin (frontend). **Date:** 31 Oct 2026.

This implements the "Dashboard API" spec: one fix and three new read-only endpoints. All of it is admin + manager, and all of it is live and covered by e2e tests.

The conventions are unchanged:
- Every response uses the `{ success, data }` envelope.
- Money is in the **smallest currency unit**.
- Dates and hours are venue-local (Asia/Dhaka).

---

## 0. Decisions

| Topic | What shipped |
|---|---|
| Recent activity | **Built**: `GET /admin/booking-events` |
| Overdue | Money due counts as overdue once its `dueDate` has passed. **With no `dueDate`**, it's overdue once the slot has started |
| Customers paying now | **Shown** as a count (`payingNow`) |

The "overdue" rule covers **completed** bookings too, which goes beyond the spec. A slot that has been played but not paid for is exactly what the overdue card is for. The hourly job marks played bookings `completed`, so without this they would drop off the card.

---

## 1. Fix: stats trends can be `null`

`GET /admin/dashboard/stats`: each of the four `*Trend` fields is `number | null`.
- **`null` when last week's value was 0.** Show "New" instead of "+100%".
- `bookingsTodayByGround` is still returned. Stop using it once "Today's grounds" (§3) is wired.

---

## 2. Needs attention: `GET /admin/dashboard/attention`

The row of action cards at the top. Refresh it every 60 seconds.

```json
{
  "toConfirm":    { "count": 3, "payAtVenue": 2 },
  "overdue":      { "count": 2, "amount": 300000 },
  "dueToday":     { "count": 1, "amount": 100000 },
  "payingNow":    { "count": 1 },
  "startingSoon": { "count": 2, "withinMinutes": 60 }
}
```

| Card | Counts | Link it to |
|---|---|---|
| `toConfirm` | Pending bookings staff can confirm: unpaid staff bookings and pay-at-venue requests. **Not** portal card checkouts still in Stripe. `payAtVenue` is how many of them are pay-at-venue | Confirm Bookings (`GET /admin/bookings?status=pending`) |
| `overdue` | Bookings with money overdue (§0). `amount` is the total still due | `GET /admin/bookings?due=overdue` |
| `dueToday` | Bookings with money due and `dueDate` today | `GET /admin/bookings?due=today` |
| `payingNow` | Slots on hold right now (a customer is in Stripe), any date | `GET /admin/slots?status=held` |
| `startingSoon` | Pending or confirmed bookings starting in the next 60 minutes. This works across midnight | The upcoming list on the same page |

**A new filter on the bookings list:** `GET /admin/bookings?due=overdue | today | any`. `any` is every live booking with money due. Card checkouts still in Stripe never count as due.

---

## 3. Today's grounds: `GET /admin/dashboard/today`

This replaces the "Active grounds" table with a strip of today's slots for each ground. Refresh it every 60 seconds.

```json
{
  "date": "2026-10-31",
  "nowHour": 17,
  "grounds": [
    {
      "groundId": "uuid", "groundName": "Green Arena", "sport": "football", "format": "5x5",
      "openingHour": 6, "closingHour": 23, "closedReason": null,
      "slots": { "total": 17, "available": 6, "held": 1, "booked": 8, "blocked": 2 },
      "bookedHours": 8, "remainingFreeHours": 4, "revenueToday": 120000,
      "current": { "bookingId": "uuid", "bookingNumber": "CT-24A7F", "customerName": "Rakib Hasan", "startHour": 17, "endHour": 18 },
      "next":    { "bookingId": "uuid", "bookingNumber": "CT-31B0C", "customerName": "Walk In", "startHour": 19, "endHour": 20, "due": 50000 },
      "timeline": [{ "startHour": 6, "endHour": 7, "status": "available" }]
    }
  ]
}
```

- **Which grounds:** active grounds only, sorted by name.
- **`closedReason`:** set when the ground doesn't open today. It's the closure's label (for example "Closed for Eid", or "Closed" without one), or `"Not open today"` when the ground's days skip today.
  - A closed ground has `slots.total: 0` and an empty `timeline`.
  - A booking a closure had to skip still shows.
- **`current`** is the booking playing right now. A 17–18 slot is current at 17:59 but not at 18:00.
- **`next`** is the next booking today. Use its `due` for a "Collect ৳…" button (`POST /admin/bookings/:id/payments`).
- **`current` and `next`** are `null` when there's no such booking.
- **`remainingFreeHours`:** available slots that haven't started yet, in hours.
- **`revenueToday`:** the dashboard's revenue rule (received minus refunds), for this ground's bookings.
- **`timeline`:** every slot today, in order. `status` is `available`, `held`, `booked` or `blocked`.

---

## 4. Recent activity: `GET /admin/booking-events?limit&page&type`

The "Recent activity" list. Show the latest 10 and refresh every 60 seconds.

```json
{
  "data": [
    { "id": "uuid", "type": "payment_received", "detail": "Paid 50000 by cash",
      "user": { "id": "uuid", "name": "Manager" },
      "booking": { "id": "uuid", "bookingNumber": "CT-24A7F", "customerName": "Rakib Hasan", "groundName": "Green Arena" },
      "createdAt": "2026-10-31T10:42:00.000Z" }
  ],
  "total": 214, "page": 1, "limit": 10
}
```

- **Order:** newest first, across all bookings.
- **`limit`:** defaults to 10, at most 50.
- **`type`:** optional and can repeat (`?type=payment_received&type=refunded`). The values are `created`, `payment_received`, `confirmed`, `cancelled`, `refunded`, `email_sent` and `completed`.
- **`user`:** `null` for automatic events: Stripe, the jobs and portal checkouts.
- **Abandoned card checkouts** are left out.
- **`detail`:** stored text, written in the smallest currency unit. Show it as is, or build your own line from `type` and the booking.

---

## 5. Already available, no backend work

| Dashboard part | Endpoint |
|---|---|
| Today's cash, card and bank transfer (closing the drawer) | `GET /admin/reports/summary?from=<today>&to=<today>` → `revenueByMethod` |
| Weekly revenue chart | `GET /admin/reports/revenue` for the last 7 days, `groupBy=day` |
| Bookings by status chart | `GET /admin/reports/summary` → `statusCounts` for the last 7 days |
| Upcoming bookings with "Collect" when `due > 0` | `GET /admin/bookings/upcoming` + `POST /admin/bookings/:id/payments` |
| Quick confirm from the attention card | `POST /admin/bookings/:id/confirm` |

---

## 6. Checklist

- [ ] Stat cards show "New" when a trend is `null`
- [ ] Needs attention: 5 cards from `/admin/dashboard/attention`, refreshed every 60 s, each linking to its filtered list
- [ ] Bookings list accepts `?due=overdue|today|any` from those links
- [ ] Today's grounds: `/admin/dashboard/today`, a timeline strip per ground, now and next, "Collect" on `next.due`, the closed label; `bookingsTodayByGround` no longer used
- [ ] Recent activity: `/admin/booking-events?limit=10`, refreshed every 60 s
- [ ] Today's money by method from `/admin/reports/summary`
