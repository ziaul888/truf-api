# turf-api update: closures, slot history, bulk actions

**For:** turf-admin (frontend). **Date:** 29 Oct 2026.

This covers items 3, 4 and 5 of "Ground & Slot Next Steps". All three are live in turf-api now and covered by e2e tests. The full API reference is still `docs/frontend-integration.md` (section 4d). This file covers only what's new.

Conventions are unchanged:
- Every response uses the `{ success, data }` / `{ success: false, error, code, details }` envelope.
- Dates are venue-local `"YYYY-MM-DD"` strings (Asia/Dhaka).
- Hours are whole numbers.
- Everything is under `/api/v1`.

---

## 1. Bulk block / unblock by id

Replaces the slot list's "one request per ticked slot" loop.

### `POST /api/v1/admin/slots/bulk`: admin, manager

**Body:**
```json
{ "ids": ["uuid", "uuid"], "action": "block", "reason": "maintenance", "note": "optional" }
```

| Field | Rules |
|---|---|
| `ids` | 1–100 slot ids, no repeats |
| `action` | `"block"` or `"unblock"` |
| `reason` | **Required when blocking**: `maintenance`, `reserved`, `event`, `weather`, `other` |
| `note` | Optional, max 500. Ignored when unblocking |

**Response (`200`)** is always `200` when the body is valid, even if some ids fail:
```json
{ "done": 1, "failed": [{ "id": "uuid", "code": "SLOT_ALREADY_BLOCKED", "error": "This slot is already blocked" }] }
```

- Each id follows the single-slot rules. A failed id **doesn't undo the others**.
- Possible `code`s in `failed`:
  - `SLOT_NOT_FOUND`
  - `SLOT_IN_PAST`
  - `SLOT_HAS_BOOKING`
  - `SLOT_ALREADY_BLOCKED`
  - `SLOT_NOT_BLOCKED`
  - `SLOT_NOT_AVAILABLE`
- Missing `reason` on block → `400 VALIDATION_FAILED` with `details: [{ field: "reason", ... }]`.

**UI:**
- Send one request for the whole selection.
- Toast "Blocked N slots".
- If `failed` isn't empty, list the failed slots with their `error`.
- Refetch the slot list and stats afterwards.

---

## 2. Slot history

### `GET /api/v1/admin/slots/:id/history`: admin, manager

One slot's audit trail, newest first:
```json
[
  { "id": "uuid", "action": "unblock", "reason": null, "note": null, "user": { "id": "uuid", "name": "Manager" }, "createdAt": "2026-10-29T05:10:00.000Z" },
  { "id": "uuid", "action": "block", "reason": "maintenance", "note": "Net repair", "user": { "id": "uuid", "name": "Manager" }, "createdAt": "2026-10-29T04:00:00.000Z" }
]
```

- **`action`:**
  - `block` and `unblock` come from staff blocking and unblocking.
  - `close` and `reopen` come from a venue closure and from lifting it.
- **`user`** is `null` if that staff account no longer exists.
- **Errors:** `404 SLOT_NOT_FOUND`.

**UI:** a "History" panel or drawer on the slot. This is the "View" button on Slots → All slots that has no action today.

### `GET /api/v1/admin/slot-events`: admin, manager

The venue-wide activity log, paginated.

| Query | Notes |
|---|---|
| `groundId` | Optional |
| `from`, `to` | Optional, **send both or neither**. Filters by the slot's date, max 366 days |
| `action` | `block`, `unblock`, `close`, `reopen` |
| `userId` | Optional: who did it |
| `page`, `limit` | Default 1 / 20, max limit 100 |

**Response:** `{ data, total, page, limit }`. Each item is a history event plus where it happened:
```json
{
  "id": "uuid", "action": "block", "reason": "event", "note": null,
  "user": { "id": "uuid", "name": "Admin" }, "createdAt": "…",
  "slotId": "uuid", "groundId": "uuid", "groundName": "Green Arena", "date": "2026-10-30", "startHour": 18
}
```

`slotId` can be `null`. That happens when a free slot was later regenerated, for example after a ground's hours changed. The event still shows the ground, date and hour.

---

## 3. Venue closures

Close every ground, or some of them, for a date range, such as Eid or a power cut, with one action.
- The closure is stored, so **slots generated later on those days are created already blocked**.
- Lifting the closure frees only the slots *it* blocked. Slots blocked separately stay blocked.

### The closure object
```json
{
  "id": "uuid",
  "fromDate": "2026-11-18",
  "toDate": "2026-11-19",
  "groundIds": [],
  "reason": "event",
  "note": "Staff-only note",
  "publicLabel": "Closed for Eid",
  "createdBy": { "id": "uuid", "name": "Admin" },
  "createdAt": "…",
  "liftedAt": null,
  "liftedBy": null
}
```
- **`groundIds: []`** means **every ground**, including grounds added later.
- **`liftedAt: null`** means the closure is in force. Once it's lifted, `liftedAt` and `liftedBy` are set.

