// ========================================================================== //
//  StateFlow — Minimal, Clean & Reactive Client Logic                        //
// ========================================================================== //

const API_BASE = '/api/v1/orders';

let currentOrder = null;
let allOrders = [];
let matrixRules = [];
let terminalStates = [];

// Friendly Trigger Names
const TRIGGER_LABELS = {
    initiate_payment: 'Initiate Payment ➔',
    confirm_payment: 'Confirm Payment ➔',
    start_processing: 'Start Processing ➔',
    ship_order: 'Ship & Fulfill ➔',
    partial_refund: 'Partial Refund...',
    refund_order: 'Full Refund',
    cancel_order: 'Cancel Order',
    expire: 'Expire Order',
    fail_payment: 'Fail Payment'
};

// Stepper Linear Order
const STEP_ORDER = ['CREATED', 'PAYMENT_PENDING', 'PAID', 'PROCESSING', 'FULFILLED'];

// ========================================================================== //
//  LIFECYCLE & INITIALIZATION                                                //
// ========================================================================== //

document.addEventListener('DOMContentLoaded', async () => {
    await fetchMatrix();
    await fetchDashboardState();

    if (allOrders.length > 0) {
        selectOrder(allOrders[0].id);
    }
});

function formatMoney(cents, currency = 'USD') {
    if (isNaN(cents)) return '$0.00';
    return (cents / 100).toLocaleString('en-US', {
        style: 'currency',
        currency: currency || 'USD',
        minimumFractionDigits: 2
    });
}

