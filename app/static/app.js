// ========================================================================== //
//  StateFlow Dashboard — Ultra-Modern Reactive Client (Linear / Stripe UX)   //
// ========================================================================== //

const API_BASE = '/api/v1/orders';

// Application State
let currentOrder = null;
let transitionMatrix = [];
let terminalStates = [];
let visitedStates = new Set();
let allOrdersList = [];
let activeOrderFilter = 'ALL';
let lastIdempotencyKey = null;
let lastTrigger = null;

// Trigger Display Metadata (Icons, Labels, Descriptions)
const TRIGGER_CONFIG = {
    initiate_payment: {
        label: 'Initiate Payment',
        icon: '💳',
        desc: 'Customer reaches checkout',
        btnClass: 'btn-action-trigger'
    },
    confirm_payment: {
        label: 'Confirm Payment',
        icon: '✅',
        desc: 'Gateway webhook captures funds',
        btnClass: 'btn-action-trigger'
    },
    fail_payment: {
        label: 'Fail Payment',
        icon: '❌',
        desc: 'Card declined or gateway timeout',
        btnClass: 'btn-action-trigger'
    },
    cancel_order: {
        label: 'Cancel Order',
        icon: '🛑',
        desc: 'Order cancelled by customer/merchant',
        btnClass: 'btn-action-trigger'
    },
    expire: {
        label: 'Expire Order',
        icon: '⏱️',
        desc: 'Payment session timeout (30m)',
        btnClass: 'btn-action-trigger'
    },
    start_processing: {
        label: 'Start Processing',
        icon: '📦',
        desc: 'Warehouse picks and packs inventory',
        btnClass: 'btn-action-trigger'
    },
    ship_order: {
        label: 'Ship & Fulfill',
        icon: '🚀',
        desc: 'Courier tracking created',
        btnClass: 'btn-action-trigger'
    },
    partial_refund: {
        label: 'Partial Refund',
        icon: '⚖️',
        desc: 'Refund portion of settled balance',
        btnClass: 'btn-action-trigger'
    },
    refund_order: {
        label: 'Full Refund',
        icon: '↩️',
        desc: 'Return 100% of order funds',
        btnClass: 'btn-action-trigger'
    }
};

// State Node Descriptions for Inspector
const STATE_INFO = {
    CREATED: {
        title: 'CREATED (Initial State)',
        desc: 'Order has been created in the database. Inventory holds may be temporary. Allowed transitions: initiate_payment, cancel_order.'
    },
    PAYMENT_PENDING: {
        title: 'PAYMENT_PENDING',
        desc: 'Payment intent created. Awaiting external webhook confirmation. Transitions: confirm_payment, fail_payment, cancel_order, expire.'
    },
    PAID: {
        title: 'PAID (Funds Settled)',
        desc: 'Monetary settlement confirmed. Invariant: amount_cents captured. Transitions: start_processing, partial_refund, refund_order, cancel_order.'
    },
    PROCESSING: {
        title: 'PROCESSING (Fulfillment)',
        desc: 'Fulfillment bots pick and assemble goods. Transitions: ship_order, cancel_order.'
    },
    FULFILLED: {
        title: 'FULFILLED (Terminal Success)',
        desc: 'Package delivered to customer. Terminal state unless post-fulfillment partial or full refund is requested.'
    },
    CANCELLED: {
        title: 'CANCELLED (Terminal)',
        desc: 'Terminal state. Order cancelled before delivery. Concurrency lock prevents any subsequent mutations.'
    },
    FAILED: {
        title: 'FAILED (Terminal)',
        desc: 'Terminal state. Payment gateway rejected transaction or fatal error occurred.'
    },
    EXPIRED: {
        title: 'EXPIRED (Terminal)',
        desc: 'Terminal state (v2). Order remained in PAYMENT_PENDING past deadline and was auto-purged by batch worker.'
    },
    PARTIALLY_REFUNDED: {
        title: 'PARTIALLY_REFUNDED (v2 Multi-Tier)',
        desc: 'One or more partial refunds issued. If subsequent refunds reach 100%, order automatically transitions to terminal REFUNDED.'
    },
    REFUNDED: {
        title: 'REFUNDED (Terminal Full Refund)',
        desc: 'Terminal state. 100% of the original order balance has been refunded.'
    }
};

// ========================================================================== //
//  INITIALIZATION                                                            //
// ========================================================================== //
document.addEventListener('DOMContentLoaded', async () => {
    setupAmountInputListener();
    await fetchTransitionMatrix();
    await refreshDashboardData();

    // Auto-select most recent order if one exists
    if (allOrdersList.length > 0) {
        selectOrder(allOrdersList[0].id);
    }

    // Periodic telemetry sync every 15 seconds
    setInterval(() => {
        refreshDashboardData(true);
    }, 15000);
});

