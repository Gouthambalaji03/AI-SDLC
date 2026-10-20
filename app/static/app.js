// ===================================
// StateFlow Dashboard — Application Logic
// ===================================

const API_BASE = '/api/v1/orders';
let currentOrder = null;
let visitedStates = new Set();

// ====== TRIGGER METADATA ======
const TRIGGER_META = {
    initiate_payment:    { label: 'Initiate Payment',    style: 'btn-action',          actor: 'customer' },
    confirm_payment:     { label: 'Confirm Payment',     style: 'btn-action btn-success', actor: 'stripe_webhook' },
    payment_failed:      { label: 'Payment Failed',      style: 'btn-action btn-danger',  actor: 'payment_gateway' },
    start_fulfillment:   { label: 'Start Fulfillment',   style: 'btn-action',          actor: 'warehouse' },
    complete_fulfillment:{ label: 'Complete Fulfillment', style: 'btn-action btn-success', actor: 'shipping_courier' },
    cancel:              { label: 'Cancel Order',        style: 'btn-action btn-danger',  actor: 'customer' },
    refund:              { label: 'Full Refund',         style: 'btn-action btn-warn',    actor: 'admin' },
    partial_refund:      { label: 'Partial Refund',      style: 'btn-action btn-warn',    actor: 'admin' },
    expire:              { label: 'Expire',              style: 'btn-action btn-danger',  actor: 'system_auto_expire' },
};

// ====== INITIALIZE ======
document.addEventListener('DOMContentLoaded', () => {
    loadTransitionMatrix();
    checkApiHealth();
});

async function checkApiHealth() {
    try {
        const res = await fetch('/');
        if (res.ok) {
            document.getElementById('api-status').textContent = 'API Connected';
            document.getElementById('api-status').className = 'badge badge-green';
        }
    } catch {
        document.getElementById('api-status').textContent = 'API Offline';
        document.getElementById('api-status').className = 'badge badge-red';
    }
}

// ====== CREATE ORDER ======
async function createOrder() {
    hideError();
    const customer = document.getElementById('inp-customer').value.trim();
    const amount = parseInt(document.getElementById('inp-amount').value, 10);
    const currency = document.getElementById('inp-currency').value.trim();

    if (!customer || !amount || amount <= 0) {
        showError('Please provide a valid customer ID and a positive amount.');
        return;
    }

    try {
        const res = await fetch(API_BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ customer_id: customer, amount_cents: amount, currency })
        });

        if (!res.ok) {
            const err = await res.json();
            showError(JSON.stringify(err.detail || err, null, 2));
            return;
        }

        currentOrder = await res.json();
        visitedStates = new Set();
        updateUI();
        loadAuditTrail();
    } catch (e) {
        showError('Network error: ' + e.message);
    }
}

