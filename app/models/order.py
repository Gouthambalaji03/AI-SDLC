from typing import Optional, List
from pydantic import BaseModel, Field, field_validator
from .state import OrderStatus, TransitionTrigger


class OrderCreateRequest(BaseModel):
    customer_id: str = Field(..., min_length=1, description="Unique customer identifier")
    amount_cents: int = Field(..., gt=0, description="Order total in integer cents (> 0)")
    currency: str = Field(default="USD", min_length=3, max_length=3, description="ISO 4217 Currency code")

    @field_validator("customer_id")
    @classmethod
    def validate_customer_id(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("customer_id cannot be empty or whitespace")
        return v.strip()

    @field_validator("currency")
    @classmethod
    def validate_currency(cls, v: str) -> str:
        return v.upper()


class TransitionRequest(BaseModel):
    trigger: TransitionTrigger = Field(..., description="Action to advance state machine")
    actor: str = Field(default="system", min_length=1, description="Actor initiating the transition")
    idempotency_key: Optional[str] = Field(None, description="Optional key to prevent duplicate execution")
    expected_version: Optional[int] = Field(None, description="Expected order version for optimistic locking")
    note: Optional[str] = Field(None, max_length=255, description="Audit note or explanation")
    refund_amount_cents: Optional[int] = Field(None, gt=0, description="Amount to refund in cents (for partial_refund trigger)")


class OrderResponse(BaseModel):
    id: str
    customer_id: str
    amount_cents: int
    currency: str
    current_state: OrderStatus
    version: int
    refunded_cents: int = 0
    created_at: str
    updated_at: str


class AuditLogResponse(BaseModel):
    id: str
    order_id: str
    from_state: Optional[OrderStatus] = None
    to_state: OrderStatus
    trigger: str
    actor: str
    note: Optional[str] = None
    created_at: str


class StateTransitionRule(BaseModel):
    from_state: OrderStatus
    trigger: TransitionTrigger
    to_state: OrderStatus


class TransitionMatrixResponse(BaseModel):
    transitions: List[StateTransitionRule]
    terminal_states: List[OrderStatus]


class ExpireStaleResponse(BaseModel):
    expired_count: int
    expired_order_ids: List[str]


class MetricsResponse(BaseModel):
    total_orders: int
    active_gmv_cents: int
    fulfilled_count: int
    stale_pending_count: int
    refunded_cents: int
    state_distribution: dict