function setupAmountInputListener() {
    const inp = document.getElementById('inp-amount');
    if (inp) {
        inp.addEventListener('input', () => {
            const cents = parseInt(inp.value) || 0;
            const hint = document.getElementById('hint-formatted-amount');
            if (hint) {
                hint.textContent = `Equivalent: ${centsToUsd(cents)}`;
            }
        });
    }
}

// Format Cents to Currency ($120.00)
function centsToUsd(cents, currency = 'USD') {
    if (isNaN(cents)) return '$0.00';
    return (cents / 100).toLocaleString('en-US', {
        style: 'currency',
        currency: currency || 'USD',
        minimumFractionDigits: 2
    });
}

// Relative time formatter
function timeAgo(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const seconds = Math.floor((now - date) / 1000);
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return date.toLocaleDateString();
}

// ========================================================================== //
//  API DATA FETCHING                                                         //
// ========================================================================== //

// Fetch Transition Matrix
async function fetchTransitionMatrix() {
    try {
        const res = await fetch(`${API_BASE}/matrix`);
        if (!res.ok) throw new Error('Failed to load transition matrix');
        const data = await res.json();
        transitionMatrix = data.transitions || [];
        terminalStates = data.terminal_states || [];
        renderMatrixTable(transitionMatrix);
    } catch (err) {
        console.error('Matrix error:', err);
        showToast('Matrix Error', err.message, 'error');
    }
}

// Refresh Telemetry & Orders List
async function refreshDashboardData(silent = false) {
    try {
        const [statsRes, ordersRes] = await Promise.all([
            fetch(`${API_BASE}/stats/summary`),
            fetch(`${API_BASE}?limit=50`)
        ]);

        if (statsRes.ok) {
            const stats = await statsRes.json();
            updateMetricsRibbon(stats);
        }

        if (ordersRes.ok) {
            allOrdersList = await ordersRes.json();
            renderOrdersRegistry();
            const counter = document.getElementById('tab-order-count');
            if (counter) counter.textContent = allOrdersList.length;
        }

        // If active order exists, refresh its state
        if (currentOrder) {
            const orderRes = await fetch(`${API_BASE}/${currentOrder.id}`);
            if (orderRes.ok) {
                const refreshed = await orderRes.json();
                renderActiveOrder(refreshed);
            }
        }

        if (!silent) {
            showToast('Synchronized', 'Dashboard telemetry updated from database', 'info', 2000);
        }
    } catch (err) {
        console.error('Sync error:', err);
    }
}

// Update Metrics Ribbon
function updateMetricsRibbon(stats) {
    const gmvVal = document.getElementById('metric-val-gmv');
    const ordersVal = document.getElementById('metric-val-orders');
    const fulfilledSub = document.getElementById('metric-sub-fulfilled');
    const barFulfilled = document.getElementById('metric-bar-fulfilled');
    const settlementVal = document.getElementById('metric-val-settlement');
    const refundedVal = document.getElementById('metric-val-refunded');
    const barRefunded = document.getElementById('metric-bar-refunded');
    const staleBadge = document.getElementById('stale-badge-count');

    if (gmvVal) gmvVal.textContent = centsToUsd(stats.active_gmv_cents || 0);
    if (ordersVal) ordersVal.textContent = stats.total_orders || 0;
    if (fulfilledSub) fulfilledSub.textContent = `${stats.fulfilled_count || 0} Fulfilled`;

    if (barFulfilled) {
        const pct = stats.total_orders > 0 ? (stats.fulfilled_count / stats.total_orders) * 100 : 0;
        barFulfilled.style.width = `${pct}%`;
    }

    if (settlementVal) {
        const total = stats.total_orders || 0;
        const terminalBad = (stats.state_distribution?.CANCELLED || 0) + (stats.state_distribution?.FAILED || 0) + (stats.state_distribution?.EXPIRED || 0);
        const rate = total > 0 ? (((total - terminalBad) / total) * 100).toFixed(1) : 100;
        settlementVal.textContent = `${rate}%`;
    }

    if (refundedVal) refundedVal.textContent = centsToUsd(stats.refunded_cents || 0);
    if (barRefunded) {
        const totalAmount = (stats.active_gmv_cents || 0) + (stats.refunded_cents || 0);
        const refPct = totalAmount > 0 ? Math.min(100, ((stats.refunded_cents || 0) / totalAmount) * 100) : 0;
        barRefunded.style.width = `${refPct}%`;
    }

    // Stale orders counter
    const staleCount = stats.stale_pending_count || 0;
    if (staleBadge) {
        if (staleCount > 0) {
            staleBadge.textContent = staleCount;
            staleBadge.classList.remove('hidden');
        } else {
            staleBadge.classList.add('hidden');
        }
    }
}

