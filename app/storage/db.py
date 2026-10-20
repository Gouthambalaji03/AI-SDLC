import sqlite3
import json
import os
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any, Tuple


class Database:
    def __init__(self, db_path: str = "stateflow.db"):
        self.db_path = db_path
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        # Enable WAL mode for high concurrency
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        return conn

    def _init_db(self):
        with self._get_connection() as conn:
            conn.executescript("""
            CREATE TABLE IF NOT EXISTS orders (
                id TEXT PRIMARY KEY,
                customer_id TEXT NOT NULL,
                amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
                currency TEXT NOT NULL DEFAULT 'USD',
                current_state TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                refunded_cents INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS audit_logs (
                id TEXT PRIMARY KEY,
                order_id TEXT NOT NULL,
                from_state TEXT,
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
            """)

    def create_order(self, order_id: str, customer_id: str, amount_cents: int, currency: str, initial_state: str) -> Dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO orders (id, customer_id, amount_cents, currency, current_state, version, refunded_cents, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)
                """,
                (order_id, customer_id, amount_cents, currency, initial_state, now, now)
            )
        return self.get_order(order_id)

    def insert_audit_log(
        self,
        audit_id: str,
        order_id: str,
        from_state: Optional[str],
        to_state: str,
        trigger: str,
        actor: str,
        note: Optional[str] = None
    ):
        now = datetime.now(timezone.utc).isoformat()
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO audit_logs (id, order_id, from_state, to_state, trigger, actor, note, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (audit_id, order_id, from_state, to_state, trigger, actor, note, now)
            )

    def get_order(self, order_id: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            cursor = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,))
            row = cursor.fetchone()
            if row:
                result = dict(row)
                # Ensure refunded_cents exists for backward compatibility
                if "refunded_cents" not in result:
                    result["refunded_cents"] = 0
                return result
            return None

    def update_order_state(
        self,
        order_id: str,
        expected_version: int,
        to_state: str,
        audit_id: str,
        from_state: str,
        trigger: str,
        actor: str,
        note: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        idempotency_payload: Optional[str] = None,
        refund_amount_cents: int = 0
    ) -> Tuple[bool, Optional[Dict[str, Any]]]:
        """
        Atomically updates the order state with optimistic locking, records audit log,
        and optionally records the idempotency key in a single transaction.
        Returns: (success_bool, updated_order_or_none)
        """
        now = datetime.now(timezone.utc).isoformat()
        with self._get_connection() as conn:
            # 1. Atomic update conditional on expected_version
            cursor = conn.execute(
                """
                UPDATE orders
                SET current_state = ?, version = version + 1, updated_at = ?,
                    refunded_cents = refunded_cents + ?
                WHERE id = ? AND version = ?
                """,
                (to_state, now, refund_amount_cents, order_id, expected_version)
            )
            if cursor.rowcount == 0:
                # Version mismatch or order missing
                return False, None

            # 2. Insert audit log
            conn.execute(
                """
                INSERT INTO audit_logs (id, order_id, from_state, to_state, trigger, actor, note, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (audit_id, order_id, from_state, to_state, trigger, actor, note, now)
            )

            # 3. Insert idempotency key if provided
            if idempotency_key and idempotency_payload:
                conn.execute(
                    """
                    INSERT INTO idempotency_keys (key, order_id, action, response_json, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (idempotency_key, order_id, trigger, idempotency_payload, now)
                )

        return True, self.get_order(order_id)

    def get_audit_logs(self, order_id: str) -> List[Dict[str, Any]]:
        with self._get_connection() as conn:
            cursor = conn.execute(
                "SELECT * FROM audit_logs WHERE order_id = ? ORDER BY created_at ASC",
                (order_id,)
            )
            return [dict(row) for row in cursor.fetchall()]

    def get_idempotency_record(self, key: str) -> Optional[Dict[str, Any]]:
        with self._get_connection() as conn:
            cursor = conn.execute("SELECT * FROM idempotency_keys WHERE key = ?", (key,))
            row = cursor.fetchone()
            if row:
                return dict(row)
            return None

    def get_stale_pending_orders(self, cutoff_iso: str) -> List[Dict[str, Any]]:
        """Find all orders in PAYMENT_PENDING state created before the cutoff time."""
        with self._get_connection() as conn:
            cursor = conn.execute(
                """
                SELECT * FROM orders
                WHERE current_state = 'PAYMENT_PENDING' AND updated_at < ?
                """,
                (cutoff_iso,)
            )
            return [dict(row) for row in cursor.fetchall()]