// ====== TRANSITION ORDER ======
async function performTransition(trigger) {
    hideError();
    if (!currentOrder) return;

    // If partial_refund, show input instead of executing immediately
    if (trigger === 'partial_refund') {
        document.getElementById('partial-refund-group').classList.remove('hidden');
        return;
    }

    const meta = TRIGGER_META[trigger] || {};
    try {
        const res = await fetch(`${API_BASE}/${currentOrder.id}/transitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trigger, actor: meta.actor || 'system' })
        });

        if (!res.ok) {
            const err = await res.json();
            const detail = err.detail;
            if (typeof detail === 'object') {
                showError(`${detail.error}\n${detail.message}`);
            } else {
                showError(JSON.stringify(detail, null, 2));
            }
            return;
        }

        currentOrder = await res.json();
        updateUI();
        loadAuditTrail();
    } catch (e) {
        showError('Network error: ' + e.message);
    }
}

// ====== PARTIAL REFUND ======
async function executePartialRefund() {
    hideError();
    const refundAmount = parseInt(document.getElementById('inp-refund-amount').value, 10);
    if (!refundAmount || refundAmount <= 0) {
        showError('Enter a positive refund amount in cents.');
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/${currentOrder.id}/transitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                trigger: 'partial_refund',
                actor: 'admin',
                refund_amount_cents: refundAmount,
                note: `Partial refund of ${refundAmount} cents`
            })
        });

        if (!res.ok) {
            const err = await res.json();
            const detail = err.detail;
            if (typeof detail === 'object') {
                showError(`${detail.error}\n${detail.message}`);
            } else {
                showError(JSON.stringify(detail, null, 2));
            }
            return;
        }

        currentOrder = await res.json();
        document.getElementById('partial-refund-group').classList.add('hidden');
        document.getElementById('inp-refund-amount').value = '';
        updateUI();
        loadAuditTrail();
    } catch (e) {
        showError('Network error: ' + e.message);
    }
}

// ====== UPDATE UI ======
function updateUI() {
    if (!currentOrder) return;

    // Show panels
    document.getElementById('card-order-info').classList.remove('hidden');
    document.getElementById('card-actions').classList.remove('hidden');

    // Update order info
    const state = currentOrder.current_state;
    document.getElementById('lbl-order-id').textContent = currentOrder.id;
    document.getElementById('lbl-amount').textContent = formatCents(currentOrder.amount_cents, currentOrder.currency);
    document.getElementById('lbl-refunded').textContent = formatCents(currentOrder.refunded_cents || 0, currentOrder.currency);
    document.getElementById('lbl-version').textContent = `v${currentOrder.version}`;

    const stateBadge = document.getElementById('lbl-state');
    stateBadge.textContent = state;
    stateBadge.setAttribute('data-state', state);

    // Track visited states
    visitedStates.add(state);

    // Update state machine diagram
    updateStateDiagram(state);

    // Update available actions
    updateActionButtons(state);
}

function updateStateDiagram(activeState) {
    const allNodes = document.querySelectorAll('.sm-node');
    allNodes.forEach(node => {
        const nodeState = node.getAttribute('data-state');
        node.classList.remove('active', 'visited');
        if (nodeState === activeState) {
            node.classList.add('active');
        } else if (visitedStates.has(nodeState)) {
            node.classList.add('visited');
        }
    });
}

function updateActionButtons(state) {
    const container = document.getElementById('action-buttons');
    container.innerHTML = '';

    // Hide partial refund input when switching states
    document.getElementById('partial-refund-group').classList.add('hidden');

    // Find allowed triggers for current state from the transition matrix
    const matrixBody = document.getElementById('tbl-matrix-body');
    const rows = matrixBody.querySelectorAll('tr');
    const allowedTriggers = [];

    rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 3 && cells[0].textContent === state) {
            allowedTriggers.push(cells[1].textContent);
        }
    });

    if (allowedTriggers.length === 0) {
        container.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:16px;font-size:0.82rem;">Terminal state reached. No further actions available.</div>';
        return;
    }

    allowedTriggers.forEach(trigger => {
        const meta = TRIGGER_META[trigger] || { label: trigger, style: 'btn-action' };
        const btn = document.createElement('button');
        btn.className = `btn ${meta.style}`;
        btn.textContent = meta.label;
        btn.onclick = () => performTransition(trigger);
        container.appendChild(btn);
    });
}

// ====== AUDIT TRAIL ======
async function loadAuditTrail() {
    if (!currentOrder) return;

    try {
        const res = await fetch(`${API_BASE}/${currentOrder.id}/history`);
        if (!res.ok) return;

        const history = await res.json();
        const container = document.getElementById('audit-timeline');
        container.innerHTML = '';

        history.forEach((entry, idx) => {
            const el = document.createElement('div');
            el.className = 'timeline-entry';

            const time = new Date(entry.created_at).toLocaleTimeString();
            const fromLabel = entry.from_state || 'NONE';
            const toLabel = entry.to_state;

            el.innerHTML = `
                <div class="timeline-dot-wrapper">
                    <div class="timeline-dot" style="background:${getDotColor(toLabel)}; box-shadow:0 0 8px ${getDotColor(toLabel)};"></div>
                    ${idx < history.length - 1 ? '<div class="timeline-line"></div>' : ''}
                </div>
                <div class="timeline-content">
                    <div class="timeline-header">
                        <span class="timeline-trigger">${entry.trigger}</span>
                        <span class="timeline-time">${time}</span>
                    </div>
                    <div class="timeline-detail">
                        <div class="timeline-states">
                            <span>${fromLabel}</span>
                            <span class="arrow">&rarr;</span>
                            <span style="color:${getDotColor(toLabel)}">${toLabel}</span>
                        </div>
                    </div>
                    <div class="timeline-actor">by ${entry.actor}</div>
                    ${entry.note ? `<div class="timeline-note">${entry.note}</div>` : ''}
                </div>
            `;
            container.appendChild(el);
        });
    } catch (e) {
        console.error('Failed to load audit trail:', e);
    }
}

// ====== TRANSITION MATRIX ======
async function loadTransitionMatrix() {
    try {
        const res = await fetch(`${API_BASE}/matrix`);
        if (!res.ok) return;

        const data = await res.json();
        const tbody = document.getElementById('tbl-matrix-body');
        tbody.innerHTML = '';

        data.transitions.forEach(rule => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${rule.from_state}</td><td>${rule.trigger}</td><td>${rule.to_state}</td>`;
            tbody.appendChild(tr);
        });
    } catch (e) {
        console.error('Failed to load matrix:', e);
    }
}

// ====== HELPERS ======
function formatCents(cents, currency = 'USD') {
    return `$${(cents / 100).toFixed(2)} ${currency}`;
}

function getDotColor(state) {
    const colors = {
        CREATED: '#06b6d4',
        PAYMENT_PENDING: '#f59e0b',
        PAID: '#22c55e',
        PROCESSING: '#6366f1',
        FULFILLED: '#4ade80',
        CANCELLED: '#ef4444',
        REFUNDED: '#a855f7',
        PARTIALLY_REFUNDED: '#f59e0b',
        FAILED: '#f87171',
        EXPIRED: '#94a3b8',
    };
    return colors[state] || '#6366f1';
}

function showError(msg) {
    const card = document.getElementById('card-error');
    card.classList.remove('hidden');
    document.getElementById('error-message').textContent = msg;
}

function hideError() {
    document.getElementById('card-error').classList.add('hidden');
}