// ========================================================================== //
//  ORDER CREATION & SELECTION                                                //
// ========================================================================== //

// Preset Templates
function applyPreset(type) {
    const custInp = document.getElementById('inp-customer');
    const amtInp = document.getElementById('inp-amount');
    const currInp = document.getElementById('inp-currency');
    const hint = document.getElementById('hint-formatted-amount');

    const presets = {
        sneakers: { cust: 'cust_sneakerhead', amt: 12000, curr: 'USD' },
        saas: { cust: 'cust_acme_corp', amt: 4900, curr: 'USD' },
        coffee: { cust: 'cust_morning_joe', amt: 850, curr: 'USD' },
        enterprise: { cust: 'cust_global_logistics', amt: 250000, curr: 'USD' }
    };

    const p = presets[type];
    if (p) {
        if (custInp) custInp.value = p.cust;
        if (amtInp) amtInp.value = p.amt;
        if (currInp) currInp.value = p.curr;
        if (hint) hint.textContent = `Equivalent: ${centsToUsd(p.amt, p.curr)}`;
        showToast('Preset Applied', `Loaded preset for ${type.toUpperCase()}`, 'info', 2000);
    }
}

// Create Order
async function createOrder() {
    const custId = document.getElementById('inp-customer').value.trim();
    const amount = parseInt(document.getElementById('inp-amount').value, 10);
    const currency = document.getElementById('inp-currency').value.trim().toUpperCase();

    if (!custId || isNaN(amount) || amount <= 0) {
        showToast('Validation Error', 'Customer ID and a positive amount in cents are required.', 'error');
        return;
    }

    try {
        const res = await fetch(API_BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ customer_id: custId, amount_cents: amount, currency: currency })
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || 'Failed to create order');
        }

        const order = await res.json();
        visitedStates = new Set();
        showToast('Order Created', `Order ${order.id} spawned in CREATED state.`, 'success');
        
        // Refresh orders and select newly created order
        await refreshDashboardData(true);
        renderActiveOrder(order);
    } catch (err) {
        showToast('Order Creation Failed', err.message, 'error');
    }
}

// Select Order from Registry
async function selectOrder(orderId) {
    try {
        const res = await fetch(`${API_BASE}/${orderId}`);
        if (!res.ok) throw new Error('Order not found');
        const order = await res.json();
        visitedStates = new Set();
        renderActiveOrder(order);
    } catch (err) {
        showToast('Error', err.message, 'error');
    }
}

// Render Active Order Console
function renderActiveOrder(order) {
    currentOrder = order;
    visitedStates.add(order.current_state);

    const activeCard = document.getElementById('card-active-order');
    if (activeCard) activeCard.classList.remove('hidden');

    // Identity Bar
    document.getElementById('lbl-order-id').textContent = order.id;
    document.getElementById('lbl-order-version').textContent = `v${order.version}`;
    
    // State pill with dynamic colors
    const statePill = document.getElementById('lbl-active-state');
    statePill.textContent = order.current_state;
    updateStatePillStyle(statePill, order.current_state);

    // Financial balance
    const totalFormatted = centsToUsd(order.amount_cents, order.currency);
    const refundedFormatted = centsToUsd(order.refunded_cents || 0, order.currency);
    const remainingCents = Math.max(0, order.amount_cents - (order.refunded_cents || 0));
    const remainingFormatted = centsToUsd(remainingCents, order.currency);

    document.getElementById('lbl-total-amount').textContent = totalFormatted;
    document.getElementById('lbl-refunded-amount').textContent = refundedFormatted;
    document.getElementById('lbl-remaining-hint').textContent = `Remaining Balance: ${remainingFormatted}`;

    const fillPct = Math.min(100, ((order.refunded_cents || 0) / order.amount_cents) * 100);
    const barFill = document.getElementById('bar-refund-fill');
    if (barFill) barFill.style.width = `${fillPct}%`;

    // Render Action Buttons
    renderActionDeck(order);

    // Update Visual Graph
    updateVisualGraph(order.current_state);

    // Update Raw JSON Inspector
    updateJsonViewer(order);

    // Fetch and render audit trail
    fetchAuditHistory();

    // Highlight selected item in orders registry
    highlightSelectedOrderInList(order.id);
}