### Endpoints

| Method & path | Who | Body / query | Success | Errors |
|---|---|---|---|---|
| `POST /admin/closures` | **admin** | `{ fromDate, toDate, groundIds?, reason, note?, publicLabel? }` | **`201`** `{ closure, blocked, skippedBooked }` | `400 INVALID_DATE_RANGE` · `403` · `404 GROUND_NOT_FOUND` |
| `GET /admin/closures` | admin, manager | `page`, `limit` | `200 { data: Closure[], total, page, limit }`, newest first, lifted ones included | — |
| `DELETE /admin/closures/:id` | **admin** | — | `200 { unblocked }` | `404 CLOSURE_NOT_FOUND` · `409 CLOSURE_ALREADY_LIFTED` |
| `GET /closures` | **public** | `from`, `to` (max 92 days) | `200 [{ fromDate, toDate, groundIds, label }]` | `400` |

**Create rules:**
- At most **31 days**.
- `fromDate` can't be in the past.
- Omit `groundIds`, or send `[]`, to close every ground.
- `publicLabel` is optional, 1–100 characters. Customers see it.
- `note` and `reason` are **staff only**.
- Booked slots are **skipped** and counted in `skippedBooked`. Cancelling them arrives with the bookings module.

**Lift:** `DELETE` keeps the closure for history and sets `liftedAt`. `unblocked` counts only upcoming slots.

### Customer portal
- `GET /grounds/:id/slots` already returns **`[]` for closed days**, so the slot picker needs no change to hide them.
- To say *why* a day is closed, call `GET /closures?from=&to=` for the picker's date range. A closure applies to a ground when `groundIds` is empty or contains that ground's id. Show its `label` (it's `publicLabel`, or `"Closed"` when there isn't one).

### Dashboard UI
- **A Closures page, or a section on Slots:**
  - A list with status badges: *Upcoming* or *Active* while `liftedAt` is null, *Lifted* otherwise.
  - A "Close venue" form: a date range, a ground multi-select with an "All grounds" option, reason, note and public label.
  - A "Lift" button that opens a confirmation.
- **Hide create and lift for managers:** the API returns `403` to them anyway.
- **After creating:** toast "Closed N slots", plus "M booked slots were not affected" when `skippedBooked > 0`.

---

## 4. TypeScript types

```ts
export type BlockReason = "maintenance" | "reserved" | "event" | "weather" | "other";
export type SlotEventAction = "block" | "unblock" | "close" | "reopen";
export interface StaffRef { id: string; name: string }

export interface BulkSlotsResult {
  done: number;
  failed: { id: string; code: string; error: string }[];
}

export interface SlotEvent {
  id: string;
  action: SlotEventAction;
  reason: BlockReason | null;
  note: string | null;
  user: StaffRef | null;
  createdAt: string;
}

export interface SlotEventListItem extends SlotEvent {
  slotId: string | null;
  groundId: string;
  groundName: string;
  date: string;      // "YYYY-MM-DD"
  startHour: number;
}

export interface Closure {
  id: string;
  fromDate: string;
  toDate: string;
  groundIds: string[]; // [] = all grounds
  reason: BlockReason;
  note: string | null;
  publicLabel: string | null;
  createdBy: StaffRef | null;
  createdAt: string;
  liftedAt: string | null;
  liftedBy: StaffRef | null;
}

export interface CreateClosureResult { closure: Closure; blocked: number; skippedBooked: number }

export interface PublicClosure { fromDate: string; toDate: string; groundIds: string[]; label: string }
```

---

## 5. New error codes

| Status | `code` | When | UI |
|---|---|---|---|
| 404 | `CLOSURE_NOT_FOUND` | Lifting a closure that doesn't exist | Refresh the list |
| 409 | `CLOSURE_ALREADY_LIFTED` | Lifting twice | Refresh the list |
| 400 | `INVALID_DATE_RANGE` | Closure longer than 31 days, starts in the past, or `from` after `to` | Show `error` under the dates |

---

## 6. Checklist

- [ ] Slot list bulk actions call `POST /admin/slots/bulk` once, and show per-id failures
- [ ] Slot "View" button opens history from `GET /admin/slots/:id/history`
- [ ] (Optional) Activity page from `GET /admin/slot-events` with ground, date, action and user filters
- [ ] Closures: list, create (admin), lift (admin, with confirmation)
- [ ] Portal slot picker shows closure labels from `GET /closures` on closed days

## 7. Still not available

- **Checkout hold and bookings ↔ slots** (items 1 and 2) are next. `slot.booking` stays `null`, and blocking a booked slot still returns `409 SLOT_HAS_BOOKING`.
- **Half-hour opening and closing times** (item 6) are approved but not built. Everything stays in whole hours for now.
