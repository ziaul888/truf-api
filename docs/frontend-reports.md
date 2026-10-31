# turf-api update: reports

**For:** turf-admin (frontend). **Date:** 31 Oct 2026.

This implements the "Reports API" spec. Everything below is live and covered by e2e tests. The Reports pages and the dashboard's two charts can drop the mock server and the hardcoded numbers.

Conventions are unchanged:
- Responses use the `{ success, data }` envelope. The CSV export is the one exception.
- Money is in the **smallest currency unit**: `150000` is ৳1,500.00. Show ৳, not ₹.
- Dates are venue-local (Asia/Dhaka) `"YYYY-MM-DD"` strings.

---

## 0. Decisions

| Topic | What shipped |
|---|---|
| Scope | All five endpoints below |
| Who | **Admin and manager**, same as the dashboard. No `403`s |
| Weeks | Start on **Saturday**. Labels look like `"24 – 30 Oct"` |
| Excel | The API returns **CSV only**. Turn it into Excel in the browser |

---

## 1. Shared rules

**Date range** (every endpoint):
- Send `from` and `to` together. Both are inclusive.
- Turn the presets (7 days, 30 days, 90 days, 1 year) into dates on the frontend.
- The longest range is 366 days.

**Previous period and trends:**
- The previous period is the same number of days immediately before `from`. For 2–31 Oct it's 2 Sep–1 Oct.
- A trend is the % change from the previous period, to one decimal.
- A trend is `null` when the previous value is 0. Show "new" instead of a %.

**`groupBy`** (`day` · `week` · `month`):
- If you leave it out, the API picks one from the range length: up to 31 days → `day`, up to 92 → `week`, longer → `month`.
- **Every period is returned**, including empty ones, so charts have no gaps.
- Each point has:
  - `period`: its first date;
  - `label`: ready to show, for example `"31 Oct"`, `"24 – 30 Oct"`, `"28 Oct – 3 Nov"` or `"Oct 2026"`.
- Weeks and months at the edges are cut to the range. Their `period` and `label` use the cut dates.

**What counts:**

| Number | Definition | Dated by |
|---|---|---|
| Revenue | Money received minus money refunded, the same rule as `todayRevenue` on the dashboard | When money moved (payment time; refunds by refund time) |
| Bookings | Every status, but **not** abandoned card checkouts (holds that lapsed unpaid) or deleted rows | Slot date |
| Avg booking value | Mean `total` of bookings that weren't cancelled; 0 when there are none | Slot date |
| Completion rate | Of bookings whose slot has ended, the % that are `completed`; `null` when none has ended | Slot date |
| Cancellation rate | Cancelled ÷ all bookings, as a % | Slot date |
| Utilization | Hours booked (bookings not cancelled) ÷ hours open, leaving out blocked slots and closures | Slot date |

Revenue and bookings are dated differently on purpose. A booking paid in October for a slot in November counts in October's revenue and November's bookings. That way revenue matches the bank and the dashboard.

---

## 2. Endpoints (`/api/v1/admin/reports`)

### `GET /summary?from&to`
The stat cards on Reports, the Revenue report and the Bookings report, and the status pie chart.

```json
{
  "period":   { "from": "2026-10-02", "to": "2026-10-31" },
  "previous": { "from": "2026-09-02", "to": "2026-10-01" },
  "revenue": 4520000, "revenueTrend": 12.5,
  "received": 4670000, "refunds": 150000,
  "revenueByMethod": { "card": 3100000, "cash": 1270000, "bank_transfer": 150000 },
  "bookings": 38, "bookingsTrend": -5.0,
  "avgBookingValue": 152000, "avgBookingValueTrend": 3.4,
  "completionRate": 91.7, "completionRateTrend": null,
  "cancellationRate": 7.9,
  "statusCounts": { "pending": 2, "confirmed": 9, "completed": 24, "cancelled": 3 }
}
```
- Rates are percentages from 0 to 100.
- `revenueByMethod` is net of refunds.
- `revenue` can be **negative** for a range with more refunds than income. Show it as is.