// ========================================================================== //
//  TRANSITIONS & ACTIONS DECK                                                //
// ========================================================================== //

function renderActionDeck(order) {
    const grid = document.getElementById('action-buttons-grid');
    grid.innerHTML = '';
    closeRefundBox();

    // Find allowed transitions from current state
    const allowed = transitionMatrix.filter(r => r.from_state === order.current_state);

    if (allowed.length === 0) {
        grid.innerHTML = `
            <div style="padding:10px; text-align:center; color:var(--text-muted); font-size:11px; background:var(--bg-surface-1); border-radius:8px;">
                🛑 Terminal State Reached (${order.current_state}). No further mutations permitted.
            </div>
        `;
        return;
    }

    allowed.forEach(rule => {
        const config = TRIGGER_CONFIG[rule.trigger] || {
            label: rule.trigger,
            icon: '⚡',
            desc: `Advance to ${rule.to_state}`
        };

        const btn = document.createElement('button');
        btn.className = 'btn-action-trigger';
        btn.innerHTML = `
            <div class="action-trigger-info">
                <span>${config.icon}</span>
                <span>${config.label}</span>
            </div>
            <span class="action-target-badge">➔ ${rule.to_state}</span>
        `;

        btn.onclick = () => {
            if (rule.trigger === 'partial_refund') {
                openRefundBox();
            } else {
                executeTransition(rule.trigger);
            }
        };

        grid.appendChild(btn);
    });
}

// Execute State Transition
async function executeTransition(trigger, refundAmountCents = null, note = null) {
    if (!currentOrder) return;

    const actor = document.getElementById('sel-actor').value || 'customer';
    const idempKey = `idemp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    lastIdempotencyKey = idempKey;
    lastTrigger = trigger;

    const payload = {
        trigger: trigger,
        actor: actor,
        idempotency_key: idempKey,
        expected_version: currentOrder.version,
        note: note || `Executed ${trigger} via Dashboard Console`
    };

    if (refundAmountCents !== null) {
        payload.refund_amount_cents = refundAmountCents;
    }

    try {
        const res = await fetch(`${API_BASE}/${currentOrder.id}/transitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const err = await res.json();
            handleApiError(res.status, err);
            return;
        }

        const updated = await res.json();
        showToast('Transition Succeeded', `${currentOrder.current_state} ➔ ${updated.current_state}`, 'success');
        
        renderActiveOrder(updated);
        await refreshDashboardData(true);
    } catch (err) {
        showToast('Network Error', err.message, 'error');
    }
}

// Partial Refund Helper
function openRefundBox() {
    const box = document.getElementById('box-partial-refund');
    if (box) box.classList.remove('hidden');
    const remaining = currentOrder ? Math.max(0, currentOrder.amount_cents - (currentOrder.refunded_cents || 0)) : 0;
    const inp = document.getElementById('inp-refund-cents');
    if (inp) {
        inp.value = Math.floor(remaining / 2);
        inp.max = remaining;
    }
}

function closeRefundBox() {
    const box = document.getElementById('box-partial-refund');
    if (box) box.classList.add('hidden');
}

function setRefundPct(pct) {
    if (!currentOrder) return;
    const remaining = Math.max(0, currentOrder.amount_cents - (currentOrder.refunded_cents || 0));
    const amount = Math.floor(remaining * pct);
    const inp = document.getElementById('inp-refund-cents');
    if (inp) inp.value = amount;
}

function executePartialRefundAction() {
    const inp = document.getElementById('inp-refund-cents');
    const noteInp = document.getElementById('inp-refund-note');
    const amount = parseInt(inp.value, 10);
    const note = noteInp ? noteInp.value.trim() : null;

    if (isNaN(amount) || amount <= 0) {
        showToast('Invalid Refund', 'Refund amount must be greater than 0 cents.', 'warning');
        return;
    }

    executeTransition('partial_refund', amount, note);
}

// ========================================================================== //
//  CHAOS TESTING & ADR INVARIANT VERIFICATION SANDBOX                       //
// ========================================================================== //

function toggleSandbox() {
    const body = document.getElementById('sandbox-body');
    const arrow = document.getElementById('sandbox-arrow');
    if (body.classList.contains('hidden')) {
        body.classList.remove('hidden');
        arrow.textContent = '▲';
    } else {
        body.classList.add('hidden');
        arrow.textContent = '▼';
    }
}

