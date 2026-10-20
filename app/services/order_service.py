import uuid
import json
from datetime import datetime, timezone, timedelta
from typing import List, Optional
from app.models.state import (
    OrderStatus,
    TransitionTrigger,
    TRANSITION_MATRIX,
    TERMINAL_STATES,
    InvalidStateTransitionError,
    OrderNotFoundError,
    OptimisticLockError,
    InvalidRefundError,
)
from app.models.order import (
    OrderCreateRequest,
    TransitionRequest,
    OrderResponse,
    AuditLogResponse,
    StateTransitionRule,
    TransitionMatrixResponse,
    ExpireStaleResponse,
)
from app.storage.db import Database


class OrderService:
    def __init__(self, db: Optional[Database] = None):
        self.db = db or Database()

    def create_order(self, request: OrderCreateRequest) -> OrderResponse:
        order_id = f"ord_{uuid.uuid4().hex[:12]}"
        initial_state = OrderStatus.CREATED.value
        
        row = self.db.create_order(
            order_id=order_id,
            customer_id=request.customer_id,
            amount_cents=request.amount_cents,
            currency=request.currency,
            initial_state=initial_state,
        )
        
        # Initial audit log
        audit_id = f"aud_{uuid.uuid4().hex[:12]}"
        self.db.insert_audit_log(
            audit_id=audit_id,
            order_id=order_id,
            from_state=None,
            to_state=initial_state,
            trigger="create",
            actor=request.customer_id,
            note="Order created",
        )

        return OrderResponse(**row)

    def get_order(self, order_id: str) -> OrderResponse:
        row = self.db.get_order(order_id)
        if not row:
            raise OrderNotFoundError(order_id)
        return OrderResponse(**row)

    def transition_order(self, order_id: str, request: TransitionRequest) -> OrderResponse:
        # 1. Idempotency Check
        if request.idempotency_key:
            record = self.db.get_idempotency_record(request.idempotency_key)
            if record:
                cached_data = json.loads(record["response_json"])
                return OrderResponse(**cached_data)

        # 2. Retrieve existing order
        order = self.db.get_order(order_id)
        if not order:
            raise OrderNotFoundError(order_id)

        current_state = OrderStatus(order["current_state"])
        current_version = order["version"]

        # 3. Check for Terminal State violation
        if current_state in TERMINAL_STATES:
            raise InvalidStateTransitionError(
                current_state=current_state,
                trigger=request.trigger,
                message=f"Order '{order_id}' is in terminal state '{current_state.value}' and cannot be modified."
            )

        # 4. Check Allowed Transition Matrix
        transition_key = (current_state, request.trigger)
        if transition_key not in TRANSITION_MATRIX:
            raise InvalidStateTransitionError(
                current_state=current_state,
                trigger=request.trigger
            )

        next_state = TRANSITION_MATRIX[transition_key]

        # 5. Check Optimistic Lock Version
        if request.expected_version is not None and request.expected_version != current_version:
            raise OptimisticLockError(
                order_id=order_id,
                expected_version=request.expected_version,
                actual_version=current_version
            )

        # 6. Partial refund amount validation
        refund_amount = 0
        if request.trigger == TransitionTrigger.PARTIAL_REFUND:
            if request.refund_amount_cents is None or request.refund_amount_cents <= 0:
                raise InvalidRefundError("partial_refund requires a positive refund_amount_cents.")
            remaining = order["amount_cents"] - order.get("refunded_cents", 0)
            if request.refund_amount_cents > remaining:
                raise InvalidRefundError(
                    f"Refund amount ({request.refund_amount_cents} cents) exceeds remaining balance ({remaining} cents)."
                )
            refund_amount = request.refund_amount_cents

        # 7. Full refund sets refund_amount to full remaining balance
        if request.trigger == TransitionTrigger.REFUND:
            remaining = order["amount_cents"] - order.get("refunded_cents", 0)
            refund_amount = remaining

        # 8. Execute Atomic Transition in Database
        audit_id = f"aud_{uuid.uuid4().hex[:12]}"
        
        # Prepare payload for idempotency key storage
        temp_response = {
            "id": order_id,
            "customer_id": order["customer_id"],
            "amount_cents": order["amount_cents"],
            "currency": order["currency"],
            "current_state": next_state.value,
            "version": current_version + 1,
            "refunded_cents": order.get("refunded_cents", 0) + refund_amount,
            "created_at": order["created_at"],
            "updated_at": "PENDING"
        }
        idempotency_payload = json.dumps(temp_response) if request.idempotency_key else None

        note = request.note
        if refund_amount > 0 and not note:
            note = f"Refunded {refund_amount} cents"

        success, updated_order = self.db.update_order_state(
            order_id=order_id,
            expected_version=current_version,
            to_state=next_state.value,
            audit_id=audit_id,
            from_state=current_state.value,
            trigger=request.trigger.value,
            actor=request.actor,
            note=note,
            idempotency_key=request.idempotency_key,
            idempotency_payload=idempotency_payload,
            refund_amount_cents=refund_amount,
        )

        if not success or not updated_order:
            # Re-fetch order to report actual version
            latest = self.db.get_order(order_id)
            actual_version = latest["version"] if latest else -1
            raise OptimisticLockError(
                order_id=order_id,
                expected_version=current_version,
                actual_version=actual_version
            )

        return OrderResponse(**updated_order)

    def expire_stale_orders(self, timeout_minutes: int = 30) -> ExpireStaleResponse:
        """Find and expire all PAYMENT_PENDING orders older than timeout_minutes."""
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=timeout_minutes)
        cutoff_iso = cutoff.isoformat()
        stale_orders = self.db.get_stale_pending_orders(cutoff_iso)

        expired_ids = []
        for order in stale_orders:
            try:
                self.transition_order(
                    order["id"],
                    TransitionRequest(
                        trigger=TransitionTrigger.EXPIRE,
                        actor="system_auto_expire",
                        note=f"Auto-expired after {timeout_minutes} minutes in PAYMENT_PENDING"
                    )
                )
                expired_ids.append(order["id"])
            except (InvalidStateTransitionError, OptimisticLockError):
                # Skip orders that were already transitioned by another process
                pass

        return ExpireStaleResponse(expired_count=len(expired_ids), expired_order_ids=expired_ids)

    def get_order_history(self, order_id: str) -> List[AuditLogResponse]:
        # Ensure order exists
        self.get_order(order_id)
        logs = self.db.get_audit_logs(order_id)
        return [AuditLogResponse(**log) for log in logs]

    def get_transition_matrix(self) -> TransitionMatrixResponse:
        rules = [
            StateTransitionRule(from_state=s, trigger=t, to_state=target)
            for (s, t), target in TRANSITION_MATRIX.items()
        ]
        return TransitionMatrixResponse(
            transitions=rules,
            terminal_states=list(TERMINAL_STATES)
        )
