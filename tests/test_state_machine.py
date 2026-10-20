import os
import pytest
import tempfile
from pydantic import ValidationError
from app.models.state import (
    OrderStatus,
    TransitionTrigger,
    InvalidStateTransitionError,
    OptimisticLockError,
    OrderNotFoundError,
    InvalidRefundError,
)
from app.models.order import OrderCreateRequest, TransitionRequest
from app.storage.db import Database
from app.services.order_service import OrderService


@pytest.fixture
def temp_db():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    db = Database(db_path=path)
    yield db
    if os.path.exists(path):
        os.remove(path)


@pytest.fixture
def service(temp_db):
    return OrderService(db=temp_db)


# --- 1. Domain Model Validation Tests ---
def test_domain_models():
    # Valid creation
    req = OrderCreateRequest(customer_id="cust_99", amount_cents=1000, currency="usd")
    assert req.currency == "USD"
    assert req.amount_cents == 1000

    # Negative amount rejected
    with pytest.raises(ValidationError):
        OrderCreateRequest(customer_id="cust_99", amount_cents=-500)

    # Zero amount rejected
    with pytest.raises(ValidationError):
        OrderCreateRequest(customer_id="cust_99", amount_cents=0)

    # Empty customer_id rejected
    with pytest.raises(ValidationError):
        OrderCreateRequest(customer_id="   ", amount_cents=1000)


# --- 2. Storage Layer Tests ---
def test_storage(temp_db):
    order = temp_db.create_order("ord_test1", "cust_1", 2500, "USD", "CREATED")
    assert order["id"] == "ord_test1"
    assert order["amount_cents"] == 2500
    assert order["version"] == 1
    assert order["refunded_cents"] == 0

    fetched = temp_db.get_order("ord_test1")
    assert fetched is not None
    assert fetched["current_state"] == "CREATED"


# --- 3. Full Happy Path Lifecycle ---
def test_happy_path_lifecycle(service):
    order = service.create_order(
        OrderCreateRequest(customer_id="alice", amount_cents=4500, currency="USD")
    )
    assert order.current_state == OrderStatus.CREATED
    assert order.version == 1

    # 1. Initiate Payment: CREATED -> PAYMENT_PENDING
    o1 = service.transition_order(
        order.id,
        TransitionRequest(trigger=TransitionTrigger.INITIATE_PAYMENT, actor="alice")
    )
    assert o1.current_state == OrderStatus.PAYMENT_PENDING
    assert o1.version == 2

    # 2. Confirm Payment: PAYMENT_PENDING -> PAID
    o2 = service.transition_order(
        order.id,
        TransitionRequest(trigger=TransitionTrigger.CONFIRM_PAYMENT, actor="stripe_webhook")
    )
    assert o2.current_state == OrderStatus.PAID
    assert o2.version == 3

    # 3. Start Fulfillment: PAID -> PROCESSING
    o3 = service.transition_order(
        order.id,
        TransitionRequest(trigger=TransitionTrigger.START_FULFILLMENT, actor="warehouse_bot")
    )
    assert o3.current_state == OrderStatus.PROCESSING
    assert o3.version == 4

    # 4. Complete Fulfillment: PROCESSING -> FULFILLED
    o4 = service.transition_order(
        order.id,
        TransitionRequest(trigger=TransitionTrigger.COMPLETE_FULFILLMENT, actor="shipping_courier")
    )
    assert o4.current_state == OrderStatus.FULFILLED
    assert o4.version == 5


# --- 4. Illegal Transitions Gate ---
def test_illegal_state_jump(service):
    order = service.create_order(
        OrderCreateRequest(customer_id="bob", amount_cents=1500)
    )
    # Cannot jump from CREATED straight to FULFILLED
    with pytest.raises(InvalidStateTransitionError) as exc_info:
        service.transition_order(
            order.id,
            TransitionRequest(trigger=TransitionTrigger.COMPLETE_FULFILLMENT, actor="admin")
        )
    assert "Cannot perform trigger 'complete_fulfillment' from current state 'CREATED'" in str(exc_info.value)


# --- 5. Terminal State Immutability ---
def test_terminal_state_immutability(service):
    order = service.create_order(
        OrderCreateRequest(customer_id="charlie", amount_cents=2000)
    )
    # Cancel directly from CREATED
    cancelled = service.transition_order(
        order.id,
        TransitionRequest(trigger=TransitionTrigger.CANCEL, actor="customer")
    )
    assert cancelled.current_state == OrderStatus.CANCELLED

    # Attempting any action on CANCELLED order must fail
    with pytest.raises(InvalidStateTransitionError) as exc:
        service.transition_order(
            order.id,
            TransitionRequest(trigger=TransitionTrigger.INITIATE_PAYMENT, actor="customer")
        )
    assert "terminal state 'CANCELLED'" in str(exc.value)


# --- 6. Optimistic Locking Concurrency Conflict ---
def test_optimistic_locking(service):
    order = service.create_order(
        OrderCreateRequest(customer_id="david", amount_cents=3000)
    )
    assert order.version == 1

    # Transition 1 advances version to 2
    service.transition_order(
        order.id,
        TransitionRequest(
            trigger=TransitionTrigger.INITIATE_PAYMENT,
            actor="david",
            expected_version=1
        )
    )

    # Stale request expecting version 1 must be rejected
    with pytest.raises(OptimisticLockError) as exc:
        service.transition_order(
            order.id,
            TransitionRequest(
                trigger=TransitionTrigger.CANCEL,
                actor="david",
                expected_version=1  # Stale! Version is now 2
            )
        )
    assert "Optimistic lock conflict" in str(exc.value)


