from enum import Enum
from typing import Dict, Tuple, Set, Optional


class OrderStatus(str, Enum):
    CREATED = "CREATED"
    PAYMENT_PENDING = "PAYMENT_PENDING"
    PAID = "PAID"
    PROCESSING = "PROCESSING"
    FULFILLED = "FULFILLED"
    CANCELLED = "CANCELLED"
    REFUNDED = "REFUNDED"
    PARTIALLY_REFUNDED = "PARTIALLY_REFUNDED"
    FAILED = "FAILED"
    EXPIRED = "EXPIRED"


class TransitionTrigger(str, Enum):
    INITIATE_PAYMENT = "initiate_payment"
    CONFIRM_PAYMENT = "confirm_payment"
    PAYMENT_FAILED = "payment_failed"
    START_FULFILLMENT = "start_fulfillment"
    COMPLETE_FULFILLMENT = "complete_fulfillment"
    CANCEL = "cancel"
    REFUND = "refund"
    PARTIAL_REFUND = "partial_refund"
    EXPIRE = "expire"


# Set of terminal states from which no further transitions are allowed
TERMINAL_STATES: Set[OrderStatus] = {
    OrderStatus.FULFILLED,
    OrderStatus.CANCELLED,
    OrderStatus.REFUNDED,
    OrderStatus.FAILED,
    OrderStatus.EXPIRED,
}

# The explicit deterministic State Transition Matrix
TRANSITION_MATRIX: Dict[Tuple[OrderStatus, TransitionTrigger], OrderStatus] = {
    (OrderStatus.CREATED, TransitionTrigger.INITIATE_PAYMENT): OrderStatus.PAYMENT_PENDING,
    (OrderStatus.CREATED, TransitionTrigger.CANCEL): OrderStatus.CANCELLED,
    (OrderStatus.PAYMENT_PENDING, TransitionTrigger.CONFIRM_PAYMENT): OrderStatus.PAID,
    (OrderStatus.PAYMENT_PENDING, TransitionTrigger.PAYMENT_FAILED): OrderStatus.FAILED,
    (OrderStatus.PAYMENT_PENDING, TransitionTrigger.CANCEL): OrderStatus.CANCELLED,
    (OrderStatus.PAYMENT_PENDING, TransitionTrigger.EXPIRE): OrderStatus.EXPIRED,
    (OrderStatus.PAID, TransitionTrigger.START_FULFILLMENT): OrderStatus.PROCESSING,
    (OrderStatus.PAID, TransitionTrigger.REFUND): OrderStatus.REFUNDED,
    (OrderStatus.PAID, TransitionTrigger.PARTIAL_REFUND): OrderStatus.PARTIALLY_REFUNDED,
    (OrderStatus.PROCESSING, TransitionTrigger.COMPLETE_FULFILLMENT): OrderStatus.FULFILLED,
    (OrderStatus.PROCESSING, TransitionTrigger.REFUND): OrderStatus.REFUNDED,
    (OrderStatus.PROCESSING, TransitionTrigger.PARTIAL_REFUND): OrderStatus.PARTIALLY_REFUNDED,
    (OrderStatus.PARTIALLY_REFUNDED, TransitionTrigger.REFUND): OrderStatus.REFUNDED,
}


class DomainError(Exception):
    """Base domain exception."""
    pass


class InvalidStateTransitionError(DomainError):
    def __init__(self, current_state: OrderStatus, trigger: TransitionTrigger, message: Optional[str] = None):
        allowed_triggers = [
            t.value for (s, t) in TRANSITION_MATRIX.keys() if s == current_state
        ]
        msg = message or (
            f"Cannot perform trigger '{trigger.value}' from current state '{current_state.value}'. "
            f"Allowed triggers for this state: {allowed_triggers if allowed_triggers else 'None (Terminal state)'}"
        )
        super().__init__(msg)
        self.current_state = current_state
        self.trigger = trigger
        self.allowed_triggers = allowed_triggers


class OrderNotFoundError(DomainError):
    def __init__(self, order_id: str):
        super().__init__(f"Order with ID '{order_id}' was not found.")
        self.order_id = order_id


class OptimisticLockError(DomainError):
    def __init__(self, order_id: str, expected_version: int, actual_version: int):
        super().__init__(
            f"Optimistic lock conflict on order '{order_id}'. "
            f"Expected version: {expected_version}, but actual version is: {actual_version}."
        )
        self.order_id = order_id
        self.expected_version = expected_version
        self.actual_version = actual_version


class InvalidRefundError(DomainError):
    def __init__(self, message: str):
        super().__init__(message)