// 1. Simulate Optimistic Concurrency Clash (HTTP 409)
async function simulateRaceCondition() {
    if (!currentOrder) return;
    showToast('Simulating Clash', 'Sending transition with stale expected_version = 0...', 'info', 2000);

    const payload = {
        trigger: 'initiate_payment',
        actor: 'concurrent_worker_b',
        expected_version: 0, // Deliberately stale
        note: 'Chaos test: Stale version race condition'
    };

    try {
        const res = await fetch(`${API_BASE}/${currentOrder.id}/transitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (res.status === 409) {
            showToast('Optimistic Lock Guardrail Verified', `HTTP 409 Conflict: Expected v0 but actual version is v${currentOrder.version}. Data corruption prevented!`, 'warning', 6000);
            updateJsonViewer(data);
        } else {
            showToast('Response', JSON.stringify(data), 'info');
        }
    } catch (err) {
        showToast('Error', err.message, 'error');
    }
}

// 2. Simulate Idempotent Replay (Zero Double-Charge Guarantee)
async function simulateIdempotentReplay() {
    if (!currentOrder) return;
    if (!lastIdempotencyKey) {
        showToast('No Prior Transition', 'Perform a transition first so an idempotency key exists to replay.', 'warning');
        return;
    }

    showToast('Replaying Webhook', `Sending duplicate event with key: ${lastIdempotencyKey}...`, 'info', 2000);

    const payload = {
        trigger: lastTrigger || 'confirm_payment',
        actor: 'stripe_webhook_retry',
        idempotency_key: lastIdempotencyKey,
        expected_version: currentOrder.version,
        note: 'Duplicate webhook replay test'
    };

    try {
        const res = await fetch(`${API_BASE}/${currentOrder.id}/transitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (res.ok) {
            showToast('Idempotency Verified', `HTTP 200 OK: Cached response served! Order version remained v${data.version}. No double-advancement occurred.`, 'success', 6000);
            updateJsonViewer({
                idempotency_status: 'CACHE_HIT',
                key: lastIdempotencyKey,
                cached_order_payload: data
            });
        }
    } catch (err) {
        showToast('Error', err.message, 'error');
    }
}

// 3. Simulate Illegal State Jump (CREATED -> FULFILLED)
async function simulateIllegalJump() {
    if (!currentOrder) return;
    showToast('Testing Matrix Invariant', `Attempting illegal jump to FULFILLED from ${currentOrder.current_state}...`, 'info', 2000);

    const payload = {
        trigger: 'ship_order', // ship_order is only allowed from PROCESSING
        actor: 'rogue_admin',
        expected_version: currentOrder.version,
        note: 'Chaos test: Illegal state jump'
    };

    try {
        const res = await fetch(`${API_BASE}/${currentOrder.id}/transitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (res.status === 409) {
            showToast('State Matrix Guardrail Verified', `HTTP 409 Conflict: ${data.detail?.message || 'Illegal transition rejected by state machine matrix!'}`, 'warning', 6000);
            updateJsonViewer(data);
        } else {
            showToast('Response', JSON.stringify(data), 'info');
        }
    } catch (err) {
        showToast('Error', err.message, 'error');
    }
}

// 4. Simulate Over-Refund (Amount exceeds remaining)
async function simulateExcessiveRefund() {
    if (!currentOrder) return;
    showToast('Testing Financial Invariant', 'Attempting refund of $999,999.00...', 'info', 2000);

    const payload = {
        trigger: 'partial_refund',
        actor: 'support_agent',
        refund_amount_cents: 99999900,
        expected_version: currentOrder.version,
        note: 'Chaos test: Excessive refund amount'
    };

    try {
        const res = await fetch(`${API_BASE}/${currentOrder.id}/transitions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (res.status === 400) {
            showToast('ADR-004 Guardrail Verified', `HTTP 400 Bad Request: ${data.detail?.message || 'Refund exceeds remaining balance!'}`, 'warning', 6000);
            updateJsonViewer(data);
        } else {
            showToast('Response', JSON.stringify(data), 'info');
        }
    } catch (err) {
        showToast('Error', err.message, 'error');
    }
}

// Trigger Auto-Expire Stale Orders
async function triggerAutoExpire() {
    try {
        const res = await fetch(`${API_BASE}/expire-stale?timeout_minutes=1`, { method: 'POST' });
        if (!res.ok) throw new Error('Expire stale request failed');
        const data = await res.json();

        if (data.expired_count > 0) {
            showToast('Auto-Expiration Complete', `Expired ${data.expired_count} stale orders: ${data.expired_order_ids.join(', ')}`, 'warning', 5000);
        } else {
            showToast('Auto-Expiration Check', 'No stale PAYMENT_PENDING orders found beyond timeout.', 'info', 3000);
        }

        await refreshDashboardData(true);
    } catch (err) {
        showToast('Error', err.message, 'error');
    }
}

// ========================================================================== //
//  VISUAL STATE MACHINE GRAPH                                                //
// ========================================================================== //

function updateVisualGraph(activeState) {
    const allNodes = document.querySelectorAll('.flow-node');
    allNodes.forEach(node => {
        const stateName = node.getAttribute('data-state');
        node.classList.remove('active-state', 'visited-state');

        if (stateName === activeState) {
            node.classList.add('active-state');
        } else if (visitedStates.has(stateName)) {
            node.classList.add('visited-state');
        }
    });

    // Update path connector glows on happy path
    const happyPath = ['CREATED', 'PAYMENT_PENDING', 'PAID', 'PROCESSING', 'FULFILLED'];
    const activeIdx = happyPath.indexOf(activeState);

    for (let i = 1; i <= 4; i++) {
        const conn = document.getElementById(`conn-${i}`);
        if (conn) {
            if (activeIdx >= i) {
                conn.classList.add('active-path');
            } else {
                conn.classList.remove('active-path');
            }
        }
    }
}

// Node Inspector
function inspectStateNode(stateName) {
    const drawer = document.getElementById('node-inspector-drawer');
    const title = document.getElementById('inspector-title');
    const body = document.getElementById('inspector-body');

    if (!drawer) return;
    drawer.style.display = 'block';

    const info = STATE_INFO[stateName] || {
        title: stateName,
        desc: 'StateFlow registered lifecycle node.'
    };

    const outgoing = transitionMatrix.filter(r => r.from_state === stateName);
    const incoming = transitionMatrix.filter(r => r.to_state === stateName);

    title.textContent = info.title;

    body.innerHTML = `
        <p style="margin-bottom:8px;">${info.desc}</p>
        <div style="margin-top:6px; font-size:11px;">
            <strong style="color:var(--text-primary);">Incoming Triggers:</strong> 
            ${incoming.map(r => `<code style="color:var(--accent-cyan); background:rgba(255,255,255,0.05); padding:1px 4px; border-radius:3px;">${r.trigger} (from ${r.from_state})</code>`).join(' ') || 'None (Initial state)'}
        </div>
        <div style="margin-top:6px; font-size:11px;">
            <strong style="color:var(--text-primary);">Allowed Outgoing:</strong> 
            ${outgoing.map(r => `<code style="color:var(--accent-indigo); background:rgba(255,255,255,0.05); padding:1px 4px; border-radius:3px;">${r.trigger} ➔ ${r.to_state}</code>`).join(' ') || 'None (Terminal state)'}
        </div>
    `;
}

function closeInspector() {
    const drawer = document.getElementById('node-inspector-drawer');
    if (drawer) drawer.style.display = 'none';
}

// Render Transition Matrix Table
function renderMatrixTable(transitions) {
    const tbody = document.getElementById('table-matrix-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    transitions.forEach(rule => {
        const tr = document.createElement('tr');
        
        let invariant = 'State matrix check';
        if (rule.trigger === 'partial_refund') invariant = 'ADR-004: refund <= remaining';
        if (rule.trigger === 'expire') invariant = 'ADR-005: 30m timeout batch';
        if (terminalStates.includes(rule.to_state)) invariant = 'Terminal: immutable lock';

        tr.innerHTML = `
            <td><span class="badge-rule-state">${rule.from_state}</span></td>
            <td><span class="badge-rule-trigger">${rule.trigger}</span></td>
            <td><span class="badge-rule-state">${rule.to_state}</span></td>
            <td style="font-size:11px; color:var(--text-muted);">${invariant}</td>
        `;
        tbody.appendChild(tr);
    });
}

function filterMatrixTable() {
    const q = document.getElementById('inp-matrix-filter').value.toLowerCase();
    const rows = document.querySelectorAll('#table-matrix-body tr');
    rows.forEach(r => {
        const text = r.textContent.toLowerCase();
        r.style.display = text.includes(q) ? '' : 'none';
    });
}

// ========================================================================== //
//  AUDIT TRAIL & ORDERS REGISTRY                                             //
// ========================================================================== //

// Tab Switcher
function switchRightTab(tab) {
    const btnAudit = document.getElementById('tab-btn-audit');
    const btnOrders = document.getElementById('tab-btn-orders');
    const paneAudit = document.getElementById('pane-audit');
    const paneOrders = document.getElementById('pane-orders');

    if (tab === 'audit') {
        btnAudit.classList.add('active');
        btnOrders.classList.remove('active');
        paneAudit.classList.add('active');
        paneOrders.classList.remove('active');
    } else {
        btnOrders.classList.add('active');
        btnAudit.classList.remove('active');
        paneOrders.classList.add('active');
        paneAudit.classList.remove('active');
    }
}

// Fetch Audit History
async function fetchAuditHistory() {
    if (!currentOrder) return;

    const container = document.getElementById('timeline-container');
    const orderLabel = document.getElementById('audit-order-label');
    if (orderLabel) orderLabel.textContent = `Events for: ${currentOrder.id}`;

    try {
        const res = await fetch(`${API_BASE}/${currentOrder.id}/history`);
        if (!res.ok) throw new Error('Failed to load audit history');
        const logs = await res.json();

        if (logs.length === 0) {
            container.innerHTML = `
                <div class="timeline-empty-state">
                    <p>No audit events recorded yet.</p>
                </div>
            `;
            return;
        }

        container.innerHTML = '';
        logs.forEach(log => {
            const item = document.createElement('div');
            item.className = 'timeline-item';
            
            const from = log.from_state || 'INITIAL';
            const to = log.to_state;
            const timeStr = timeAgo(log.created_at);

            item.innerHTML = `
                <div class="timeline-dot"></div>
                <div class="timeline-card">
                    <div class="timeline-top">
                        <span class="timeline-trigger">${log.trigger}</span>
                        <span class="timeline-time">${timeStr}</span>
                    </div>
                    <div class="timeline-states">
                        <span>${from}</span>
                        <span>➔</span>
                        <span style="color:#fff; font-weight:600;">${to}</span>
                    </div>
                    <div class="timeline-actor-row">
                        <span class="actor-pill">👤 ${log.actor}</span>
                        ${log.note ? `<span style="color:var(--text-muted); font-size:10px;">"${log.note}"</span>` : ''}
                    </div>
                </div>
            `;
            container.appendChild(item);
        });
    } catch (err) {
        console.error('Audit trail error:', err);
    }
}

// Render Orders Registry
function renderOrdersRegistry() {
    const container = document.getElementById('order-list-container');
    if (!container) return;

    let filtered = allOrdersList;
    if (activeOrderFilter === 'ACTIVE') {
        filtered = allOrdersList.filter(o => !terminalStates.includes(o.current_state));
    } else if (activeOrderFilter === 'FULFILLED') {
        filtered = allOrdersList.filter(o => o.current_state === 'FULFILLED');
    } else if (activeOrderFilter === 'REFUNDED') {
        filtered = allOrdersList.filter(o => o.current_state === 'REFUNDED' || o.current_state === 'PARTIALLY_REFUNDED');
    } else if (activeOrderFilter === 'EXPIRED') {
        filtered = allOrdersList.filter(o => o.current_state === 'EXPIRED');
    }

    if (filtered.length === 0) {
        container.innerHTML = `
            <div style="padding:20px; text-align:center; color:var(--text-muted); font-size:11px;">
                No orders match current filter (${activeOrderFilter}).
            </div>
        `;
        return;
    }

    container.innerHTML = '';
    filtered.forEach(order => {
        const item = document.createElement('div');
        item.className = 'order-list-item';
        item.id = `order-item-${order.id}`;
        if (currentOrder && currentOrder.id === order.id) {
            item.classList.add('selected');
        }

        const amtStr = centsToUsd(order.amount_cents, order.currency);
        const timeStr = timeAgo(order.updated_at);

        item.innerHTML = `
            <div class="order-item-top">
                <span class="order-item-id">${order.id}</span>
                <span class="order-item-state" style="${getStateBadgeStyle(order.current_state)}">${order.current_state}</span>
            </div>
            <div class="order-item-bottom">
                <span class="order-item-amt">${amtStr} • v${order.version}</span>
                <span>${timeStr}</span>
            </div>
        `;

        item.onclick = () => selectOrder(order.id);
        container.appendChild(item);
    });
}

function filterOrderRegistry(filter) {
    activeOrderFilter = filter;
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    event.target.classList.add('active');
    renderOrdersRegistry();
}

function highlightSelectedOrderInList(orderId) {
    document.querySelectorAll('.order-list-item').forEach(el => {
        el.classList.toggle('selected', el.id === `order-item-${orderId}`);
    });
}

// ========================================================================== //
//  HELPERS, TOASTS & CLIPBOARD                                               //
// ========================================================================== //

function updateStatePillStyle(el, state) {
    const styles = {
        CREATED: { bg: 'rgba(56, 189, 248, 0.15)', border: 'rgba(56, 189, 248, 0.4)', text: '#38bdf8' },
        PAYMENT_PENDING: { bg: 'rgba(129, 140, 248, 0.15)', border: 'rgba(129, 140, 248, 0.4)', text: '#818cf8' },
        PAID: { bg: 'rgba(45, 212, 191, 0.15)', border: 'rgba(45, 212, 191, 0.4)', text: '#2dd4bf' },
        PROCESSING: { bg: 'rgba(251, 191, 36, 0.15)', border: 'rgba(251, 191, 36, 0.4)', text: '#fbbf24' },
        FULFILLED: { bg: 'rgba(52, 211, 153, 0.15)', border: 'rgba(52, 211, 153, 0.4)', text: '#34d399' },
        CANCELLED: { bg: 'rgba(148, 163, 184, 0.15)', border: 'rgba(148, 163, 184, 0.4)', text: '#94a3b8' },
        FAILED: { bg: 'rgba(248, 113, 113, 0.15)', border: 'rgba(248, 113, 113, 0.4)', text: '#f87171' },
        EXPIRED: { bg: 'rgba(100, 116, 139, 0.15)', border: 'rgba(100, 116, 139, 0.4)', text: '#94a3b8' },
        PARTIALLY_REFUNDED: { bg: 'rgba(251, 146, 60, 0.15)', border: 'rgba(251, 146, 60, 0.4)', text: '#fb923c' },
        REFUNDED: { bg: 'rgba(192, 132, 252, 0.15)', border: 'rgba(192, 132, 252, 0.4)', text: '#c084fc' }
    };
    const s = styles[state] || styles.CREATED;
    el.style.background = s.bg;
    el.style.borderColor = s.border;
    el.style.color = s.text;
}

function getStateBadgeStyle(state) {
    const colors = {
        CREATED: 'background:rgba(56,189,248,0.15); color:#38bdf8;',
        PAYMENT_PENDING: 'background:rgba(129,140,248,0.15); color:#818cf8;',
        PAID: 'background:rgba(45,212,191,0.15); color:#2dd4bf;',
        PROCESSING: 'background:rgba(251,191,36,0.15); color:#fbbf24;',
        FULFILLED: 'background:rgba(52,211,153,0.15); color:#34d399;',
        CANCELLED: 'background:rgba(148,163,184,0.15); color:#94a3b8;',
        FAILED: 'background:rgba(248,113,113,0.15); color:#f87171;',
        EXPIRED: 'background:rgba(100,116,139,0.15); color:#94a3b8;',
        PARTIALLY_REFUNDED: 'background:rgba(251,146,60,0.15); color:#fb923c;',
        REFUNDED: 'background:rgba(192,132,252,0.15); color:#c084fc;'
    };
    return colors[state] || 'background:rgba(255,255,255,0.1); color:#fff;';
}

function updateJsonViewer(data) {
    const el = document.getElementById('json-viewer');
    if (el) {
        el.textContent = JSON.stringify(data, null, 2);
    }
}

function copyOrderId() {
    if (!currentOrder) return;
    navigator.clipboard.writeText(currentOrder.id);
    showToast('Copied', `Order ID ${currentOrder.id} copied to clipboard!`, 'info', 2000);
}

function copyRawJson() {
    const el = document.getElementById('json-viewer');
    if (el) {
        navigator.clipboard.writeText(el.textContent);
        showToast('Copied', 'Raw JSON copied to clipboard!', 'info', 2000);
    }
}

// Toast Notifications System
function showToast(title, message, type = 'info', duration = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const icons = {
        success: '✅',
        error: '❌',
        warning: '⚠️',
        info: 'ℹ️'
    };

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            <div class="toast-msg">${message}</div>
        </div>
    `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'toastSlideIn 0.3s ease reverse forwards';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// Global API Error Handler
function handleApiError(status, err) {
    if (status === 409) {
        const detail = err.detail || {};
        if (detail.error === 'OPTIMISTIC_LOCK_CONFLICT') {
            showToast('Optimistic Lock Conflict (409)', `Expected v${detail.expected_version}, but actual version is v${detail.actual_version}. Request aborted to prevent overwriting concurrent state.`, 'error', 6000);
        } else if (detail.error === 'INVALID_STATE_TRANSITION') {
            showToast('Invalid State Jump (409)', `${detail.message}`, 'error', 6000);
        } else {
            showToast('Conflict (409)', JSON.stringify(detail), 'error');
        }
        updateJsonViewer(detail);
    } else if (status === 400) {
        showToast('Bad Request (400)', err.detail?.message || JSON.stringify(err.detail), 'error');
        updateJsonViewer(err);
    } else {
        showToast('Error', err.detail || 'An unexpected error occurred', 'error');
        updateJsonViewer(err);
    }
}
