// =========================================================================
//  AI Coach — نفس
//  Cloudflare Worker: flat-base-2b1b.mahmoud-1923030.workers.dev
//  Model: llama-3.3-70b-instruct-fp8-fast
// =========================================================================

const AI_WORKER_URL = 'https://flat-base-2b1b.mahmoud-1923030.workers.dev';
const AI_USAGE_KEY = 'nafs_ai_usage';
const AI_MAX_MESSAGES = 50; // الحد الأقصى للرسائل قبل حذف القديمة

// ── Shared message history ──
const _aiChatHistory = [];
let _aiPopupOpen = false;

// ── تتبع الاستخدام — بيشتغل تلقائياً ──
window.trackAppOpen = function () {
    try {
        const stats = JSON.parse(localStorage.getItem(AI_USAGE_KEY) || '{}');
        stats.openCount = (stats.openCount || 0) + 1;
        stats.lastOpenTime = new Date().toISOString();
        localStorage.setItem(AI_USAGE_KEY, JSON.stringify(stats));
    } catch (e) { }
};

// استدعاء تلقائي عند التحميل
document.addEventListener('DOMContentLoaded', () => {
    if (typeof window.trackAppOpen === 'function') {
        window.trackAppOpen();
    }
});

window.trackScreenVisit = function (screenId) {
    try {
        const stats = JSON.parse(localStorage.getItem(AI_USAGE_KEY) || '{}');
        stats.screenVisits = stats.screenVisits || {};
        stats.screenVisits[screenId] = (stats.screenVisits[screenId] || 0) + 1;
        stats.mostVisitedScreen = Object.entries(stats.screenVisits)
            .sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        localStorage.setItem(AI_USAGE_KEY, JSON.stringify(stats));
    } catch (e) { }
};

window.trackEmergencyUse = function () {
    try {
        const stats = JSON.parse(localStorage.getItem(AI_USAGE_KEY) || '{}');
        stats.emergencyCount = (stats.emergencyCount || 0) + 1;
        localStorage.setItem(AI_USAGE_KEY, JSON.stringify(stats));
    } catch (e) { }
};

// ── انتظار تحميل بيانات المستخدم ──
function waitForAppState(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        if (window.appState?.uid) return resolve(window.appState);

        const interval = setInterval(() => {
            if (window.appState?.uid) {
                clearInterval(interval);
                clearTimeout(timeout);
                resolve(window.appState);
            }
        }, 200);

        const timeout = setTimeout(() => {
            clearInterval(interval);
            reject(new Error('انتهت مهلة تحميل البيانات — حاول تسجيل الدخول مجدداً'));
        }, timeoutMs);
    });
}

// ── كلام الـ Worker ──
async function askAICoach(userMessage) {
    const usageStats = JSON.parse(localStorage.getItem(AI_USAGE_KEY) || '{}');
    const state = await waitForAppState();

    const response = await fetch(AI_WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            userMessage,
            userData: {
                preferredName: state.preferredName || 'مستخدم',
                streak: state.streak || 0,
                longestStreak: state.longestStreak || 0,
                level: state.level || 1,
                totalPoints: state.totalPoints || 0,
                adhkarProgress: state.adhkarProgress || {},
                prayerLogs: state.prayerLogs || {},
            },
            usageStats,
        })
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data.reply || null;
}

// ── Detect active context (popup vs screen) ──
function _aiGetContext() {
    if (_aiPopupOpen) {
        return {
            messages: document.getElementById('ai-popup-messages'),
            input: document.getElementById('ai-popup-input'),
            typing: document.getElementById('ai-popup-typing'),
        };
    }
    return {
        messages: document.getElementById('ai-messages'),
        input: document.getElementById('ai-input'),
        typing: document.getElementById('ai-typing'),
    };
}

// ── Render a single message to a container ──
function _aiRenderBubble(container, role, content) {
    const div = document.createElement('div');
    div.style.cssText = `
        max-width: 85%;
        padding: 0.65rem 0.9rem;
        border-radius: ${role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px'};
        background: ${role === 'user' ? 'rgba(201,168,76,0.12)' : 'rgba(255,255,255,0.04)'};
        border: 1px solid ${role === 'user' ? 'rgba(201,168,76,0.2)' : 'rgba(255,255,255,0.06)'};
        align-self: ${role === 'user' ? 'flex-end' : 'flex-start'};
        color: rgba(242,234,216,0.9);
        font-size: 0.9rem;
        line-height: 1.7;
        animation: fadeIn 0.3s ease;
        word-break: break-word;
    `;
    div.innerText = content;
    container.appendChild(div);
}

