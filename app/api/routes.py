from fastapi import APIRouter, Depends, HTTPException, Query, status
from typing import List
from app.models.order import (
    OrderCreateRequest,
    TransitionRequest,
    OrderResponse,
    AuditLogResponse,
    TransitionMatrixResponse,
    ExpireStaleResponse,
)
from app.models.state import (
    InvalidStateTransitionError,
    OrderNotFoundError,
    OptimisticLockError,
    InvalidRefundError,
)
from app.services.order_service import OrderService

router = APIRouter(prefix="/api/v1/orders", tags=["Orders"])

# Dependency to provide service instance
def get_order_service() -> OrderService:
    return OrderService()


@router.post(
    "",
    response_model=OrderResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a new Order in CREATED state"
)
def create_order(
    request: OrderCreateRequest,
    service: OrderService = Depends(get_order_service)
):
    try:
        return service.create_order(request)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))


@router.get(
    "/matrix",
    response_model=TransitionMatrixResponse,
    summary="Retrieve the allowed State Transition Matrix"
)
def get_matrix(service: OrderService = Depends(get_order_service)):
    return service.get_transition_matrix()


@router.post(
    "/expire-stale",
    response_model=ExpireStaleResponse,
    summary="Batch-expire orders stuck in PAYMENT_PENDING beyond timeout"
)
def expire_stale(
    timeout_minutes: int = Query(default=30, ge=1, description="Minutes after which a PAYMENT_PENDING order is considered stale"),
    service: OrderService = Depends(get_order_service)
):
    return service.expire_stale_orders(timeout_minutes=timeout_minutes)


@router.get(
    "/{order_id}",
    response_model=OrderResponse,
    summary="Get order details by ID"
)
def get_order(
    order_id: str,
    service: OrderService = Depends(get_order_service)
):
    try:
        return service.get_order(order_id)
    except OrderNotFoundError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@router.post(
    "/{order_id}/transitions",
    response_model=OrderResponse,
    summary="Transition order to a new state"
)
def transition_order(
    order_id: str,
    request: TransitionRequest,
    service: OrderService = Depends(get_order_service)
):
    try:
        return service.transition_order(order_id, request)
    except OrderNotFoundError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    except InvalidStateTransitionError as e:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "INVALID_STATE_TRANSITION",
                "message": str(e),
                "current_state": e.current_state.value,
                "trigger": e.trigger.value,
                "allowed_triggers": e.allowed_triggers,
            }
        )
    except OptimisticLockError as e:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "OPTIMISTIC_LOCK_CONFLICT",
                "message": str(e),
                "expected_version": e.expected_version,
                "actual_version": e.actual_version,
            }
        )
    except InvalidRefundError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "INVALID_REFUND",
                "message": str(e),
            }
        )


@router.get(
    "/{order_id}/history",
    response_model=List[AuditLogResponse],
    summary="Get full audit trail history for an order"
)
def get_order_history(
    order_id: str,
    service: OrderService = Depends(get_order_service)
):
    try:
        return service.get_order_history(order_id)
    except OrderNotFoundError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
