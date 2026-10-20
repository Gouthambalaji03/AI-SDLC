# Phase 2: Architecture & System Design — StateFlow Engine v2

## 1. System Architecture Overview

```text
+-------------------------------------------------------------+
|                      FastAPI Web Layer                      |
|  - GET / (Interactive Visual Dashboard - HTML5/CSS/JS)       |
|  - GET /health (Service Health Check)                       |
|  - POST /api/v1/orders (Create Order)                       |
|  - GET /api/v1/orders (List / Filter)                       |
|  - GET /api/v1/orders/{id} (Retrieve Order)                 |
|  - POST /api/v1/orders/{id}/transitions (State Transition)  |
|  - GET /api/v1/orders/{id}/audit (Audit Trail)              |
|  - GET /api/v1/orders/matrix (Transition Registry)          |
|  - POST /api/v1/orders/expire-stale (Batch Expiry Engine)   |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
|                     OrderService Engine                     |
|  - Validates transition against TransitionMatrix            |
|  - Evaluates remaining refund balance (amount - refunded)   |
|  - Enforces Idempotency Key checks                          |
|  - Evaluates Optimistic Lock (Version checking)             |
|  - Emits immutable AuditLog entries                         |
|  - Scans & expires stale PAYMENT_PENDING orders             |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
|                      Storage Layer                          |
|  - SQLite (WAL mode) / Atomic Transactions                  |
|  - Tables: orders, audit_logs, idempotency_keys             |
+------------------------------+------------------------------+
```

## 2. Architecture Decision Records (ADRs)

### ADR-001: Explicit State Machine Transition Table
* **Context**: Avoid sprawling `if/else` checks across controllers.
* **Decision**: Implement a static dictionary mapping `from_state -> Set[AllowedTrigger, TargetState]`. Any transition not in this registry is rejected immediately before reaching the database.
* **Consequence**: Predictable, O(1) state validation that can be unit-tested in isolation without mocking a database.

### ADR-002: Integer Cents for Monetary Representation
* **Context**: Binary floating point (`float`) causes precision loss (e.g. `0.1 + 0.2 = 0.30000000000000004`).
* **Decision**: All monetary balances are stored as integer cents (`amount_cents: int`, `refunded_cents: int`).

### ADR-003: Idempotency Key Table with Cached Response
* **Context**: Network retries during payment confirmation or refund requests can send duplicate POST requests.
* **Decision**: Before executing any transition with an `idempotency_key`, check the `idempotency_keys` table. If present, return the original cached response. If absent, execute inside an atomic transaction and commit the key with the result.

### ADR-004: Multi-Tier Refund Calculation
* **Context**: Customers may request multiple partial refunds up to the original purchase amount.
* **Decision**: When `partial_refund` trigger fires:
  1. Reject if `refund_amount_cents <= 0` or `refunded_cents + refund_amount_cents > amount_cents`.
  2. If new `refunded_cents == amount_cents`, automatically transition to `REFUNDED` (terminal).
  3. If new `refunded_cents < amount_cents`, transition to or remain in `PARTIALLY_REFUNDED`.

### ADR-005: Stale Order Auto-Expiration
* **Context**: Orders abandoned in `PAYMENT_PENDING` hold inventory reservations indefinitely.
* **Decision**: Stale orders exceeding a configurable timeout (default 30 minutes) can be batch-expired into the terminal `EXPIRED` state via `POST /api/v1/orders/expire-stale` or a background cron worker.

---

## 3. Database Schema (SQLite DDL)

```sql
CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    refunded_cents INTEGER NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'USD',
    current_state TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    from_state TEXT NOT NULL,
    to_state TEXT NOT NULL,
    trigger TEXT NOT NULL,
    actor TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders (id)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    action TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
```

---

## 4. REST API Contract

### `POST /api/v1/orders`
* **Request**:
  ```json
  {
    "customer_id": "cust_123",
    "amount_cents": 4999,
    "currency": "USD"
  }
  ```
* **Response (201 Created)**:
  ```json
  {
    "id": "ord_9b1deb4d",
    "customer_id": "cust_123",
    "amount_cents": 4999,
    "refunded_cents": 0,
    "currency": "USD",
    "current_state": "CREATED",
    "version": 1,
    "created_at": "2026-10-20T18:00:00Z",
    "updated_at": "2026-10-20T18:00:00Z"
  }
  ```

### `POST /api/v1/orders/{order_id}/transitions`
* **Request**:
  ```json
  {
    "trigger": "partial_refund",
    "actor": "support_agent",
    "refund_amount_cents": 1500,
    "idempotency_key": "idemp_ref_01",
    "expected_version": 2,
    "note": "Item arrived slightly damaged"
  }
  ```
* **Response (200 OK)**:
  ```json
  {
    "id": "ord_9b1deb4d",
    "customer_id": "cust_123",
    "amount_cents": 4999,
    "refunded_cents": 1500,
    "currency": "USD",
    "current_state": "PARTIALLY_REFUNDED",
    "version": 3,
    "created_at": "2026-10-20T18:00:00Z",
    "updated_at": "2026-10-20T18:05:00Z"
  }
  ```
* **Error (409 Conflict)**:
  ```json
  {
    "error": "INVALID_STATE_TRANSITION",
    "detail": "Cannot perform 'confirm_payment' from state 'CREATED'. Expected states: ['PAYMENT_PENDING']"
  }
  ```