// ── Sync full history to a container ──
function _aiSyncHistory(container) {
    if (!container) return;
    // Clear existing messages except typing indicator
    const typingEl = container.querySelector('[id$="-typing"]') || container.querySelector('#ai-typing') || container.querySelector('#ai-popup-typing');
    container.innerHTML = '';
    if (_aiChatHistory.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.setAttribute('data-empty', '');
        emptyDiv.style.cssText = 'text-align:center;padding:2rem 0.8rem;color:rgba(242,234,216,0.25)';
        emptyDiv.innerHTML = '<div style="font-size:1.8rem;margin-bottom:0.4rem">🌙</div><p style="margin:0;font-size:0.82rem">اسألني أي حاجة عن عباداتك</p>';
        container.appendChild(emptyDiv);
    } else {
        _aiChatHistory.forEach(m => _aiRenderBubble(container, m.role, m.content));
    }
    // Re-add typing indicator
    if (typingEl) container.appendChild(typingEl);
    else {
        const isPopup = container.id === 'ai-popup-messages';
        const tDiv = document.createElement('div');
        tDiv.id = isPopup ? 'ai-popup-typing' : 'ai-typing';
        tDiv.className = 'hidden';
        tDiv.style.cssText = 'align-self:flex-start;padding:0.55rem 0.85rem;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);border-radius:16px 16px 16px 4px;color:rgba(242,234,216,0.4);font-size:0.82rem';
        tDiv.innerText = 'نفس بيفكر...';
        container.appendChild(tDiv);
    }
    container.scrollTop = container.scrollHeight;
}

// ── إضافة رسالة ──
function _aiAddMessage(role, content) {
    // Store in shared history
    _aiChatHistory.push({ role, content });

    // Trim old messages
    while (_aiChatHistory.length > AI_MAX_MESSAGES) _aiChatHistory.shift();

    // Render to active context
    const ctx = _aiGetContext();
    if (!ctx.messages) return;

    // Remove empty placeholder
    const empty = ctx.messages.querySelector('[data-empty]');
    if (empty) empty.remove();

    _aiRenderBubble(ctx.messages, role, content);

    // Also sync to the other container if it exists (so both stay in sync)
    const otherId = ctx.messages.id === 'ai-popup-messages' ? 'ai-messages' : 'ai-popup-messages';
    const otherContainer = document.getElementById(otherId);
    if (otherContainer) _aiSyncHistory(otherContainer);

    ctx.messages.scrollTop = ctx.messages.scrollHeight;
}

// ── Toggle popup ──
window._aiTogglePopup = function () {
    const popup = document.getElementById('ai-popup');
    if (!popup) return;

    _aiPopupOpen = !_aiPopupOpen;

    if (_aiPopupOpen) {
        popup.style.display = 'flex';
        // Sync history to popup
        const msgs = document.getElementById('ai-popup-messages');
        if (msgs) _aiSyncHistory(msgs);
        // Focus input
        setTimeout(() => {
            const inp = document.getElementById('ai-popup-input');
            if (inp) inp.focus();
        }, 100);
        // Update FAB icon
        const fab = document.getElementById('ai-fab');
        if (fab) {
            fab.innerHTML = '<i class="fas fa-times"></i>';
            fab.style.animation = 'none';
        }
    } else {
        popup.style.display = 'none';
        const fab = document.getElementById('ai-fab');
        if (fab) {
            fab.innerHTML = '<i class="fas fa-robot"></i>';
            fab.style.animation = 'aiFabPulse 3s infinite';
        }
    }
};

// Close popup on Escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _aiPopupOpen) window._aiTogglePopup();
});

// ── إرسال رسالة ──
window._aiSend = async function () {
    const ctx = _aiGetContext();
    const input = ctx.input;
    const msg = input?.value?.trim();
    if (!msg) return;

    // Disable inputs
    if (input) input.disabled = true;

    input.value = '';
    _aiAddMessage('user', msg);

    if (ctx.typing) ctx.typing.classList.remove('hidden');

    try {
        const reply = await askAICoach(msg);
        if (ctx.typing) ctx.typing.classList.add('hidden');
        _aiAddMessage('assistant', reply || 'معلش، في مشكلة. جرب تاني.');
    } catch (err) {
        console.error('[AI Coach]', err);
        if (ctx.typing) ctx.typing.classList.add('hidden');

        let errorMsg = 'حدث خطأ غير متوقع، حاول مرة أخرى';
        const errText = err?.message || '';
        if (errText.includes('انتهت مهلة')) {
            errorMsg = errText;
        } else if (errText.includes('403') || errText.includes('Forbidden')) {
            errorMsg = 'خطأ في الصلاحيات — تحقق من إعدادات الـ Worker';
        } else if (errText.includes('fetch') || err.name === 'TypeError') {
            errorMsg = 'تعذّر الاتصال بالخادم — تحقق من اتصالك بالإنترنت';
        } else if (errText.startsWith('HTTP')) {
            errorMsg = `خطأ من الخادم: ${errText}`;
        }
        _aiAddMessage('assistant', errorMsg);
    } finally {
        if (input) input.disabled = false;
        if (input) input.focus();
    }
};

// ── أسئلة سريعة ──
window._aiQuickAsk = function (q) {
    const ctx = _aiGetContext();
    if (ctx.input) { ctx.input.value = q; ctx.input.focus(); }
    window._aiSend();
};

// ── Hide/Show FAB based on current screen ──
window._aiUpdateFab = function (screenId) {
    const fab = document.getElementById('ai-fab');
    if (!fab) return;
    if (screenId === 'ai') {
        fab.classList.add('ai-fab-hidden');
        // Close popup if open
        if (_aiPopupOpen) window._aiTogglePopup();
    } else {
        fab.classList.remove('ai-fab-hidden');
    }
};

// ── Sync history when AI screen opens ──
window._aiOnScreenOpen = function () {
    const msgs = document.getElementById('ai-messages');
    if (msgs && _aiChatHistory.length > 0) _aiSyncHistory(msgs);
};
