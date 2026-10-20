# StateFlow — AI-SDLC Reference Implementation

> **StateFlow** is a resilient, event-driven Order & Payment Lifecycle Engine built as a production-grade reference architecture for an **AI-driven Software Development Life Cycle (AI-SDLC)**.

---

## 🌟 The AI-SDLC Philosophy

Traditional SDLC is human-manual and treats writing code as the bottleneck. In an **AI-SDLC**, code generation is automated, shifting the human and agent roles to **intent definition, machine-readable specifications, test-driven verification, and policy enforcement**.

```text
[Human Intent / Goal]
        │
        ▼
[Phase 1: Spec Agent]         ──▶ .ai-sdlc/specs/01_requirements.md
        │
        ▼
[Phase 2: Architect Agent]    ──▶ .ai-sdlc/specs/02_architecture.md & ADRs
        │
        ▼
[Phase 3: Task Decomposer]    ──▶ .ai-sdlc/specs/03_tasks.md
        │
        ▼
[Phase 4: Dev & QA Agents]    ──▶ TDD: Write Tests ➔ Write Code ➔ Self-Healing Loop
        │
        ▼
[Phase 5: Policy Gate]        ──▶ python .ai-sdlc/sdlc.py verify (21/21 tests + ADR checks)
        │
        ▼
[Phase 6: Git & CI Guardrails]──▶ Pre-commit hook & GitHub Actions auto-block regressions
```

---

## 📦 What Was Built (All 3 Dimensions)

