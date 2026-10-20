import os
import tempfile
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.api.routes import get_order_service
from app.storage.db import Database
from app.services.order_service import OrderService


@pytest.fixture
def client():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    test_db = Database(db_path=path)
    test_service = OrderService(db=test_db)

    # Override dependency
    app.dependency_overrides[get_order_service] = lambda: test_service

    with TestClient(app) as test_client:
        yield test_client

    app.dependency_overrides.clear()
    if os.path.exists(path):
        os.remove(path)


def test_api_root(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"


def test_api_matrix(client):
    response = client.get("/api/v1/orders/matrix")
    assert response.status_code == 200
    data = response.json()
    assert "transitions" in data
    assert "terminal_states" in data
    assert len(data["transitions"]) > 0
    # Verify new states appear
    terminal_states = data["terminal_states"]
    assert "EXPIRED" in terminal_states


def test_api_create_and_lifecycle(client):
    # 1. Create Order
    create_payload = {
        "customer_id": "cust_api_123",
        "amount_cents": 8990,
        "currency": "USD"
    }
    create_res = client.post("/api/v1/orders", json=create_payload)
    assert create_res.status_code == 201
    order = create_res.json()
    order_id = order["id"]
    assert order["current_state"] == "CREATED"
    assert order["version"] == 1
    assert order["refunded_cents"] == 0

    # 2. Advance to PAYMENT_PENDING
    trans_payload = {
        "trigger": "initiate_payment",
        "actor": "customer",
        "note": "User clicked Pay Now"
    }
    t1_res = client.post(f"/api/v1/orders/{order_id}/transitions", json=trans_payload)
    assert t1_res.status_code == 200
    assert t1_res.json()["current_state"] == "PAYMENT_PENDING"
    assert t1_res.json()["version"] == 2

    # 3. Confirm Payment
    t2_payload = {
        "trigger": "confirm_payment",
        "actor": "stripe",
        "idempotency_key": "stripe_evt_001"
    }
    t2_res = client.post(f"/api/v1/orders/{order_id}/transitions", json=t2_payload)
    assert t2_res.status_code == 200
    assert t2_res.json()["current_state"] == "PAID"

    # 4. Check Audit History
    hist_res = client.get(f"/api/v1/orders/{order_id}/history")
    assert hist_res.status_code == 200
    history = hist_res.json()
    assert len(history) == 3
    assert history[0]["trigger"] == "create"
    assert history[1]["to_state"] == "PAYMENT_PENDING"
    assert history[2]["to_state"] == "PAID"


def test_api_illegal_transition_returns_409(client):
    # Create order
    create_res = client.post("/api/v1/orders", json={"customer_id": "cust_fail", "amount_cents": 1000})
    order_id = create_res.json()["id"]

    # Attempt illegal jump directly to FULFILLED
    bad_trans = {
        "trigger": "complete_fulfillment",
        "actor": "admin"
    }
    res = client.post(f"/api/v1/orders/{order_id}/transitions", json=bad_trans)
    assert res.status_code == 409
    detail = res.json()["detail"]
    assert detail["error"] == "INVALID_STATE_TRANSITION"
    assert detail["current_state"] == "CREATED"


def test_api_optimistic_lock_conflict_returns_409(client):
    # Create order
    create_res = client.post("/api/v1/orders", json={"customer_id": "cust_lock", "amount_cents": 2500})
    order_id = create_res.json()["id"]

    # Advance to PAYMENT_PENDING (version becomes 2)
    client.post(f"/api/v1/orders/{order_id}/transitions", json={"trigger": "initiate_payment"})

    # Send request expecting version 1
    conflict_trans = {
        "trigger": "cancel",
        "expected_version": 1  # Conflict!
    }
    res = client.post(f"/api/v1/orders/{order_id}/transitions", json=conflict_trans)
    assert res.status_code == 409
    detail = res.json()["detail"]
    assert detail["error"] == "OPTIMISTIC_LOCK_CONFLICT"
    assert detail["expected_version"] == 1
    assert detail["actual_version"] == 2


def test_api_validation_errors(client):
    # Negative amount
    res = client.post("/api/v1/orders", json={"customer_id": "cust_1", "amount_cents": -50})
    assert res.status_code == 422  # Pydantic validation error

    # Non-existent order
    res = client.get("/api/v1/orders/ord_nonexistent")
    assert res.status_code == 404


def test_api_partial_refund(client):
    # Create and advance to PAID
    create_res = client.post("/api/v1/orders", json={"customer_id": "cust_pr", "amount_cents": 10000})
    oid = create_res.json()["id"]
    client.post(f"/api/v1/orders/{oid}/transitions", json={"trigger": "initiate_payment", "actor": "cust_pr"})
    client.post(f"/api/v1/orders/{oid}/transitions", json={"trigger": "confirm_payment", "actor": "stripe"})

    # Partial refund
    res = client.post(f"/api/v1/orders/{oid}/transitions", json={
        "trigger": "partial_refund",
        "actor": "admin",
        "refund_amount_cents": 2500,
        "note": "Partial refund for damaged item"
    })
    assert res.status_code == 200
    assert res.json()["current_state"] == "PARTIALLY_REFUNDED"
    assert res.json()["refunded_cents"] == 2500


def test_api_partial_refund_exceeds_returns_400(client):
    create_res = client.post("/api/v1/orders", json={"customer_id": "cust_exc", "amount_cents": 5000})
    oid = create_res.json()["id"]
    client.post(f"/api/v1/orders/{oid}/transitions", json={"trigger": "initiate_payment", "actor": "cust_exc"})
    client.post(f"/api/v1/orders/{oid}/transitions", json={"trigger": "confirm_payment", "actor": "stripe"})

    res = client.post(f"/api/v1/orders/{oid}/transitions", json={
        "trigger": "partial_refund",
        "actor": "admin",
        "refund_amount_cents": 99999
    })
    assert res.status_code == 400
    assert res.json()["detail"]["error"] == "INVALID_REFUND"


def test_api_expire_endpoint(client):
    # The expire-stale endpoint should exist and return 200
    res = client.post("/api/v1/orders/expire-stale?timeout_minutes=1")
    assert res.status_code == 200
    data = res.json()
    assert "expired_count" in data
    assert "expired_order_ids" in data


def test_api_list_orders(client):
    # Create an order and verify it appears in list
    res_create = client.post("/api/v1/orders", json={"customer_id": "cust_list_test", "amount_cents": 1250})
    oid = res_create.json()["id"]

    res_list = client.get("/api/v1/orders")
    assert res_list.status_code == 200
    orders = res_list.json()
    assert isinstance(orders, list)
    assert any(o["id"] == oid for o in orders)


def test_api_metrics_summary(client):
    res = client.get("/api/v1/orders/stats/summary")
    assert res.status_code == 200
    data = res.json()
    assert "total_orders" in data
    assert "active_gmv_cents" in data
    assert "fulfilled_count" in data
    assert "stale_pending_count" in data
    assert "refunded_cents" in data
    assert "state_distribution" in data

