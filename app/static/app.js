// ========================================================================== //
//  StateFlow Engine — Human-Engineered Reactive Client (Linear / Temporal UX) //
// ========================================================================== //

const API_BASE = '/api/v1/orders';

// Application State Store
let activeOrder = null;
let transitionRules = [];
let terminalStateList = [];
let visitedStateHistory = new Set();
let cachedLedgerOrders = [];
let ledgerFilterMode = 'ALL';
let lastExecutedIdempKey = null;
let lastExecutedTrigger = null;

// Clean Lucide-Style SVG Icons (14x14, stroke 1.5)
const SVG_ICONS = {
    credit_card: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"></rect><line x1="1" y1="10" x2="23" y2="10"></line></svg>`,
    check_circle: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`,
    package: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"></line><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`,
    truck: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg>`,
    rotate_ccw: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>`,
    x_circle: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`,
    clock: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`,
    zap: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`
};

// Trigger Action Specifications
const TRIGGER_SPECS = {
    initiate_payment: { label: 'Initiate Checkout', icon: SVG_ICONS.credit_card },
    confirm_payment: { label: 'Capture Funds', icon: SVG_ICONS.check_circle },
    fail_payment: { label: 'Flag Decline', icon: SVG_ICONS.x_circle },
    cancel_order: { label: 'Cancel Order', icon: SVG_ICONS.x_circle },
    expire: { label: 'Expire Session', icon: SVG_ICONS.clock },
    start_processing: { label: 'Dispatch to Picking', icon: SVG_ICONS.package },
    ship_order: { label: 'Mark Fulfilled', icon: SVG_ICONS.truck },
    partial_refund: { label: 'Partial Refund', icon: SVG_ICONS.rotate_ccw },
    refund_order: { label: 'Full Settlement Reversal', icon: SVG_ICONS.rotate_ccw }
};

// Node Invariant Specifications
const NODE_SPECS = {
    CREATED: {
        tag: 'Initial State',
        summary: 'Order entity initialized. Invariant: amount_cents > 0, currency ISO 4217, version=1.',
        allowed: ['initiate_payment ➔ PAYMENT_PENDING', 'cancel_order ➔ CANCELLED']
    },
    PAYMENT_PENDING: {
        tag: 'Transient Gateway Hold',
        summary: 'External payment transaction in flight. Eligible for 30m batch auto-expiration (ADR-005).',
        allowed: ['confirm_payment ➔ PAID', 'fail_payment ➔ FAILED', 'cancel_order ➔ CANCELLED', 'expire ➔ EXPIRED']
    },
    PAID: {
        tag: 'Capital Settled',
        summary: 'Monetary settlement captured. Eligible for warehouse routing or customer refund.',
        allowed: ['start_processing ➔ PROCESSING', 'partial_refund ➔ PARTIALLY_REFUNDED', 'refund_order ➔ REFUNDED', 'cancel_order ➔ CANCELLED']
    },
    PROCESSING: {
        tag: 'Warehouse Fulfillment',
        summary: 'Inventory physically assembled and labeled. Concurrency lock guards shipment tracking write.',
        allowed: ['ship_order ➔ FULFILLED', 'cancel_order ➔ CANCELLED']
    },
    FULFILLED: {
        tag: 'Terminal Success',
        summary: 'Carrier delivery verified. Terminal milestone. Partial or full refund remains permitted post-fulfillment.',
        allowed: ['partial_refund ➔ PARTIALLY_REFUNDED', 'refund_order ➔ REFUNDED']
    },
    CANCELLED: {
        tag: 'Terminal Exit',
        summary: 'Order voided prior to fulfillment. Terminal state; version cannot advance further.',
        allowed: ['None (Terminal)']
    },
    FAILED: {
        tag: 'Terminal Error',
        summary: 'Payment rejected by gateway processor. Terminal state.',
        allowed: ['None (Terminal)']
    },
    EXPIRED: {
        tag: 'Terminal Timeout (v2)',
        summary: 'Uncompleted payment session auto-purged by batch expiration worker (ADR-005).',
        allowed: ['None (Terminal)']
    },
    PARTIALLY_REFUNDED: {
        tag: 'Multi-Tier Balance (v2)',
        summary: 'Cumulative refunds calculated via integer cents subtraction. Auto-promotes to REFUNDED at 100% (ADR-004).',
        allowed: ['partial_refund ➔ PARTIALLY_REFUNDED', 'refund_order ➔ REFUNDED']
    },
    REFUNDED: {
        tag: 'Terminal Capital Reversal',
        summary: '100% of order value returned to payer. Terminal immutable state.',
        allowed: ['None (Terminal)']
    }
};

// ========================================================================== //
//  INITIALIZATION & LIFECYCLE HOOKS                                          //
// ========================================================================== //

document.addEventListener('DOMContentLoaded', async () => {
    bindFormListeners();
    await loadTransitionRegistry();
    await refreshDashboardData(true);

    if (cachedLedgerOrders.length > 0) {
        selectOrderInstance(cachedLedgerOrders[0].id);
    }

    // Auto-sync polling every 12 seconds
    setInterval(() => refreshDashboardData(true), 12000);
});

function bindFormListeners() {
    const inp = document.getElementById('inp-amount');
    if (inp) {
        inp.addEventListener('input', () => {
            const cents = parseInt(inp.value, 10) || 0;
            const preview = document.getElementById('lbl-calc-amount');
            if (preview) preview.textContent = formatCurrency(cents);
        });
    }
}

function formatCurrency(cents, currency = 'USD') {
    if (isNaN(cents)) return '$0.00';
    return (cents / 100).toLocaleString('en-US', {
        style: 'currency',
        currency: currency || 'USD',
        minimumFractionDigits: 2
    });
}

function formatRelativeTime(dateStr) {
    const past = new Date(dateStr);
    const diff = Math.floor((new Date() - past) / 1000);
    if (diff < 5) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    const mins = Math.floor(diff / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return past.toLocaleDateString();
}

// ========================================================================== //
//  DATA RETRIEVAL                                                            //
// ========================================================================== //

async function loadTransitionRegistry() {
    try {
        const res = await fetch(`${API_BASE}/matrix`);
        if (!res.ok) throw new Error('Registry unavailable');
        const data = await res.json();
        transitionRules = data.transitions || [];
        terminalStateList = data.terminal_states || [];
        renderMatrixRegistryTable(transitionRules);
    } catch (err) {
        showToast('System Error', 'Unable to retrieve transition matrix: ' + err.message, 'error');
    }
}

async function refreshDashboardData(silent = false) {
    try {
        const [statsRes, listRes] = await Promise.all([
            fetch(`${API_BASE}/stats/summary`),
            fetch(`${API_BASE}?limit=50`)
        ]);

        if (statsRes.ok) {
            const stats = await statsRes.json();
            renderTelemetryMetrics(stats);
        }

        if (listRes.ok) {
            cachedLedgerOrders = await listRes.json();
            renderLedgerList();
            const badge = document.getElementById('ledger-count-badge');
            if (badge) badge.textContent = cachedLedgerOrders.length;
        }

        if (activeOrder) {
            const liveRes = await fetch(`${API_BASE}/${activeOrder.id}`);
            if (liveRes.ok) {
                const refreshed = await liveRes.json();
                renderActiveOrderDeck(refreshed);
            }
        }

        if (!silent) {
            showToast('Synchronized', 'Live state telemetry synchronized with database', 'info', 1500);
        }
    } catch (err) {
        console.error('Telemetry refresh error:', err);
    }
}

function renderTelemetryMetrics(stats) {
    const valGmv = document.getElementById('val-gmv');
    const valOrders = document.getElementById('val-total-orders');
    const breakdown = document.getElementById('val-order-breakdown');
    const valSettlement = document.getElementById('val-settlement-rate');
    const detailSettlement = document.getElementById('val-settlement-detail');
    const valRefunded = document.getElementById('val-refunded-volume');
    const detailRefunded = document.getElementById('val-refunded-detail');
    const hdrActive = document.getElementById('hdr-active-count');
    const staleCountBadge = document.getElementById('stale-order-count');

    if (valGmv) valGmv.textContent = formatCurrency(stats.active_gmv_cents || 0);
    if (valOrders) valOrders.textContent = stats.total_orders || 0;
    if (breakdown) breakdown.textContent = `${stats.fulfilled_count || 0} fulfilled`;

    const total = stats.total_orders || 0;
    const failures = (stats.state_distribution?.CANCELLED || 0) + (stats.state_distribution?.FAILED || 0) + (stats.state_distribution?.EXPIRED || 0);
    const rate = total > 0 ? (((total - failures) / total) * 100).toFixed(1) : '100.0';
    if (valSettlement) valSettlement.textContent = `${rate}%`;
    if (detailSettlement) detailSettlement.textContent = `${stats.fulfilled_count || 0} / ${total} orders`;

    if (valRefunded) valRefunded.textContent = formatCurrency(stats.refunded_cents || 0);
    if (detailRefunded) detailRefunded.textContent = `${stats.state_distribution?.PARTIALLY_REFUNDED || 0} partials`;

    const activeCount = total - (stats.fulfilled_count || 0) - failures;
    if (hdrActive) hdrActive.textContent = `${Math.max(0, activeCount)} in-flight`;

    const staleCount = stats.stale_pending_count || 0;
    if (staleCountBadge) {
        if (staleCount > 0) {
            staleCountBadge.textContent = staleCount;
            staleCountBadge.classList.remove('hidden');
        } else {
            staleCountBadge.classList.add('hidden');
        }
    }
}

// ========================================================================== //
//  SIMULATOR & ORDER EXECUTION                                               //
// ========================================================================== //

function applyPreset(type) {
    const custInp = document.getElementById('inp-customer');
    const amtInp = document.getElementById('inp-amount');
    const currInp = document.getElementById('inp-currency');
    const preview = document.getElementById('lbl-calc-amount');

    const presets = {
        ecommerce: { cust: 'cust_sneaker_drop', amt: 12000, curr: 'USD' },
        saas: { cust: 'cust_cloud_infra', amt: 4900, curr: 'USD' },
        micropay: { cust: 'cust_reader_micro', amt: 850, curr: 'USD' },
        enterprise: { cust: 'cust_megacorp_b2b', amt: 250000, curr: 'USD' }
    };

    const p = presets[type];
    if (p) {
        if (custInp) custInp.value = p.cust;
        if (amtInp) amtInp.value = p.amt;
        if (currInp) currInp.value = p.curr;
        if (preview) preview.textContent = formatCurrency(p.amt, p.curr);
        showToast('Template Applied', `Form configured for ${p.cust}`, 'info', 1500);
    }
}

async function createOrder() {
    const customerId = document.getElementById('inp-customer').value.trim();
    const amountCents = parseInt(document.getElementById('inp-amount').value, 10);
    const currency = document.getElementById('inp-currency').value.trim().toUpperCase();

    if (!customerId || isNaN(amountCents) || amountCents <= 0) {
        showToast('Validation Error', 'Customer ID and integer cents (> 0) required', 'error');
        return;
    }

    try {
        const res = await fetch(API_BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ customer_id: customerId, amount_cents: amountCents, currency })
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || 'Order creation failed');
        }

        const newOrder = await res.json();
        visitedStateHistory = new Set();
        showToast('Order Instantiated', `Instance ${newOrder.id} active in CREATED state`, 'success');

        await refreshDashboardData(true);
        renderActiveOrderDeck(newOrder);
    } catch (err) {
        showToast('Failed to Create Order', err.message, 'error');
    }
}

async function selectOrderInstance(orderId) {
    try {
        const res = await fetch(`${API_BASE}/${orderId}`);
        if (!res.ok) throw new Error('Order not found');
        const order = await res.json();
        visitedStateHistory = new Set();
        renderActiveOrderDeck(order);
    } catch (err) {
        showToast('Fetch Error', err.message, 'error');
    }
}

function renderActiveOrderDeck(order) {
    activeOrder = order;
    visitedStateHistory.add(order.current_state);

    const activeCard = document.getElementById('card-active-order');
    if (activeCard) activeCard.classList.remove('hidden');

    // Header Metadata
    document.getElementById('lbl-active-order-id').textContent = order.id;
    document.getElementById('lbl-active-version').textContent = `v${order.version}`;
    
    const stateTag = document.getElementById('lbl-active-state');
    stateTag.textContent = order.current_state;

    // Financial calculations
    const totalFmt = formatCurrency(order.amount_cents, order.currency);
    const refFmt = formatCurrency(order.refunded_cents || 0, order.currency);
    const remainingCents = Math.max(0, order.amount_cents - (order.refunded_cents || 0));
    const remFmt = formatCurrency(remainingCents, order.currency);

    document.getElementById('lbl-hud-total').textContent = totalFmt;
    document.getElementById('lbl-hud-refunded').textContent = refFmt;
    document.getElementById('lbl-hud-remaining').textContent = remFmt;

    const progressPct = Math.min(100, ((order.refunded_cents || 0) / order.amount_cents) * 100);
    const bar = document.getElementById('hud-progress-bar');
    if (bar) bar.style.width = `${progressPct}%`;

    // Dynamic Action Deck
    renderAvailableTransitions(order);

    // Sync SVG DAG Canvas
    syncDagCanvasState(order.current_state);

    // Sync Raw JSON Inspector
    syncJsonViewer(order);

    // Sync Stream History
    fetchOrderAuditHistory();

    // Sync Active Row Highlight in Ledger
    highlightLedgerRow(order.id);
}

function renderAvailableTransitions(order) {
    const list = document.getElementById('deck-action-buttons');
    const countLabel = document.getElementById('lbl-trigger-count');
    list.innerHTML = '';
    closePartialRefundDrawer();

    const allowed = transitionRules.filter(r => r.from_state === order.current_state);
    if (countLabel) countLabel.textContent = `${allowed.length} available`;

    if (allowed.length === 0) {
        list.innerHTML = `
            <div style="padding:10px; text-align:center; color:var(--text-muted); font-size:11px; background:var(--surface-base); border-radius:6px; border:1px solid var(--border-hairline);">
                Terminal State: <strong>${order.current_state}</strong>. Concurrency gate locks all further transitions.
            </div>
        `;
        return;
    }

    allowed.forEach(rule => {
        const spec = TRIGGER_SPECS[rule.trigger] || { label: rule.trigger, icon: SVG_ICONS.zap };
        const btn = document.createElement('button');
        btn.className = 'btn-trigger-item';
        btn.innerHTML = `
            <div class="trigger-left">
                <span style="display:flex; align-items:center; color:var(--text-secondary);">${spec.icon}</span>
                <span>${spec.label}</span>
            </div>
            <span class="trigger-target-tag">➔ ${rule.to_state}</span>
        `;

        btn.onclick = () => {
            if (rule.trigger === 'partial_refund') {
                openPartialRefundDrawer();
            } else {
                executeTransition(rule.trigger);
            }
        };

        list.appendChild(btn);
    });
}

async function executeTransition(trigger, refundCents = null, note = null) {
    if (!activeOrder) return;

    const actor = document.getElementById('sel-actor-role').value || 'customer';
    const idempKey = `idemp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    lastExecutedIdempKey = idempKey;
    lastExecutedTrigger = trigger;

    const payload = {
        trigger,
        actor,
        idempotency_key: idempKey,
        expected_version: activeOrder.version,
        note: note || `Dispatched via StateFlow Control Deck`
    };

    if (refundCents !== null) {
        payload.refund_amount_cents = refundCents;
    }

    try {
        const res = await fetch(`${API_BASE}/${activeOrder.id}/transitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const err = await res.json();
            handleApiErrorResponse(res.status, err);
            return;
        }

        const updated = await res.json();
        showToast('Transition Executed', `${activeOrder.current_state} ➔ ${updated.current_state}`, 'success');
        
        renderActiveOrderDeck(updated);
        await refreshDashboardData(true);
    } catch (err) {
        showToast('Network Exception', err.message, 'error');
    }
}

// Partial Refund Drawer
function openPartialRefundDrawer() {
    const drawer = document.getElementById('drawer-partial-refund');
    if (drawer) drawer.classList.remove('hidden');

    const remaining = activeOrder ? Math.max(0, activeOrder.amount_cents - (activeOrder.refunded_cents || 0)) : 0;
    const inp = document.getElementById('inp-refund-amount');
    if (inp) {
        inp.value = Math.floor(remaining / 2);
        inp.max = remaining;
    }
}

function closePartialRefundDrawer() {
    const drawer = document.getElementById('drawer-partial-refund');
    if (drawer) drawer.classList.add('hidden');
}

function setRefundPercentage(pct) {
    if (!activeOrder) return;
    const remaining = Math.max(0, activeOrder.amount_cents - (activeOrder.refunded_cents || 0));
    const val = Math.floor(remaining * pct);
    const inp = document.getElementById('inp-refund-amount');
    if (inp) inp.value = val;
}

function submitPartialRefund() {
    const inp = document.getElementById('inp-refund-amount');
    const reasonInp = document.getElementById('inp-refund-reason');
    const amount = parseInt(inp.value, 10);
    const reason = reasonInp ? reasonInp.value.trim() : null;

    if (isNaN(amount) || amount <= 0) {
        showToast('Validation Error', 'Refund amount must be an integer > 0 cents', 'warning');
        return;
    }

    executeTransition('partial_refund', amount, reason);
}

// ========================================================================== //
//  ADR CONFORMANCE & CHAOS SANDBOX                                           //
// ========================================================================== //

function switchWorkbenchMode(mode) {
    const tabSim = document.getElementById('tab-simulator');
    const tabChaos = document.getElementById('tab-chaos');
    const viewSim = document.getElementById('wb-view-simulator');
    const viewChaos = document.getElementById('wb-view-chaos');

    if (mode === 'simulator') {
        tabSim.classList.add('active');
        tabChaos.classList.remove('active');
        viewSim.classList.remove('hidden');
        viewChaos.classList.add('hidden');
    } else {
        tabChaos.classList.add('active');
        tabSim.classList.remove('active');
        viewChaos.classList.remove('hidden');
        viewSim.classList.add('hidden');
    }
}

async function simulateConcurrencyClash() {
    if (!activeOrder) return;
    showToast('Testing Concurrency', 'Sending transition with expected_version = 0...', 'info', 1500);

    const payload = {
        trigger: 'initiate_payment',
        actor: 'concurrent_process_alpha',
        expected_version: 0,
        note: 'Chaos Test: Deliberate Optimistic Lock Version Clash'
    };

    try {
        const res = await fetch(`${API_BASE}/${activeOrder.id}/transitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (res.status === 409) {
            showToast('Lock Invariant Verified', `HTTP 409 Conflict: Expected v0, actual is v${activeOrder.version}. Data race successfully intercepted.`, 'warning', 5000);
            syncJsonViewer(data);
        }
    } catch (err) {
        showToast('Error', err.message, 'error');
    }
}

async function simulateIdempotentReplay() {
    if (!activeOrder) return;
    if (!lastExecutedIdempKey) {
        showToast('No Prior Event', 'Execute a valid transition first so an idempotency key is cached.', 'warning');
        return;
    }

    showToast('Replaying Key', `Dispatching duplicate event key: ${lastExecutedIdempKey}...`, 'info', 1500);

    const payload = {
        trigger: lastExecutedTrigger || 'confirm_payment',
        actor: 'stripe_webhook_retry_daemon',
        idempotency_key: lastExecutedIdempKey,
        expected_version: activeOrder.version,
        note: 'Chaos Test: Duplicate Webhook Delivery'
    };

    try {
        const res = await fetch(`${API_BASE}/${activeOrder.id}/transitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (res.ok) {
            showToast('Idempotency Verified', `HTTP 200 OK: Cache returned identically without version advancement. Zero side effects.`, 'success', 5000);
            syncJsonViewer({
                idempotency_audit: 'CACHE_SERVED',
                key: lastExecutedIdempKey,
                cached_payload: data
            });
        }
    } catch (err) {
        showToast('Error', err.message, 'error');
    }
}

async function simulateIllegalJump() {
    if (!activeOrder) return;
    showToast('Testing Matrix Invariant', `Attempting illegal transition 'ship_order' from ${activeOrder.current_state}...`, 'info', 1500);

    const payload = {
        trigger: 'ship_order',
        actor: 'rogue_admin',
        expected_version: activeOrder.version,
        note: 'Chaos Test: Direct illegal state jump'
    };

    try {
        const res = await fetch(`${API_BASE}/${activeOrder.id}/transitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (res.status === 409) {
            showToast('Matrix Boundary Verified', `HTTP 409 Conflict: ${data.detail?.message || 'Illegal jump rejected by O(1) transition matrix.'}`, 'warning', 5000);
            syncJsonViewer(data);
        }
    } catch (err) {
        showToast('Error', err.message, 'error');
    }
}

async function simulateExcessiveRefund() {
    if (!activeOrder) return;
    showToast('Testing Financial Invariant', 'Attempting refund exceeding order capital balance...', 'info', 1500);

    const payload = {
        trigger: 'partial_refund',
        actor: 'ops_agent',
        refund_amount_cents: activeOrder.amount_cents * 2,
        expected_version: activeOrder.version,
        note: 'Chaos Test: Over-refund balance violation'
    };

    try {
        const res = await fetch(`${API_BASE}/${activeOrder.id}/transitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (res.status === 400) {
            showToast('ADR-004 Balance Guard Verified', `HTTP 400 Bad Request: ${data.detail?.message || 'Refund exceeds balance limit.'}`, 'warning', 5000);
            syncJsonViewer(data);
        }
    } catch (err) {
        showToast('Error', err.message, 'error');
    }
}

async function triggerAutoExpire() {
    try {
        const res = await fetch(`${API_BASE}/expire-stale?timeout_minutes=1`, { method: 'POST' });
        if (!res.ok) throw new Error('Expiration request failed');
        const data = await res.json();

        if (data.expired_count > 0) {
            showToast('Batch Expiration Complete', `Expired ${data.expired_count} stale orders: ${data.expired_order_ids.join(', ')}`, 'warning', 4500);
        } else {
            showToast('Batch Check Complete', 'No stale PAYMENT_PENDING orders found beyond timeout threshold.', 'info', 2500);
        }

        await refreshDashboardData(true);
    } catch (err) {
        showToast('Error', err.message, 'error');
    }
}

// ========================================================================== //
//  INTERACTIVE DAG SVG GRAPH                                                 //
// ========================================================================== //

function syncDagCanvasState(currentState) {
    const allNodeGroups = document.querySelectorAll('.dag-node-group');
    allNodeGroups.forEach(g => {
        const stateName = g.id.replace('node-', '');
        g.classList.remove('active', 'visited');

        if (stateName === currentState) {
            g.classList.add('active');
        } else if (visitedStateHistory.has(stateName)) {
            g.classList.add('visited');
        }
    });

    // Update connector edge highlighting
    const happyPathEdges = [
        { id: 'edge-CREATED-PAYMENT_PENDING', from: 'CREATED', to: 'PAYMENT_PENDING' },
        { id: 'edge-PAYMENT_PENDING-PAID', from: 'PAYMENT_PENDING', to: 'PAID' },
        { id: 'edge-PAID-PROCESSING', from: 'PAID', to: 'PROCESSING' },
        { id: 'edge-PROCESSING-FULFILLED', from: 'PROCESSING', to: 'FULFILLED' }
    ];

    happyPathEdges.forEach(e => {
        const edgeEl = document.getElementById(e.id);
        if (edgeEl) {
            edgeEl.classList.remove('active-edge', 'visited-edge');
            if (currentState === e.to) {
                edgeEl.classList.add('active-edge');
                edgeEl.setAttribute('marker-end', 'url(#arrow-head-active)');
            } else if (visitedStateHistory.has(e.to)) {
                edgeEl.classList.add('visited-edge');
                edgeEl.setAttribute('marker-end', 'url(#arrow-head-visited)');
            } else {
                edgeEl.setAttribute('marker-end', 'url(#arrow-head)');
            }
        }
    });

    inspectStateDetails(currentState);
}

function inspectStateDetails(stateName) {
    const titleEl = document.getElementById('insp-state-name');
    const tagEl = document.getElementById('insp-state-tag');
    const contentEl = document.getElementById('insp-state-content');

    const spec = NODE_SPECS[stateName] || {
        tag: 'Registered State',
        summary: 'StateFlow lifecycle node.',
        allowed: ['Inspect transition table for full rule registry']
    };

    if (titleEl) titleEl.textContent = stateName;
    if (tagEl) tagEl.textContent = spec.tag;
    if (contentEl) {
        contentEl.innerHTML = `
            <div>${spec.summary}</div>
            <div style="margin-top:6px; font-family:var(--font-mono); font-size:10px; color:var(--text-muted);">
                Authorized Exits: <span style="color:var(--text-secondary);">${spec.allowed.join(' • ')}</span>
            </div>
        `;
    }
}

function renderMatrixRegistryTable(transitions) {
    const tbody = document.getElementById('matrix-tbody');
    const count = document.getElementById('lbl-matrix-rules-count');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (count) count.textContent = `${transitions.length} rules`;

    transitions.forEach(rule => {
        const tr = document.createElement('tr');
        let policy = 'O(1) transition matrix';
        if (rule.trigger === 'partial_refund') policy = 'ADR-004: integer subtraction <= remaining';
        if (rule.trigger === 'expire') policy = 'ADR-005: 30m batch query';
        if (terminalStateList.includes(rule.to_state)) policy = 'Terminal: strict concurrency lock';

        tr.innerHTML = `
            <td><span class="font-mono" style="color:var(--text-primary); font-weight:600;">${rule.from_state}</span></td>
            <td><span class="font-mono" style="color:var(--accent-indigo);">${rule.trigger}</span></td>
            <td><span class="font-mono" style="color:var(--accent-cyan); font-weight:600;">${rule.to_state}</span></td>
            <td style="color:var(--text-muted); font-size:10px;">${policy}</td>
        `;
        tbody.appendChild(tr);
    });
}

function filterMatrixRegistry() {
    const q = document.getElementById('inp-search-matrix').value.toLowerCase();
    const rows = document.querySelectorAll('#matrix-tbody tr');
    rows.forEach(r => {
        r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
}

// ========================================================================== //
//  RIGHT TELEMETRY: EVENT STREAM & LEDGER                                    //
// ========================================================================== //

function switchRightPanelTab(tab) {
    const tabs = ['audit', 'ledger', 'json'];
    tabs.forEach(t => {
        const btn = document.getElementById(`tab-${t === 'audit' ? 'audit-events' : t === 'ledger' ? 'order-ledger' : 'json-payload'}`);
        const pane = document.getElementById(`pane-tab-${t}`);
        if (btn && pane) {
            btn.classList.toggle('active', t === tab);
            pane.classList.toggle('active', t === tab);
        }
    });
}

async function fetchOrderAuditHistory() {
    if (!activeOrder) return;
    const stream = document.getElementById('audit-event-stream');
    const label = document.getElementById('stream-order-label');
    if (label) label.textContent = `Events: ${activeOrder.id}`;

    try {
        const res = await fetch(`${API_BASE}/${activeOrder.id}/history`);
        if (!res.ok) throw new Error('Audit unavailable');
        const events = await res.json();

        if (events.length === 0) {
            stream.innerHTML = `<div class="empty-stream-state"><span class="empty-sub">No transitions recorded yet.</span></div>`;
            return;
        }

        stream.innerHTML = '';
        events.forEach((evt, idx) => {
            const card = document.createElement('div');
            card.className = 'audit-stream-card';
            const from = evt.from_state || 'INITIAL';
            const to = evt.to_state;
            const timeAgo = formatRelativeTime(evt.created_at);

            card.innerHTML = `
                <div class="stream-card-top">
                    <div style="display:flex; align-items:center; gap:6px;">
                        <span class="stream-seq-badge">#${idx + 1}</span>
                        <span class="stream-trigger-name">${evt.trigger}</span>
                    </div>
                    <span class="stream-time-offset">${timeAgo}</span>
                </div>
                <div class="stream-states-row">
                    <span>${from}</span>
                    <span style="color:var(--text-faint);">➔</span>
                    <span style="color:var(--text-primary); font-weight:600;">${to}</span>
                </div>
                <div class="stream-meta-row">
                    <span class="stream-actor-pill">principal: ${evt.actor}</span>
                    ${evt.note ? `<span style="font-size:10px; color:var(--text-muted); font-style:italic;">"${evt.note}"</span>` : ''}
                </div>
            `;
            stream.appendChild(card);
        });
    } catch (err) {
        console.error('Audit stream error:', err);
    }
}

function renderLedgerList() {
    const list = document.getElementById('ledger-list');
    if (!list) return;

    let dataset = cachedLedgerOrders;
    if (ledgerFilterMode === 'ACTIVE') {
        dataset = cachedLedgerOrders.filter(o => !terminalStateList.includes(o.current_state));
    } else if (ledgerFilterMode === 'FULFILLED') {
        dataset = cachedLedgerOrders.filter(o => o.current_state === 'FULFILLED');
    } else if (ledgerFilterMode === 'REFUNDED') {
        dataset = cachedLedgerOrders.filter(o => o.current_state === 'REFUNDED' || o.current_state === 'PARTIALLY_REFUNDED');
    } else if (ledgerFilterMode === 'EXPIRED') {
        dataset = cachedLedgerOrders.filter(o => o.current_state === 'EXPIRED');
    }

    if (dataset.length === 0) {
        list.innerHTML = `<div style="padding:20px; text-align:center; color:var(--text-muted); font-size:11px;">No records match filter (${ledgerFilterMode}).</div>`;
        return;
    }

    list.innerHTML = '';
    dataset.forEach(order => {
        const row = document.createElement('div');
        row.className = 'ledger-row';
        row.id = `ledger-row-${order.id}`;
        if (activeOrder && activeOrder.id === order.id) row.classList.add('selected');

        const amtStr = formatCurrency(order.amount_cents, order.currency);
        const timeAgo = formatRelativeTime(order.updated_at);
        const isTerminal = terminalStateList.includes(order.current_state);
        const tagColor = isTerminal ? 'background:rgba(244,63,94,0.12); color:#fda4af;' : 'background:rgba(16,185,129,0.12); color:#34d399;';

        row.innerHTML = `
            <div class="ledger-row-top">
                <span class="ledger-row-id">${order.id}</span>
                <span class="ledger-state-tag" style="${tagColor}">${order.current_state}</span>
            </div>
            <div class="ledger-row-sub">
                <span class="font-mono">${amtStr} • v${order.version}</span>
                <span>${timeAgo}</span>
            </div>
        `;

        row.onclick = () => selectOrderInstance(order.id);
        list.appendChild(row);
    });
}

function applyLedgerFilter(filter) {
    ledgerFilterMode = filter;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b.textContent.toUpperCase() === filter));
    renderLedgerList();
}

function highlightLedgerRow(orderId) {
    document.querySelectorAll('.ledger-row').forEach(r => {
        r.classList.toggle('selected', r.id === `ledger-row-${orderId}`);
    });
}

function syncJsonViewer(data) {
    const el = document.getElementById('raw-json-viewer');
    if (el) el.textContent = JSON.stringify(data, null, 2);
}

function copyActiveOrderId() {
    if (!activeOrder) return;
    navigator.clipboard.writeText(activeOrder.id);
    showToast('Copied', `Order ID ${activeOrder.id} in clipboard`, 'info', 1500);
}

function copyJsonPayload() {
    const el = document.getElementById('raw-json-viewer');
    if (el) {
        navigator.clipboard.writeText(el.textContent);
        showToast('Copied', 'Serialized JSON payload copied', 'info', 1500);
    }
}

// ========================================================================== //
//  SYSTEM TOAST STACK                                                        //
// ========================================================================== //

function showToast(title, message, type = 'info', duration = 3500) {
    const stack = document.getElementById('toast-stack');
    if (!stack) return;

    const toast = document.createElement('div');
    toast.className = `toast-pill ${type}`;
    toast.innerHTML = `
        <span class="toast-dot"></span>
        <div class="toast-text">
            <span class="toast-title">${title}:</span>
            <span>${message}</span>
        </div>
    `;

    stack.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(4px)';
        toast.style.transition = 'all 150ms ease';
        setTimeout(() => toast.remove(), 150);
    }, duration);
}

function handleApiErrorResponse(status, err) {
    const detail = err.detail || {};
    if (status === 409) {
        if (detail.error === 'OPTIMISTIC_LOCK_CONFLICT') {
            showToast('Optimistic Lock Conflict', `Version clash (Expected v${detail.expected_version}, actual v${detail.actual_version}). Mutation rejected.`, 'error', 5000);
        } else if (detail.error === 'INVALID_STATE_TRANSITION') {
            showToast('Invalid State Jump', detail.message || 'Illegal transition rejected by matrix', 'error', 5000);
        } else {
            showToast('Conflict (409)', JSON.stringify(detail), 'error');
        }
        syncJsonViewer(detail);
    } else if (status === 400) {
        showToast('Bad Request (400)', detail.message || JSON.stringify(detail), 'warning', 5000);
        syncJsonViewer(err);
    } else {
        showToast('Error', err.detail || 'An unexpected failure occurred', 'error');
        syncJsonViewer(err);
    }
}