### 1. Visual Web Dashboard (Option 1)
* **Access**: [http://localhost:8000/](http://localhost:8000/)
* **Features**:
  * **Interactive State Machine Visualizer**: Highlights valid next transitions and marks terminal states with visual glow.
  * **Live Order Simulator**: Create orders, fire triggers (e.g., `initiate_payment`, `confirm_payment`, `ship_order`, `partial_refund`, `expire`), test illegal transitions, and simulate optimistic lock conflicts.
  * **Real-Time Audit Timeline**: Chronological log of every state change, actor, and idempotency key.
  * **Batch Stale Order Expiration**: Run batch expiration directly from the UI header.

### 2. Advanced Feature Flow (Option 2 — via AI-SDLC)
* **Order Auto-Expiration (`EXPIRED`)**: Stale orders in `PAYMENT_PENDING` can be batch-expired via `POST /api/v1/orders/expire-stale`.
* **Multi-Step Partial Refunds (`PARTIALLY_REFUNDED`)**:
  * Tracks cumulative refunded balance (`refunded_cents`).
  * Validates refund amount against remaining balance.
  * Automatically transitions to terminal `REFUNDED` once 100% of the balance is refunded.

### 3. CI/CD & Git Pre-Commit Guardrails (Option 3)
* **GitHub Actions Workflow** (`.github/workflows/ai-sdlc.yml`):
  * Runs on every push and pull request across Python 3.9, 3.10, and 3.11.
  * Validates living specs and executes all 21 test invariants + ADR compliance gates.
* **Git Pre-Commit Hook** (`.githooks/pre-commit`):
  * Blocks any `git commit` locally if unit tests fail or architectural invariants are broken.
  * One-command installer: `python .ai-sdlc/sdlc.py install-hooks`.

---

## 🏗️ Repository Architecture

```text
AI-SDLC/
├── .ai-sdlc/                               # AI-SDLC Engine & Guardrails
│   ├── AGENTS.md                           # System invariants & behavior rules for AI agents
│   ├── sdlc.py                             # Command Center & Policy Enforcement Gate CLI
│   └── specs/                              # Living Machine-Readable Specs
│       ├── 01_requirements.md              # Phase 1: Requirements, state transitions & invariants
│       ├── 02_architecture.md              # Phase 2: System design, ADRs, schema, and API contracts
│       └── 03_tasks.md                     # Phase 3: Executable atomic task checklist
│
├── .githooks/                              # Git Pre-Commit Guardrails
│   └── pre-commit                          # Auto-runs sdlc.py verify before commits
│
├── .github/workflows/                      # Continuous Integration
│   └── ai-sdlc.yml                         # Multi-version Python CI quality gate
│
├── app/                                    # StateFlow Application Source Code
│   ├── main.py                             # FastAPI entrypoint, static files & dashboard mount
│   ├── static/                             # Interactive Visual Dashboard
│   │   ├── index.html                      # Semantic dashboard UI
│   │   ├── style.css                       # Premium dark-theme glassmorphism styling
│   │   └── app.js                          # State visualizer & reactive API client
│   ├── models/
│   │   ├── state.py                        # OrderStatus, TransitionTrigger, & TransitionMatrix
│   │   └── order.py                        # Pydantic schemas (OrderCreate, TransitionRequest, etc.)
│   ├── storage/
│   │   └── db.py                           # SQLite with WAL mode, transactions, idempotency storage
│   ├── services/
│   │   └── order_service.py                # Core state engine, optimistic locking, audit logs
│   └── api/
│       └── routes.py                       # REST API Endpoints with explicit HTTP status mapping
│
├── tests/                                  # Automated QA Invariant Suite (21 Tests)
│   ├── test_state_machine.py               # Unit tests: illegal states, idempotency, partial refund, expiry
│   └── test_api_integration.py             # Integration tests: HTTP endpoints, error mappings
│
├── requirements.txt                        # Production & test dependencies
└── README.md                               # System documentation & usage guide
```

---

## 🚀 Quick Start Guide

### 1. Inspect AI-SDLC Status
Check the status of living specs, task queue, and active guardrails:
```bash
python .ai-sdlc/sdlc.py status
```

### 2. Install Git Pre-Commit Guardrails
Configure Git to automatically verify all tests and invariants before allowing commits:
```bash
python .ai-sdlc/sdlc.py install-hooks
```

### 3. Run the Deterministic Policy Gate & QA Suite
Runs all 21 automated unit and integration tests, followed by ADR architectural invariant checks:
```bash
python .ai-sdlc/sdlc.py verify
```

### 4. Launch the Interactive Application & Visual Dashboard
Start the FastAPI server:
```bash
python .ai-sdlc/sdlc.py serve
```
* **Interactive Visual Dashboard**: [http://localhost:8000/](http://localhost:8000/)
* **Interactive Swagger UI**: [http://localhost:8000/docs](http://localhost:8000/docs)
* **Health Endpoint**: [http://localhost:8000/health](http://localhost:8000/health)

---

## 🛡️ Business Invariants Enforced in StateFlow

1. **Deterministic State Matrix**:
   - `CREATED` ➔ `PAYMENT_PENDING` ➔ `PAID` ➔ `PROCESSING` ➔ `FULFILLED`
   - Direct illegal jumps (e.g. `CREATED` straight to `FULFILLED`) are blocked with HTTP `409 Conflict`.
2. **Terminal State Immutability**:
   - Once an order reaches `FULFILLED`, `CANCELLED`, `REFUNDED`, `FAILED`, or `EXPIRED`, no further state transitions can ever take place.
3. **Idempotency Protection**:
   - Submitting duplicate payment webhook events with the same `idempotency_key` returns the cached response without double-advancing order versions.
4. **Optimistic Concurrency Control**:
   - Orders track an incrementing `version` integer. Concurrent requests with stale versions are rejected with `OPTIMISTIC_LOCK_CONFLICT` (HTTP 409).
5. **Zero Floating-Point Drift**:
   - All monetary amounts are validated and stored in integer cents (`amount_cents > 0`, `refunded_cents >= 0`).
6. **Partial Refund & Cumulative Balance Validation**:
   - Partial refunds cannot exceed the unpaid balance. Cumulative refunds matching 100% auto-transition to `REFUNDED`.
7. **Immutable Audit Trail**:
   - Every state mutation writes a permanent audit record containing `order_id`, `from_state`, `to_state`, `trigger`, `actor`, `note`, and timestamp.

---

## 🔄 How the AI-SDLC Flow Works For Any New Feature

When adding any capability to this codebase:
1. **Update `01_requirements.md`**: Define user stories, state changes, acceptance criteria, and edge cases.
2. **Update `02_architecture.md`**: Document schema changes, ADRs, and API contracts.
3. **Add Tasks to `03_tasks.md`**: Break the feature into granular steps with verification commands.
4. **TDD Loop**: Write a failing test in `tests/`, implement the code in `app/`, and iterate until green.
5. **Policy Gate Verification**: Run `python .ai-sdlc/sdlc.py verify`.
6. **Commit Guardrail**: Git pre-commit hook ensures no broken invariants ever reach version control.