function timeAgo(dateString) {
    const diff = Math.floor((new Date() - new Date(dateString)) / 1000);
    if (diff < 5) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    const mins = Math.floor(diff / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return new Date(dateString).toLocaleDateString();
}

// ========================================================================== //
//  API CALLS                                                                 //
// ========================================================================== //

async function fetchMatrix() {
    try {
        const res = await fetch(`${API_BASE}/matrix`);
        if (res.ok) {
            const data = await res.json();
            matrixRules = data.transitions || [];
            terminalStates = data.terminal_states || [];
        }
    } catch (err) {
        console.error('Matrix load error:', err);
    }
}

async function fetchDashboardState() {
    try {
        const [ordersRes, statsRes] = await Promise.all([
            fetch(`${API_BASE}?limit=50`),
            fetch(`${API_BASE}/stats/summary`)
        ]);

        if (ordersRes.ok) {
            allOrders = await ordersRes.json();
            renderOrdersTable();
            const badge = document.getElementById('lbl-orders-count');
            if (badge) badge.textContent = allOrders.length;
        }

        if (statsRes.ok) {
            const stats = await statsRes.json();
            
            // Populate KPI Strip
            const kpiVol = document.getElementById('kpi-volume');
            const kpiOrd = document.getElementById('kpi-orders');
            const kpiSet = document.getElementById('kpi-settlement');
            const kpiPen = document.getElementById('kpi-pending');

            if (kpiVol) kpiVol.textContent = formatMoney(stats.active_gmv_cents || 0);
            if (kpiOrd) kpiOrd.textContent = stats.total_orders || 0;
            if (kpiPen) kpiPen.textContent = stats.stale_pending_count || 0;

            if (kpiSet) {
                const total = stats.total_orders || 0;
                const bad = (stats.state_distribution?.CANCELLED || 0) + (stats.state_distribution?.FAILED || 0) + (stats.state_distribution?.EXPIRED || 0);
                const rate = total > 0 ? (((total - bad) / total) * 100).toFixed(1) : '100.0';
                kpiSet.textContent = `${rate}%`;
            }

            const staleBadge = document.getElementById('stale-count');
            if (staleBadge) {
                if (stats.stale_pending_count > 0) {
                    staleBadge.textContent = stats.stale_pending_count;
                    staleBadge.classList.remove('hidden');
                } else {
                    staleBadge.classList.add('hidden');
                }
            }
        }

        if (currentOrder) {
            const single = await fetch(`${API_BASE}/${currentOrder.id}`);
            if (single.ok) {
                const refreshed = await single.json();
                renderOrderHero(refreshed);
            }
        }
    } catch (err) {
        console.error('Dashboard state error:', err);
    }
}

// ========================================================================== //
//  ACTIVE ORDER HERO & STEPPER                                               //
// ========================================================================== //

async function selectOrder(orderId) {
    try {
        const res = await fetch(`${API_BASE}/${orderId}`);
        if (!res.ok) throw new Error('Order not found');
        const order = await res.json();
        renderOrderHero(order);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function renderOrderHero(order) {
    currentOrder = order;

    // Header items
    document.getElementById('disp-order-id').textContent = order.id;
    document.getElementById('disp-version').textContent = `v${order.version}`;
    
    const statusPill = document.getElementById('disp-status');
    statusPill.textContent = order.current_state;
    updateStatusPillStyle(statusPill, order.current_state);

    // Amount & Subtitle
    document.getElementById('disp-amount').textContent = formatMoney(order.amount_cents, order.currency);
    document.getElementById('disp-currency').textContent = order.currency;

    const refundSub = document.getElementById('disp-refund-sub');
    if (order.refunded_cents > 0) {
        const remaining = Math.max(0, order.amount_cents - order.refunded_cents);
        refundSub.innerHTML = `
            <span class="customer-tag">${order.customer_id}</span>
            <span style="font-size:12px; color:var(--brand-amber); margin-left:8px;">
                ${formatMoney(order.refunded_cents, order.currency)} refunded (${formatMoney(remaining, order.currency)} balance)
            </span>
        `;
    } else {
        refundSub.innerHTML = `<span class="customer-tag">${order.customer_id}</span>`;
    }

    // Stepper updates
    updateLifecycleStepper(order.current_state);

    // Actions rendering
    renderActionButtons(order);

    // Payload viewer & timeline
    syncPayloadViewer(order);
    fetchAuditTrail(order.id);

    // Table row highlight
    highlightSelectedRow(order.id);
}

function updateLifecycleStepper(state) {
    const stepper = document.getElementById('lifecycle-stepper');
    const banner = document.getElementById('special-state-banner');
    const bannerTitle = document.getElementById('banner-title');
    const bannerDesc = document.getElementById('banner-desc');

    const currIdx = STEP_ORDER.indexOf(state);

    if (currIdx !== -1) {
        // Linear Happy Path state
        banner.classList.add('hidden');
        stepper.style.opacity = '1';

        STEP_ORDER.forEach((s, idx) => {
            const stepEl = document.getElementById(`step-${s}`);
            if (stepEl) {
                stepEl.classList.remove('active', 'completed');
                if (idx < currIdx) {
                    stepEl.classList.add('completed');
                } else if (idx === currIdx) {
                    stepEl.classList.add('active');
                }
            }

            if (idx > 0) {
                const line = document.getElementById(`line-${idx}`);
                if (line) {
                    line.classList.toggle('completed', idx <= currIdx);
                }
            }
        });
    } else {
        // Alternative Branch State (CANCELLED, EXPIRED, REFUNDED, PARTIALLY_REFUNDED, FAILED)
        banner.classList.remove('hidden');
        bannerTitle.textContent = `State Notice: ${state}`;

        if (state === 'PARTIALLY_REFUNDED') {
            bannerDesc.textContent = 'A portion of funds has been refunded. Order remains eligible for further refunds or fulfillment.';
        } else if (state === 'EXPIRED') {
            bannerDesc.textContent = 'Order expired after exceeding payment session timeout. Concurrency locked.';
        } else if (state === 'CANCELLED') {
            bannerDesc.textContent = 'Order was cancelled before fulfillment completed.';
        } else if (state === 'REFUNDED') {
            bannerDesc.textContent = '100% of order value has been returned to the payer.';
        } else if (state === 'FAILED') {
            bannerDesc.textContent = 'Payment gateway flagged a failure during settlement.';
        }
    }
}

function renderActionButtons(order) {
    const container = document.getElementById('primary-actions-container');
    container.innerHTML = '';
    closeRefundBar();

    const allowed = matrixRules.filter(r => r.from_state === order.current_state);

    if (allowed.length === 0) {
        container.innerHTML = `
            <span style="font-size:12px; color:var(--text-faint); padding:6px 0;">
                No transitions available. Order has reached terminal status.
            </span>
        `;
        return;
    }

    // Determine primary forward action
    const forwardTriggers = ['initiate_payment', 'confirm_payment', 'start_processing', 'ship_order'];

    allowed.forEach(rule => {
        const btn = document.createElement('button');
        btn.className = 'btn-state-action';
        if (forwardTriggers.includes(rule.trigger)) {
            btn.classList.add('featured');
        }

        btn.textContent = TRIGGER_LABELS[rule.trigger] || rule.trigger;

        btn.onclick = () => {
            if (rule.trigger === 'partial_refund') {
                openRefundBar();
            } else {
                executeTransition(rule.trigger);
            }
        };

        container.appendChild(btn);
    });
}

async function executeTransition(trigger, refundAmount = null, note = null) {
    if (!currentOrder) return;

    const actor = document.getElementById('sel-actor').value || 'customer';
    const payload = {
        trigger: trigger,
        actor: actor,
        idempotency_key: `idemp_${Date.now()}`,
        expected_version: currentOrder.version,
        note: note || `Dispatched transition ${trigger}`
    };

    if (refundAmount !== null) {
        payload.refund_amount_cents = refundAmount;
    }

    try {
        const res = await fetch(`${API_BASE}/${currentOrder.id}/transitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const err = await res.json();
            showToast(err.detail?.message || err.detail || 'Transition rejected', 'error');
            return;
        }

        const updated = await res.json();
        showToast(`Moved to ${updated.current_state}`, 'success');
        renderOrderHero(updated);
        await fetchDashboardState();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// Partial Refund Helpers
function openRefundBar() {
    const bar = document.getElementById('refund-inline-bar');
    if (bar) bar.classList.remove('hidden');

    const remaining = currentOrder ? Math.max(0, currentOrder.amount_cents - (currentOrder.refunded_cents || 0)) : 0;
    const inp = document.getElementById('inp-refund-cents');
    if (inp) {
        inp.value = Math.floor(remaining / 2);
        inp.max = remaining;
    }
}

function closeRefundBar() {
    const bar = document.getElementById('refund-inline-bar');
    if (bar) bar.classList.add('hidden');
}

function setRefundPct(pct) {
    if (!currentOrder) return;
    const remaining = Math.max(0, currentOrder.amount_cents - (currentOrder.refunded_cents || 0));
    const inp = document.getElementById('inp-refund-cents');
    if (inp) inp.value = Math.floor(remaining * pct);
}

function confirmPartialRefund() {
    const inp = document.getElementById('inp-refund-cents');
    const amount = parseInt(inp.value, 10);
    if (isNaN(amount) || amount <= 0) {
        showToast('Please enter an amount > 0 cents', 'warning');
        return;
    }
    executeTransition('partial_refund', amount, 'Partial refund via dashboard');
}

// ========================================================================== //
//  AUDIT TRAIL & TABLE                                                       //
// ========================================================================== //

async function fetchAuditTrail(orderId) {
    const list = document.getElementById('timeline-list');
    try {
        const res = await fetch(`${API_BASE}/${orderId}/history`);
        if (!res.ok) throw new Error('Could not load history');
        const logs = await res.json();

        if (logs.length === 0) {
            list.innerHTML = `<div class="empty-state">No events recorded.</div>`;
            return;
        }

        list.innerHTML = '';
        logs.forEach(log => {
            const row = document.createElement('div');
            row.className = 'timeline-row';
            row.innerHTML = `
                <div class="timeline-main">
                    <span class="timeline-trigger">${log.trigger}</span>
                    <span class="timeline-arrow">➔</span>
                    <span class="timeline-state">${log.to_state}</span>
                    <span class="timeline-actor">by ${log.actor}</span>
                </div>
                <span class="timeline-time">${timeAgo(log.created_at)}</span>
            `;
            list.appendChild(row);
        });
    } catch (err) {
        console.error('Audit trail error:', err);
    }
}

function renderOrdersTable() {
    const tbody = document.getElementById('orders-tbody');
    if (!tbody) return;

    if (allOrders.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="empty-state">No orders in database.</td></tr>`;
        return;
    }

    tbody.innerHTML = '';
    allOrders.forEach(order => {
        const tr = document.createElement('tr');
        tr.id = `row-${order.id}`;
        if (currentOrder && currentOrder.id === order.id) tr.classList.add('selected');

        tr.innerHTML = `
            <td class="font-mono" style="font-weight:600; color:#fff;">${order.id}</td>
            <td><span class="font-mono" style="font-size:10px; font-weight:700;">${order.current_state}</span></td>
            <td class="font-mono">${formatMoney(order.amount_cents, order.currency)}</td>
            <td>${order.customer_id}</td>
            <td style="color:var(--text-faint);">${timeAgo(order.updated_at)}</td>
        `;

        tr.onclick = () => selectOrder(order.id);
        tbody.appendChild(tr);
    });
}

function highlightSelectedRow(orderId) {
    document.querySelectorAll('#orders-tbody tr').forEach(tr => {
        tr.classList.toggle('selected', tr.id === `row-${orderId}`);
    });
}

function syncPayloadViewer(order) {
    const el = document.getElementById('raw-json');
    if (el) el.textContent = JSON.stringify(order, null, 2);
}

// ========================================================================== //
//  NEW ORDER MODAL                                                           //
// ========================================================================== //

function openNewOrderModal() {
    const m = document.getElementById('new-order-modal');
    if (m) m.classList.remove('hidden');
}

function closeNewOrderModal() {
    const m = document.getElementById('new-order-modal');
    if (m) m.classList.add('hidden');
}

function quickFillPreset(customer, amountCents) {
    document.getElementById('new-customer').value = customer;
    document.getElementById('new-amount').value = amountCents;
    document.getElementById('new-currency').value = 'USD';
}

async function submitNewOrder() {
    const customer = document.getElementById('new-customer').value.trim();
    const amount = parseInt(document.getElementById('new-amount').value, 10);
    const currency = document.getElementById('new-currency').value.trim().toUpperCase();

    if (!customer || isNaN(amount) || amount <= 0) {
        showToast('Please enter customer ID and positive amount', 'warning');
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
            throw new Error(err.detail || 'Could not create order');
        }

        const newOrder = await res.json();
        closeNewOrderModal();
        showToast('Order created', 'success');
        
        await fetchDashboardState();
        renderOrderHero(newOrder);
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// Auto Expire Action
async function triggerAutoExpire() {
    try {
        const res = await fetch(`${API_BASE}/expire-stale?timeout_minutes=1`, { method: 'POST' });
        if (!res.ok) throw new Error('Auto-expire failed');
        const data = await res.json();
        if (data.expired_count > 0) {
            showToast(`Expired ${data.expired_count} stale orders`, 'warning');
        } else {
            showToast('No stale orders to expire', 'info');
        }
        await fetchDashboardState();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

// Tab Switching
function switchTab(tab) {
    ['activity', 'history', 'raw'].forEach(t => {
        const btn = document.getElementById(`tab-btn-${t}`);
        const pane = document.getElementById(`pane-${t}`);
        if (btn && pane) {
            btn.classList.toggle('active', t === tab);
            pane.classList.toggle('active', t === tab);
        }
    });
}

function updateStatusPillStyle(pill, state) {
    const terminal = terminalStates.includes(state);
    if (terminal) {
        pill.style.background = 'rgba(244, 63, 94, 0.12)';
        pill.style.color = '#fda4af';
        pill.style.borderColor = 'rgba(244, 63, 94, 0.3)';
    } else {
        pill.style.background = 'rgba(16, 185, 129, 0.12)';
        pill.style.color = 'var(--brand-emerald)';
        pill.style.borderColor = 'rgba(16, 185, 129, 0.3)';
    }
}

function copyOrderId() {
    if (!currentOrder) return;
    navigator.clipboard.writeText(currentOrder.id);
    showToast('Order ID copied', 'info');
}

// Toast System
function showToast(message, type = 'info') {
    const stack = document.getElementById('toast-stack');
    if (!stack) return;

    const item = document.createElement('div');
    item.className = `toast-item ${type}`;
    item.innerHTML = `<span class="toast-dot"></span><span>${message}</span>`;

    stack.appendChild(item);
    setTimeout(() => {
        item.style.opacity = '0';
        item.style.transition = 'opacity 150ms ease';
        setTimeout(() => item.remove(), 150);
    }, 3000);
}
