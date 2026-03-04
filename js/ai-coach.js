// =========================================================================
//  AI Coach — نفس
//  Cloudflare Worker: flat-base-2b1b.mahmoud-1923030.workers.dev
//  Model: llama-3.3-70b-instruct-fp8-fast
// =========================================================================

const AI_WORKER_URL = 'https://flat-base-2b1b.mahmoud-1923030.workers.dev';
const AI_USAGE_KEY = 'nafs_ai_usage';
const AI_MAX_MESSAGES = 50; // الحد الأقصى للرسائل قبل حذف القديمة

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

// ── كلام الـ Worker ──
async function askAICoach(userMessage) {
    const usageStats = JSON.parse(localStorage.getItem(AI_USAGE_KEY) || '{}');
    const state = window.appState || {};

    if (!state.uid) {
        throw new Error('NOT_LOADED');
    }

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

// ── إضافة رسالة في الشاشة ──
function _aiAddMessage(role, content) {
    const msgs = document.getElementById('ai-messages');
    if (!msgs) return;

    // امسح رسالة "ابدأ محادثة" لو موجودة
    const empty = msgs.querySelector('[data-empty]');
    if (empty) empty.remove();

    const div = document.createElement('div');
    div.style.cssText = `
        max-width: 85%;
        padding: 0.75rem 1rem;
        border-radius: ${role === 'user' ? '18px 18px 4px 18px' : '18px 18px 18px 4px'};
        background: ${role === 'user' ? 'rgba(201,168,76,0.12)' : 'rgba(255,255,255,0.04)'};
        border: 1px solid ${role === 'user' ? 'rgba(201,168,76,0.2)' : 'rgba(255,255,255,0.06)'};
        align-self: ${role === 'user' ? 'flex-end' : 'flex-start'};
        color: rgba(242,234,216,0.9);
        font-size: 0.95rem;
        line-height: 1.7;
        animation: fadeIn 0.3s ease;
    `;
    div.innerText = content;
    msgs.appendChild(div);

    // حذف الرسائل القديمة لو تجاوزت الحد
    const allMessages = msgs.querySelectorAll('div:not([data-empty])');
    if (allMessages.length > AI_MAX_MESSAGES) {
        const toRemove = allMessages.length - AI_MAX_MESSAGES;
        for (let i = 0; i < toRemove; i++) allMessages[i].remove();
    }

    msgs.scrollTop = msgs.scrollHeight;
}

// ── إرسال رسالة ──
window._aiSend = async function () {
    const input = document.getElementById('ai-input');
    const sendBtn = document.getElementById('ai-send-btn');
    const msg = input?.value?.trim();
    if (!msg) return;

    // تعطيل الإدخال أثناء الإرسال
    if (input) input.disabled = true;
    if (sendBtn) sendBtn.disabled = true;

    input.value = '';
    _aiAddMessage('user', msg);

    const typing = document.getElementById('ai-typing');
    if (typing) typing.classList.remove('hidden');

    try {
        const reply = await askAICoach(msg);
        if (typing) typing.classList.add('hidden');
        _aiAddMessage('assistant', reply || 'معلش، في مشكلة. جرب تاني.');
    } catch (err) {
        console.error('[AI Coach]', err);
        if (typing) typing.classList.add('hidden');

        let errorMsg = 'حدث خطأ غير متوقع، حاول مرة أخرى';
        const errText = err?.message || '';
        if (errText === 'NOT_LOADED') {
            errorMsg = 'جاري تحميل بياناتك، انتظر لحظة... ⏳';
        } else if (err.name === 'TypeError' && (errText.includes('fetch') || errText.includes('Failed'))) {
            errorMsg = 'تعذّر الاتصال بالخادم — تحقق من اتصالك بالإنترنت 🌐';
        } else if (errText.includes('CORS') || errText.includes('cross-origin')) {
            errorMsg = 'مشكلة CORS — يُنصح بفتح التطبيق من nafs-tracker-live.vercel.app ❌';
        } else if (err.name === 'AbortError') {
            errorMsg = 'انتهت مهلة الطلب — الخادم لا يستجيب ⏱️';
        } else if (errText.includes('NetworkError')) {
            errorMsg = 'تعذّر الاتصال بالخادم — تحقق من اتصالك بالإنترنت 🌐';
        } else if (errText.startsWith('HTTP')) {
            errorMsg = `خطأ من الخادم (${errText}) — جرب تاني ❌`;
        }
        _aiAddMessage('assistant', errorMsg);
    } finally {
        // إعادة تفعيل الإدخال
        if (input) input.disabled = false;
        if (sendBtn) sendBtn.disabled = false;
        if (input) input.focus();
    }
};

// ── أسئلة سريعة ──
window._aiQuickAsk = function (q) {
    const input = document.getElementById('ai-input');
    if (input) { input.value = q; input.focus(); }
    window._aiSend();
};