### `GET /revenue?from&to&groupBy`
The Reports "Revenue trend" chart, the Revenue report's chart, and the dashboard's **Weekly revenue** chart. For the dashboard, send the last 7 days with `groupBy=day`.

```json
{
  "groupBy": "day",
  "points": [
    { "period": "2026-10-30", "label": "30 Oct", "revenue": 320000, "received": 320000, "refunds": 0, "bookings": 3 }
  ]
}
```
`bookings` in each point counts by slot date.

### `GET /grounds?from&to`
The "Revenue by ground" chart, "Ground performance" and "Ground utilization", plus the "Grounds tracked" and "Active grounds" cards.

```json
[
  { "groundId": "uuid", "groundName": "Green Arena", "isActive": true,
    "revenue": 2100000, "bookings": 16, "cancelled": 1,
    "hoursBooked": 17, "hoursAvailable": 420, "utilization": 4.0 }
]
```
- **Which grounds:** every active ground, plus inactive ones that had activity in the range.
- **Order:** highest revenue first.
- **`utilization`:** `null` when `hoursAvailable` is 0.
- **Links:** link each row to the ground with `groundId`.

### `GET /bookings?from&to&groupBy`
"Booking trends over time" on the Bookings report. The dashboard's **Bookings by status** chart can use `statusCounts` from `/summary` for the last 7 days instead.

```json
{
  "groupBy": "week",
  "points": [
    { "period": "2026-10-24", "label": "24 – 30 Oct", "pending": 1, "confirmed": 4, "completed": 6, "cancelled": 1, "total": 12 }
  ]
}
```
Each status is the booking's status now.

### `GET /export?type&from&to&groupBy`: CSV download

- **Format:** `text/csv; charset=utf-8`, starting with a UTF-8 BOM so Excel shows ৳ and Bangla names correctly.
- **File name:** `Content-Disposition: attachment; filename="bookings-2026-10-01-to-2026-10-31.csv"`.
- **Size:** no row limit, and the file is streamed. This removes the old 100-row cap.
- **Money columns:** whole taka with two decimals, for example `1500.00`.
- **Errors:** still come back as **JSON**, so check `res.ok` before saving the file.

| `type` | Needs | Columns |
|---|---|---|
| `revenue` | `from`, `to`, `groupBy` = `day` or `week` | Period start, Period end, Received, Refunds, Net revenue, Card, Cash, Bank transfer, Bookings |
| `bookings` | `from`, `to` (slot date) | Booking #, Customer, Phone, Ground, Date, Start, End, Amount, Service fee, Total, Paid, Due, Status, Payment status, Source, Created |
| `customers` | `from`/`to` optional: customers who joined in the range | Name, Phone, Email, Customer since, Bookings, Total spent, Last booking, Due amount, Tag |

**Download example:**
```ts
const res = await fetch(`/api/v1/admin/reports/export?type=bookings&from=${from}&to=${to}`);
if (!res.ok) throw new Error((await res.json()).error);
const blob = await res.blob();
// Excel: read the CSV text with the existing library and write .xlsx in the browser.
```

---

## 3. Errors

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Only one of `from`/`to`, a bad date, `from` after `to`, an unknown `groupBy` or `type`, or `type=revenue` without `groupBy` `day`/`week` |
| 400 | `RANGE_TOO_LONG` | More than 366 days |
| 401 | `UNAUTHENTICATED` | No staff session |

---

## 4. Checklist

- [ ] Reports overview: `/summary` + `/revenue`; presets become `from`/`to`; mock server removed; ৳ from minor units
- [ ] Revenue report: `/summary`, `/revenue` (chart follows `groupBy`), `/grounds` (rows link to the ground)
- [ ] Bookings report: `/summary` (cancellation rate, status pie), `/bookings`, `/grounds` (utilization column)
- [ ] Export page: downloads from `/export` (no 100-row cap); adds "Revenue (daily / weekly)"; Excel made in the browser
- [ ] Dashboard Weekly revenue: `/revenue` for the last 7 days, `groupBy=day`
- [ ] Dashboard Bookings by status: `/summary` `statusCounts` for the last 7 days
- [ ] Trends: show "new" when a trend is `null`; negative revenue shown as is
