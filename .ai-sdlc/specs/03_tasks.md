# Phase 3: Task Decomposition — StateFlow Engine v2

This file acts as the executable queue for coding and QA agents. Each task must pass its verification command before being checked off.

## Completed (v1)
- [x] **Task 1: Domain Models & State Machine Engine**
- [x] **Task 2: Storage Layer & Concurrency Engine**
- [x] **Task 3: Order Service (Business Logic & Audit Trail)**
- [x] **Task 4: Comprehensive QA Unit Test Suite**
- [x] **Task 5: FastAPI REST API & Exception Handlers**
- [x] **Task 6: AI-SDLC Tooling Runner & Policy Gate**

## v2: New Features & Platform Expansion (Completed)

- [x] **Task 7: Add EXPIRED and PARTIALLY_REFUNDED states + transitions**
  - Files: `app/models/state.py`, `app/models/order.py`, `app/storage/db.py`
  - Invariants: New enum values, transition matrix additions, `refunded_cents` column, `expire` and `partial_refund` triggers.
  - Verification: `python -m pytest tests/ -v`

- [x] **Task 8: Partial Refund & Auto-Expiration business logic**
  - Files: `app/services/order_service.py`
  - Invariants: Validate refund_amount_cents > 0 and <= remaining, cumulative refund tracking, batch expire stale orders.
  - Verification: `python -m pytest tests/ -v`

- [x] **Task 9: New feature QA tests (partial refund, expiration, PARTIALLY_REFUNDED transitions)**
  - Files: `tests/test_state_machine.py`, `tests/test_api_integration.py`
  - Verification: `python -m pytest tests/ -v`

- [x] **Task 10: Visual Dashboard (HTML/CSS/JS served by FastAPI)**
  - Files: `app/static/index.html`, `app/static/style.css`, `app/static/app.js`, `app/main.py`
  - Invariants: Interactive order simulator, live state progress, audit timeline, state machine diagram.
  - Verification: Open `http://localhost:8000` in browser.

- [x] **Task 11: CI/CD GitHub Actions & Pre-Commit Hook**
  - Files: `.github/workflows/ai-sdlc.yml`, `.githooks/pre-commit`, `.ai-sdlc/sdlc.py`
  - Invariants: Auto-run `sdlc.py verify` on push/PR. Pre-commit blocks bad commits locally.
  - Verification: `python .ai-sdlc/sdlc.py verify` && `python .ai-sdlc/sdlc.py install-hooks`