# --- 7. Idempotency Key Replay ---
def test_idempotency_replay(service):
    order = service.create_order(
        OrderCreateRequest(customer_id="elena", amount_cents=5000)
    )
    # First move to PAYMENT_PENDING
    service.transition_order(
        order.id,
        TransitionRequest(trigger=TransitionTrigger.INITIATE_PAYMENT, actor="elena")
    )

    # Payment confirmation with idempotency key
    idemp_key = "idemp_stripe_ch_999888"
    first_res = service.transition_order(
        order.id,
        TransitionRequest(
            trigger=TransitionTrigger.CONFIRM_PAYMENT,
            actor="webhook",
            idempotency_key=idemp_key
        )
    )
    assert first_res.current_state == OrderStatus.PAID
    initial_version = first_res.version

    # Duplicate call with same idempotency key (simulating network retry)
    replay_res = service.transition_order(
        order.id,
        TransitionRequest(
            trigger=TransitionTrigger.CONFIRM_PAYMENT,
            actor="webhook",
            idempotency_key=idemp_key
        )
    )
    # Must succeed without error and return original state without double-incrementing version
    assert replay_res.current_state == OrderStatus.PAID
    assert replay_res.version == initial_version


# --- 8. Immutable Audit Trail Completeness ---
def test_audit_trail(service):
    order = service.create_order(
        OrderCreateRequest(customer_id="frank", amount_cents=7500)
    )
    service.transition_order(
        order.id,
        TransitionRequest(trigger=TransitionTrigger.INITIATE_PAYMENT, actor="frank", note="Checkout click")
    )
    service.transition_order(
        order.id,
        TransitionRequest(trigger=TransitionTrigger.CANCEL, actor="frank", note="Changed mind")
    )

    history = service.get_order_history(order.id)
    assert len(history) == 3  # Initial creation + 2 transitions
    assert history[0].trigger == "create"
    assert history[1].from_state == OrderStatus.CREATED
    assert history[1].to_state == OrderStatus.PAYMENT_PENDING
    assert history[2].from_state == OrderStatus.PAYMENT_PENDING
    assert history[2].to_state == OrderStatus.CANCELLED
    assert history[2].note == "Changed mind"


# --- 9. Partial Refund ---
def test_partial_refund(service):
    order = service.create_order(
        OrderCreateRequest(customer_id="grace", amount_cents=10000)
    )
    # Advance to PAID
    service.transition_order(order.id, TransitionRequest(trigger=TransitionTrigger.INITIATE_PAYMENT, actor="grace"))
    service.transition_order(order.id, TransitionRequest(trigger=TransitionTrigger.CONFIRM_PAYMENT, actor="stripe"))

    # Partial refund of 3000 cents ($30 out of $100)
    refunded = service.transition_order(
        order.id,
        TransitionRequest(
            trigger=TransitionTrigger.PARTIAL_REFUND,
            actor="admin",
            refund_amount_cents=3000,
            note="Damaged item"
        )
    )
    assert refunded.current_state == OrderStatus.PARTIALLY_REFUNDED
    assert refunded.refunded_cents == 3000

    # Full refund from PARTIALLY_REFUNDED state
    full_refund = service.transition_order(
        order.id,
        TransitionRequest(trigger=TransitionTrigger.REFUND, actor="admin", note="Customer upset")
    )
    assert full_refund.current_state == OrderStatus.REFUNDED
    assert full_refund.refunded_cents == 10000  # All remaining refunded


# --- 10. Partial Refund Exceeding Balance ---
def test_partial_refund_exceeds_balance(service):
    order = service.create_order(
        OrderCreateRequest(customer_id="helen", amount_cents=5000)
    )
    service.transition_order(order.id, TransitionRequest(trigger=TransitionTrigger.INITIATE_PAYMENT, actor="helen"))
    service.transition_order(order.id, TransitionRequest(trigger=TransitionTrigger.CONFIRM_PAYMENT, actor="stripe"))

    # Try to refund more than order total
    with pytest.raises(InvalidRefundError) as exc:
        service.transition_order(
            order.id,
            TransitionRequest(trigger=TransitionTrigger.PARTIAL_REFUND, actor="admin", refund_amount_cents=9999)
        )
    assert "exceeds remaining balance" in str(exc.value)


# --- 11. Expired State ---
def test_expired_state(service):
    order = service.create_order(
        OrderCreateRequest(customer_id="ivan", amount_cents=2500)
    )
    service.transition_order(order.id, TransitionRequest(trigger=TransitionTrigger.INITIATE_PAYMENT, actor="ivan"))

    # Manually expire
    expired = service.transition_order(
        order.id,
        TransitionRequest(trigger=TransitionTrigger.EXPIRE, actor="system_auto_expire", note="Timed out")
    )
    assert expired.current_state == OrderStatus.EXPIRED

    # Terminal: no further transitions allowed
    with pytest.raises(InvalidStateTransitionError):
        service.transition_order(
            order.id,
            TransitionRequest(trigger=TransitionTrigger.CONFIRM_PAYMENT, actor="stripe")
        )


# --- 12. EXPIRED is Terminal ---
def test_expired_terminal_immutability(service):
    order = service.create_order(OrderCreateRequest(customer_id="jack", amount_cents=1000))
    service.transition_order(order.id, TransitionRequest(trigger=TransitionTrigger.INITIATE_PAYMENT, actor="jack"))
    service.transition_order(order.id, TransitionRequest(trigger=TransitionTrigger.EXPIRE, actor="system"))

    with pytest.raises(InvalidStateTransitionError) as exc:
        service.transition_order(order.id, TransitionRequest(trigger=TransitionTrigger.CANCEL, actor="jack"))
    assert "terminal state 'EXPIRED'" in str(exc.value)
