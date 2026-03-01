// =========================================================================
//  ES Module Imports
// =========================================================================
import { DEFAULT_MORNING_AZKAR, DEFAULT_EVENING_AZKAR, DEFAULT_NIGHT_AZKAR, DEFAULT_AFTER_PRAYER_AZKAR, DEFAULT_NAWAFL, DEFAULT_PODCASTS } from './js/constants/azkar-data.js';
import { QURAN_SURAHS, QURAN_RECITERS, QURAN_AUDIO_FALLBACKS } from './js/constants/quran-data.js';
import { COUNTRIES, ADHAN_URLS, NAMES_OF_ALLAH, DAILY_HADITHS, HADITH_API_BASE, HADITH_COLLECTIONS, DUA_CATEGORIES } from './js/constants/islamic-data.js';
import { firebaseConfig } from './js/firebase-config.js';

// =========================================================================
//  Firebase Setup
// =========================================================================
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// =========================================================================
//  Global Error Handler
// =========================================================================
window.onerror = function (msg, src, line, col, err) {
    console.error(`[Nafs Error] ${msg} at ${src}:${line}:${col}`, err);
    if (typeof showToast === 'function') showToast('حدث خطأ غير متوقع', 'error');
    return false;
};
window.addEventListener('unhandledrejection', function (e) {
    console.error('[Nafs Unhandled Promise]', e.reason);
    if (typeof showToast === 'function' && e.reason?.message && !e.reason.message.includes('auth')) {
        showToast('خطأ في الاتصال: ' + (e.reason.message || '').slice(0, 60), 'error');
    }
});

db.enablePersistence({ synchronizeTabs: true }).catch(err => {
    if (err.code !== 'failed-precondition' && err.code !== 'unimplemented') {
        console.warn('Firestore persistence error:', err);
    }
});

const googleProvider = new firebase.auth.GoogleAuthProvider();

// Use LOCAL persistence so the user stays logged in across sessions
try {
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => { });
} catch (e) {
    // ignore if not supported in this environment
}

// =========================================================================
//  المتغيرات العامة
// =========================================================================
let currentUser = null;
let userId = null;
let appState = null;
let prayerTimesCache = null;
let currentEditDhikrId = null;
let currentEditCategory = null;
let isLightMode = false;
let emergencyInterval = null;
let currentSetProgressId = null;
let currentSetProgressCategory = null;
let confirmCallback = null;
let dailyChallenge = { text: '', date: null };
let reminderIntervalId = null;
let activeAdhkarTab = 'morning';
let appInitialized = false;
let authUnsubscribe = null;
const dhikrDebounceMap = {};
let pendingSaveCount = 0;

// Dhikr completion feedback: tracks which dhikrs already fired the
// completion celebration this session (reset on daily reset / reload).
const dhikrCompletedSet = new Set();

// Lazy-initialized Audio for dhikr chime (short sine-wave beep,
// generated via AudioContext on first use to avoid external file deps).
let _dhikrChimeCtx = null;

/**
 * Play a short spiritual chime using Web Audio API.
 * No external file needed — generates a gentle bell-like tone.
 */
function playDhikrChime() {
    try {
        if (!_dhikrChimeCtx) _dhikrChimeCtx = new (window.AudioContext || window.webkitAudioContext)();
        const ctx = _dhikrChimeCtx;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(830, ctx.currentTime);        // high C-ish
        osc.frequency.exponentialRampToValueAtTime(415, ctx.currentTime + 0.35);
        gain.gain.setValueAtTime(0.18, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.5);
    } catch (e) { /* AudioContext not available */ }
}

/**
 * Called once when a dhikr reaches its required count.
 * Vibrates, shows a congratulatory toast, and optionally plays sound.
 */
function onDhikrComplete(dhikr) {
    // Vibration (mobile)
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);

    // Toast
    showToast('✅ تم كسب الثواب إن شاء الله', 'success');

    // Sound (if enabled in settings — plays on completion)
    const soundEnabled = appState?.settings?.dhikrSoundEnabled === true;
    if (soundEnabled) playDhikrChime();

    console.log(`🏆 Completed dhikr: ${dhikr.text.slice(0, 50)}`);
}

/**
 * Called on every repetition increment.
 * If sound-on-each-rep setting is on, plays the chime.
 */
function onDhikrRepetition(dhikr) {
    const soundEnabled = appState?.settings?.dhikrSoundEnabled === true;
    const soundPerRep = appState?.settings?.dhikrSoundPerRep === true;
    if (soundEnabled && soundPerRep) playDhikrChime();
}

// Mushaf state
let currentMushafPage = 1;
let mushafLoading = false;

// LRU cache for mushaf pages (capped at 20 to prevent memory leaks)
const MUSHAF_CACHE_MAX = 20;
const mushafPageCache = new Map();
function mushafCacheGet(pageNum) {
    if (!mushafPageCache.has(pageNum)) return undefined;
    const val = mushafPageCache.get(pageNum);
    // Move to end (most-recently used)
    mushafPageCache.delete(pageNum);
    mushafPageCache.set(pageNum, val);
    return val;
}
function mushafCacheSet(pageNum, data) {
    if (mushafPageCache.has(pageNum)) mushafPageCache.delete(pageNum);
    mushafPageCache.set(pageNum, data);
    // Evict oldest if over limit
    if (mushafPageCache.size > MUSHAF_CACHE_MAX) {
        const oldest = mushafPageCache.keys().next().value;
        mushafPageCache.delete(oldest);
    }
}

// =========================================================================
//  دوال مساعدة
// =========================================================================
function safeJsonParse(str, fallback = null) {
    try { return JSON.parse(str); } catch { return fallback; }
}
function safeLocalStorageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { }
}
function safeLocalStorageGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}

// =========================================================================
//  Rate Limiter — prevents flooding external APIs
// =========================================================================
const _rateLimitMap = {};
/**
 * Returns true if the action is allowed, false if rate-limited.
 * @param {string} key   Unique identifier (e.g. 'aladhan', 'hadith')
 * @param {number} cooldownMs  Minimum milliseconds between calls (default 3s)
 */
function rateLimitOk(key, cooldownMs = 3000) {
    const now = Date.now();
    if (_rateLimitMap[key] && now - _rateLimitMap[key] < cooldownMs) return false;
    _rateLimitMap[key] = now;
    return true;
}

// =========================================================================
//  Offline Write Queue — queues Firestore writes when offline
// =========================================================================
const _offlineQueue = [];
let _offlineFlushRunning = false;

function queueOfflineWrite(path, value) {
    _offlineQueue.push({ path, value, ts: Date.now() });
    safeLocalStorageSet('nafs_offline_queue', JSON.stringify(_offlineQueue));
}

async function flushOfflineQueue() {
    if (_offlineFlushRunning || _offlineQueue.length === 0 || !userId) return;
    _offlineFlushRunning = true;
    try {
        while (_offlineQueue.length > 0) {
            const item = _offlineQueue[0];
            await db.collection('users').doc(userId).update({ [item.path]: item.value });
            _offlineQueue.shift();
        }
        safeLocalStorageSet('nafs_offline_queue', '[]');
    } catch (e) {
        console.warn('[Nafs] Offline queue flush failed, will retry:', e.message);
    } finally {
        _offlineFlushRunning = false;
    }
}

function restoreOfflineQueue() {
    const saved = safeJsonParse(safeLocalStorageGet('nafs_offline_queue'), []);
    if (Array.isArray(saved) && saved.length > 0) {
        _offlineQueue.push(...saved);
        flushOfflineQueue();
    }
}

// Flush when coming back online
window.addEventListener('online', () => {
    flushOfflineQueue();
    showToast('تم استعادة الاتصال 🌐');
});
window.addEventListener('offline', () => {
    showToast('أنت غير متصل بالإنترنت — سيتم حفظ التغييرات محلياً', 'warning');
});

function generateId(prefix = 'id') {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return prefix + '_' + crypto.randomUUID();
        }
    } catch (e) { }
    const arr = new Uint32Array(4);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(arr);
        return prefix + '_' + Array.from(arr).map(n => n.toString(16).padStart(8, '0')).join('');
    }
    return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function safeUrl(url) {
    if (!url) return '#';
    try {
        const u = new URL(url);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return '#';
        return u.href;
    } catch { return '#'; }
}

let toastTimeout = null;
function showToast(message, type = 'success') {
    const existing = document.querySelectorAll('.toast');
    existing.forEach(t => t.remove());
    if (toastTimeout) clearTimeout(toastTimeout);
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerText = message;
    document.body.appendChild(toast);
    toastTimeout = setTimeout(() => { toast.remove(); toastTimeout = null; }, 3500);
}

// Skeleton loading placeholder for async screens
function showSkeleton(containerId, count = 3) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = Array.from({ length: count }, () =>
        `<div class="skeleton skeleton-card"></div>`
    ).join('') + '<div class="skeleton skeleton-line" style="width:60%"></div>';
}

async function showBrowserNotification(title, body) {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
        new Notification(title, { body });
    } else if (Notification.permission !== 'denied') {
        const perm = await Notification.requestPermission().catch(() => 'denied');
        if (perm === 'granted') new Notification(title, { body });
    }
}

async function requestNotificationPermission() {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        await Notification.requestPermission().catch(() => { });
    }
}

function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('active');
}
function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
}

document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
        // Close emergency mode if active
        const emOverlay = document.getElementById('emergency-overlay');
        if (emOverlay && !emOverlay.classList.contains('hidden')) {
            deactivateEmergency();
            return;
        }
        // Exit focus mode if active
        if (document.body.classList.contains('focus-mode')) {
            toggleFocusMode();
            return;
        }
        document.querySelectorAll('.modal-overlay.active[data-closable="true"]').forEach(m => m.classList.remove('active'));
        const confirmOverlay = document.getElementById('custom-confirm');
        if (confirmOverlay && confirmOverlay.classList.contains('active')) {
            if (confirmCallback?.onNo) confirmCallback.onNo();
            closeConfirm();
        }
    }
    // Keyboard shortcuts: Alt+number for navigation
    if (e.altKey && !e.ctrlKey && !e.shiftKey) {
        const shortcuts = { '1': 'dashboard', '2': 'adhkar', '3': 'prayer', '4': 'mushaf', '5': 'tasbih', '6': 'hadith', '7': 'dua', '8': 'qibla', '9': 'names99', '0': 'settings' };
        if (shortcuts[e.key]) { e.preventDefault(); showScreen(shortcuts[e.key]); }
        if (e.key === 'f') { e.preventDefault(); toggleFocusMode(); }
    }
});
document.addEventListener('click', function (e) {
    if (e.target.classList.contains('modal-overlay') && e.target.dataset.closable === 'true') {
        e.target.classList.remove('active');
    }
});

function showConfirm(message, onYes, onNo) {
    const overlay = document.getElementById('custom-confirm');
    document.getElementById('confirm-message').innerText = message;
    overlay.classList.add('active');
    confirmCallback = { onYes, onNo };
}
function closeConfirm() {
    document.getElementById('custom-confirm').classList.remove('active');
    confirmCallback = null;
}

document.getElementById('confirm-yes').addEventListener('click', () => {
    if (confirmCallback?.onYes) confirmCallback.onYes();
    closeConfirm();
});
document.getElementById('confirm-no').addEventListener('click', () => {
    if (confirmCallback?.onNo) confirmCallback.onNo();
    closeConfirm();
});

function refreshDashboard() {
    const dash = document.getElementById('screen-dashboard');
    if (dash && !dash.classList.contains('hidden')) renderDashboard();
}

window.toggleMoreMenu = function () {
    const m = document.getElementById('more-menu');
    if (!m) return;
    const isHidden = m.classList.toggle('hidden');
    // Toggle backdrop
    let backdrop = document.getElementById('more-menu-backdrop');
    if (!isHidden) {
        if (!backdrop) {
            backdrop = document.createElement('div');
            backdrop.id = 'more-menu-backdrop';
            backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:38;backdrop-filter:blur(2px)';
            backdrop.onclick = () => closeMoreMenu();
            document.body.appendChild(backdrop);
        } else {
            backdrop.style.display = '';
        }
    } else if (backdrop) {
        backdrop.style.display = 'none';
    }
};
window.closeMoreMenu = function () {
    const m = document.getElementById('more-menu');
    if (m) m.classList.add('hidden');
    const backdrop = document.getElementById('more-menu-backdrop');
    if (backdrop) backdrop.style.display = 'none';
};

// Hide/Show mobile bottom nav
window.toggleMobileNav = function () {
    const nav = document.getElementById('mobile-nav');
    const btn = document.getElementById('nav-toggle-btn');
    if (!nav || !btn) return;
    const isHidden = nav.classList.toggle('nav-hidden');
    const icon = btn.querySelector('i');
    if (isHidden) {
        icon.className = 'fas fa-chevron-up';
        btn.style.bottom = '8px';
        // Also close more menu if open
        const more = document.getElementById('more-menu');
        if (more) more.classList.add('hidden');
    } else {
        icon.className = 'fas fa-chevron-down';
        btn.style.bottom = '70px';
    }
};

document.addEventListener('click', function (e) {
    const more = document.getElementById('more-menu');
    if (more && !more.classList.contains('hidden')) {
        const moreBtn = document.getElementById('mnav-more');
        if (!more.contains(e.target) && (!moreBtn || !moreBtn.contains(e.target))) {
            closeMoreMenu();
        }
    }
});

function getLocalDateString(date) {
    const d = date || new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// =========================================================================
//  Focus Mode - hides header, sidebar, nav to focus on current task
// =========================================================================
function toggleFocusMode() {
    document.body.classList.toggle('focus-mode');
    const active = document.body.classList.contains('focus-mode');
    showToast(active ? 'وضع التركيز مفعّل (Alt+F أو Esc للخروج)' : 'تم إيقاف وضع التركيز');
}

// =========================================================================
//  Global Font Size Control
// =========================================================================
function setAppFontSize(size) {
    const s = Math.max(12, Math.min(24, parseInt(size)));
    document.documentElement.style.setProperty('--base-font', s + 'px');
    if (appState?.settings) {
        appState.settings.appFontSize = s;
        saveSettings();
    }
}

function loadAppFontSize() {
    const size = appState?.settings?.appFontSize;
    if (size) document.documentElement.style.setProperty('--base-font', size + 'px');
}

// =========================================================================
//  Ramadan Mode Detection & Enhancement
// =========================================================================
function isRamadan() {
    try {
        const formatter = new Intl.DateTimeFormat('en-u-ca-islamic', { month: 'numeric' });
        const hijriMonth = parseInt(formatter.format(new Date()));
        return hijriMonth === 9; // Ramadan is month 9
    } catch { return false; }
}

function getRamadanDay() {
    try {
        const formatter = new Intl.DateTimeFormat('en-u-ca-islamic', { day: 'numeric', month: 'numeric' });
        const parts = formatter.formatToParts(new Date());
        const month = parseInt(parts.find(p => p.type === 'month')?.value);
        const day = parseInt(parts.find(p => p.type === 'day')?.value);
        return month === 9 ? day : 0;
    } catch { return 0; }
}

function getRamadanBanner() {
    if (!isRamadan()) return '';
    const day = getRamadanDay();
    return `
    <div class="card glass-card" style="background:linear-gradient(135deg,rgba(200,170,78,0.15),rgba(15,53,39,0.8)) !important;border:1px solid rgba(200,170,78,0.3);text-align:center;padding:1.25rem">
        <div style="font-size:2rem;margin-bottom:0.5rem">🌙</div>
        <h3 style="color:var(--accent-gold);font-size:1.2rem;font-weight:800;margin-bottom:0.25rem">رمضان كريم</h3>
        <p style="color:var(--text-secondary);font-size:0.9rem">اليوم ${day} من رمضان المبارك</p>
        <p style="color:var(--accent-gold);font-size:0.8rem;margin-top:0.5rem">✨ النقاط مضاعفة في رمضان!</p>
    </div>`;
}

// =========================================================================
//  Activity Heatmap (GitHub-style calendar)
// =========================================================================
function renderActivityHeatmap() {
    const dailyPoints = appState?.dailyPoints || {};
    const weeks = 12; // Show 12 weeks
    const today = new Date();
    const cells = [];
    const dayLabels = ['أحد', '', 'ثلا', '', 'خمي', '', 'سبت'];

    for (let w = weeks - 1; w >= 0; w--) {
        for (let d = 0; d < 7; d++) {
            const date = new Date(today);
            date.setDate(today.getDate() - (w * 7 + (today.getDay() - d)));
            if (date > today) { cells.push('<div style="width:14px;height:14px"></div>'); continue; }
            const ds = getLocalDateString(date);
            const points = dailyPoints[ds] || 0;
            let color;
            if (points === 0) color = 'rgba(200,170,78,0.06)';
            else if (points < 10) color = 'rgba(200,170,78,0.2)';
            else if (points < 30) color = 'rgba(200,170,78,0.4)';
            else if (points < 60) color = 'rgba(200,170,78,0.6)';
            else color = 'rgba(200,170,78,0.85)';
            cells.push(`<div title="${ds}: ${points} نقطة" style="width:14px;height:14px;border-radius:3px;background:${color};cursor:default"></div>`);
        }
    }

    return `
    <div class="card glass-card p-4">
        <h3 class="text-gold font-bold text-lg mb-3"><i class="fas fa-fire-alt me-2"></i>خريطة النشاط</h3>
        <div style="display:flex;gap:2px;overflow-x:auto;direction:ltr">
            <div style="display:flex;flex-direction:column;gap:2px;margin-left:4px;font-size:0.6rem;color:var(--text-muted)">
                ${dayLabels.map(l => `<div style="height:14px;display:flex;align-items:center">${l}</div>`).join('')}
            </div>
            <div style="display:grid;grid-template-rows:repeat(7,14px);grid-auto-flow:column;gap:2px">
                ${cells.join('')}
            </div>
        </div>
        <div style="display:flex;align-items:center;gap:4px;justify-content:flex-end;margin-top:8px;font-size:0.65rem;color:var(--text-muted)">
            <span>أقل</span>
            <div style="width:12px;height:12px;border-radius:2px;background:rgba(200,170,78,0.06)"></div>
            <div style="width:12px;height:12px;border-radius:2px;background:rgba(200,170,78,0.2)"></div>
            <div style="width:12px;height:12px;border-radius:2px;background:rgba(200,170,78,0.4)"></div>
            <div style="width:12px;height:12px;border-radius:2px;background:rgba(200,170,78,0.6)"></div>
            <div style="width:12px;height:12px;border-radius:2px;background:rgba(200,170,78,0.85)"></div>
            <span>أكثر</span>
        </div>
    </div>`;
}

// =========================================================================
//  SVG Logo
// =========================================================================
function getLogo(size = 'small') {
    const w = size === 'large' ? '110px' : '70px';
    const cls = size === 'large' ? 'app-logo-icon-large' : 'app-logo-icon';
    return `<div class="${cls}" style="width:${w};height:${w}">
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" width="90%" height="90%">
          <defs>
            <radialGradient id="moonGrad" cx="50%" cy="50%" r="50%">
              <stop offset="0%" style="stop-color:#f0d060;stop-opacity:1"/>
              <stop offset="100%" style="stop-color:#d4af37;stop-opacity:1"/>
            </radialGradient>
            <radialGradient id="bgGrad" cx="50%" cy="50%" r="50%">
              <stop offset="0%" style="stop-color:#1c6b45;stop-opacity:1"/>
              <stop offset="100%" style="stop-color:#0a2f1f;stop-opacity:1"/>
            </radialGradient>
          </defs>
          <circle cx="50" cy="50" r="50" fill="url(#bgGrad)"/>
          <circle cx="48" cy="50" r="26" fill="url(#moonGrad)"/>
          <circle cx="57" cy="44" r="20" fill="#0a2f1f"/>
          <polygon points="78,20 80,26 87,26 81,30 83,37 78,33 73,37 75,30 69,26 76,26"
            fill="url(#moonGrad)" opacity="0.9"/>
          <circle cx="50" cy="55" r="5" fill="#0a2f1f" opacity="0.7"/>
          <path d="M42,75 Q50,62 58,75" stroke="#0a2f1f" stroke-width="3" fill="none" opacity="0.7"/>
        </svg>
    </div>`;
}

// =========================================================================
//  saveUserField with pendingSave tracking
// =========================================================================
async function saveUserField(path, value) {
    if (!userId) return;
    pendingSaveCount++;
    try {
        await db.collection('users').doc(userId).update({ [path]: value });
    } catch (e) {
        try {
            await db.collection('users').doc(userId).set({ [path]: value }, { merge: true });
        } catch (e2) { console.error('save error:', path, e2); }
    } finally {
        pendingSaveCount = Math.max(0, pendingSaveCount - 1);
    }
}

window.addEventListener('beforeunload', (e) => {
    if (pendingSaveCount > 0) {
        e.preventDefault();
        e.returnValue = '';
    }
});

// =========================================================================
//  Subcollection helpers (scalable date-keyed data)
//  Dual-write: saves to both flat doc field AND subcollection.
//  Reads still use the flat doc for backward compatibility.
// =========================================================================
const SUBCOLLECTION_FIELDS = ['prayerLogs', 'adhkarHistory', 'dailyPoints', 'naflLogs', 'journal'];

async function saveToSubcollection(collectionName, docId, data) {
    if (!userId || !SUBCOLLECTION_FIELDS.includes(collectionName)) return;
    try {
        await db.collection('users').doc(userId)
            .collection(collectionName).doc(docId)
            .set(data, { merge: true });
    } catch (e) {
        console.warn(`Subcollection write failed (${collectionName}/${docId}):`, e.message);
    }
}

// Enhanced saveUserField: dual-write for date-keyed fields
async function saveUserFieldDual(fieldPath, value) {
    // Always save to flat document (backward compatible)
    await saveUserField(fieldPath, value);

    // Also write to subcollection if it's a date-keyed field
    // e.g. fieldPath = "prayerLogs.2024-01-15" → collection="prayerLogs", doc="2024-01-15"
    const parts = fieldPath.split('.');
    if (parts.length === 2 && SUBCOLLECTION_FIELDS.includes(parts[0])) {
        await saveToSubcollection(parts[0], parts[1], typeof value === 'object' ? value : { value });
    }
}

// One-time migration: copy flat doc data into subcollections
async function migrateToSubcollections() {
    if (!userId || !appState) return { migrated: 0, errors: 0 };
    let migrated = 0, errors = 0;
    const batch_size = 400; // Firestore batch limit is 500

    for (const field of SUBCOLLECTION_FIELDS) {
        const data = appState[field];
        if (!data || typeof data !== 'object') continue;

        const entries = Object.entries(data);
        // Process in batches
        for (let i = 0; i < entries.length; i += batch_size) {
            const batch = db.batch();
            const chunk = entries.slice(i, i + batch_size);
            for (const [dateKey, docData] of chunk) {
                const ref = db.collection('users').doc(userId)
                    .collection(field).doc(dateKey);
                batch.set(ref, typeof docData === 'object' ? docData : { value: docData }, { merge: true });
            }
            try {
                await batch.commit();
                migrated += chunk.length;
            } catch (e) {
                console.error(`Migration batch error (${field}):`, e);
                errors += chunk.length;
            }
        }
    }
    return { migrated, errors };
}

window.migrateToSubcollections = async function () {
    showToast('جارٍ ترحيل البيانات...', 'info');
    const { migrated, errors } = await migrateToSubcollections();
    if (errors === 0) {
        showToast(`تم ترحيل ${migrated} سجل بنجاح ✅`, 'success');
    } else {
        showToast(`تم ترحيل ${migrated} سجل، فشل ${errors} ⚠️`, 'warning');
    }
};

// =========================================================================
//  recalculateTotalPoints - no double counting adhkar
// =========================================================================
async function recalculateTotalPoints() {
    let total = 0;

    const prayerLogs = appState.prayerLogs || {};
    Object.keys(prayerLogs).forEach(date => {
        const day = prayerLogs[date];
        ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'].forEach(prayer => {
            const p = day[prayer];
            if (!p || !p.status || p.status === 'missed') return;
            let pts = 0;
            if (p.status === 'onTime' && p.congregation === 'jamah') pts = 10;
            else if (p.status === 'onTime' && p.congregation === 'alone') pts = 8;
            else if (p.status === 'late' && p.congregation === 'jamah') pts = 6;
            else if (p.status === 'late' && p.congregation === 'alone') pts = 4;
            if (p.stars) pts += parseInt(p.stars) || 0;
            total += pts;
        });
    });

    const adhkarHistory = appState.adhkarHistory || {};
    const todayStr = getLocalDateString();
    Object.entries(adhkarHistory).forEach(([date, dayPoints]) => {
        if (date !== todayStr) total += dayPoints || 0;
    });
    total += calculateTodayAdhkarPoints();

    const dailyPages = appState.quranProgress?.dailyPages || {};
    Object.values(dailyPages).forEach(pages => { total += (pages || 0) * 5; });

    const quranReadProgress = appState.quranProgress?.quranReadProgress || {};
    const readPagesCount = Object.keys(quranReadProgress).filter(page => quranReadProgress[page]).length;
    total += readPagesCount * 3;

    const naflLogs = appState.naflLogs || {};
    const nafls = appState.naflPrayers || [];
    Object.keys(naflLogs).forEach(date => {
        const day = naflLogs[date];
        nafls.forEach(nafl => {
            if (day[nafl.id]) total += nafl.points || 5;
        });
    });

    const newTotal = Math.max(0, total);

    // Track daily points for heatmap
    if (!appState.dailyPoints) appState.dailyPoints = {};
    const todayPoints = calculateTodayAdhkarPoints() + (appState.quranProgress?.dailyPages?.[todayStr] || 0) * 5;
    appState.dailyPoints[todayStr] = todayPoints;

    if (newTotal !== appState.totalPoints) {
        appState.totalPoints = newTotal;
        appState.level = Math.floor(newTotal / 100) + 1;
        await db.collection('users').doc(userId).update({
            totalPoints: appState.totalPoints,
            level: appState.level
        }).catch(() => { });
        const el = document.getElementById('total-points-display');
        if (el) el.innerText = appState.totalPoints;
    }
}

async function updateStreak(wasPositiveAction = true) {
    if (!wasPositiveAction) return;
    const today = getLocalDateString();
    if (appState.lastActivityDate === today) return;

    if (!appState.lastActivityDate) {
        appState.streak = 1;
    } else {
        // Parse date strings as local dates (not UTC) to avoid timezone drift
        const [ty, tm, td] = today.split('-').map(Number);
        const [ly, lm, ld] = appState.lastActivityDate.split('-').map(Number);
        const todayLocal = new Date(ty, tm - 1, td);
        const lastLocal = new Date(ly, lm - 1, ld);
        const diff = Math.round((todayLocal - lastLocal) / (1000 * 60 * 60 * 24));
        if (diff === 1) appState.streak = (appState.streak || 0) + 1;
        else if (diff > 1) appState.streak = 1;
    }

    appState.lastActivityDate = today;
    if (appState.streak > (appState.longestStreak || 0)) appState.longestStreak = appState.streak;

    await db.collection('users').doc(userId).update({
        streak: appState.streak,
        longestStreak: appState.longestStreak,
        lastActivityDate: today
    }).catch(() => { });

    const el = document.getElementById('streakDisplay');
    if (el) el.innerText = appState.streak;
    refreshDashboard();
}

async function checkAndResetDailyProgress() {
    if (!appState?.settings) return;
    const resetTime = appState.settings.dailyResetTime || '00:00';
    const now = new Date();
    const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    const todayDate = getLocalDateString();
    const lastReset = appState.lastDailyReset;

    // FIX: If lastReset is null (first ever use), just set it to today without resetting
    if (!lastReset) {
        appState.lastDailyReset = todayDate;
        await saveUserField('lastDailyReset', todayDate);
        return;
    }

    const shouldReset = lastReset !== todayDate && currentTime >= resetTime;

    if (shouldReset) {
        const todayAdhkarPoints = calculateTodayAdhkarPoints();
        if (todayAdhkarPoints > 0) {
            if (!appState.adhkarHistory) appState.adhkarHistory = {};
            appState.adhkarHistory[lastReset] = (appState.adhkarHistory[lastReset] || 0) + todayAdhkarPoints;
            await saveUserField('adhkarHistory', appState.adhkarHistory);
            await saveToSubcollection('adhkarHistory', lastReset, { points: appState.adhkarHistory[lastReset] });
        }

        appState.adhkarProgress = {};
        await saveUserField('adhkarProgress', {});
        dhikrCompletedSet.clear(); // allow completion feedback again after daily reset

        if (!appState.naflLogs) appState.naflLogs = {};
        delete appState.naflLogs[todayDate];
        await saveUserField('naflLogs', appState.naflLogs);

        appState.lastDailyReset = todayDate;
        await saveUserField('lastDailyReset', todayDate);
        showToast('تم تصفير الأذكار لليوم الجديد');
        await recalculateTotalPoints();
    }
}

let dailyResetIntervalId = null;
function startDailyResetChecker() {
    if (dailyResetIntervalId) clearInterval(dailyResetIntervalId);
    dailyResetIntervalId = setInterval(() => {
        if (appState) checkAndResetDailyProgress();
    }, 60000);
}

/**
 * Returns the points earned per single repetition of a dhikr.
 * If the dhikr has a custom `pointsPerRep`, use that;
 * otherwise derive it as `(dhikr.points / dhikr.count)` (default 1).
 */
function getDhikrPointsPerRep(dhikr) {
    if (dhikr.pointsPerRep != null && dhikr.pointsPerRep > 0) return dhikr.pointsPerRep;
    const totalPts = dhikr.points || 5;
    const count = dhikr.count || 1;
    return totalPts / count;
}

function calculateTodayAdhkarPoints() {
    let pts = 0;
    const allDhikr = [
        ...(appState.editedAzkar?.morning || []),
        ...(appState.editedAzkar?.evening || []),
        ...(appState.editedAzkar?.night || []),
        ...(appState.editedAzkar?.afterprayer || []),
        ...(appState.customAdhkar || [])
    ];
    allDhikr.forEach(d => {
        const progress = appState.adhkarProgress?.[d.id] || 0;
        if (progress <= 0) return;
        const perRep = getDhikrPointsPerRep(d);
        pts += Math.round(perRep * progress * 10) / 10;
    });
    return Math.round(pts);
}

function getQuranReadingPoints() {
    const today = getLocalDateString();
    const dailyPages = appState.quranProgress?.dailyPages?.[today] || 0;
    return dailyPages * 5;
}

function structuredCloneAzkar(arr) {
    try { return structuredClone(arr); } catch { return JSON.parse(JSON.stringify(arr)); }
}

// =========================================================================
//  Data Cleanup – prune date-keyed objects older than RETENTION_DAYS
// =========================================================================
const DATA_RETENTION_DAYS = 90;

async function pruneOldData() {
    if (!appState || !userId) return;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - DATA_RETENTION_DAYS);
    const cutoffStr = getLocalDateString(cutoff);

    const fieldsToClean = ['prayerLogs', 'adhkarHistory', 'dailyPoints', 'naflLogs'];
    const updates = {};
    let pruned = false;

    for (const field of fieldsToClean) {
        const obj = appState[field];
        if (!obj || typeof obj !== 'object') continue;
        const keysToRemove = Object.keys(obj).filter(k => k < cutoffStr);
        if (keysToRemove.length === 0) continue;
        keysToRemove.forEach(k => {
            delete obj[k];
            // Use Firestore FieldValue.delete() via dot notation
            updates[`${field}.${k}`] = firebase.firestore.FieldValue.delete();
        });
        pruned = true;
    }

    // Also trim quranProgress.dailyPages
    const dp = appState.quranProgress?.dailyPages;
    if (dp && typeof dp === 'object') {
        const keysToRemove = Object.keys(dp).filter(k => k < cutoffStr);
        if (keysToRemove.length > 0) {
            keysToRemove.forEach(k => {
                delete dp[k];
                updates[`quranProgress.dailyPages.${k}`] = firebase.firestore.FieldValue.delete();
            });
            pruned = true;
        }
    }

    if (pruned && Object.keys(updates).length > 0) {
        try {
            await db.collection('users').doc(userId).update(updates);
            console.log(`Pruned ${Object.keys(updates).length} old data entries (>${DATA_RETENTION_DAYS} days)`);
        } catch (e) {
            console.warn('Data pruning failed (non-critical):', e.message);
        }
    }
}

const defaultData = {
    streak: 0, longestStreak: 0, totalPoints: 0, level: 1, badges: [],
    settings: { dailyWorshipGoal: 5, quranPagesPerDay: 2, targetKhatmaDays: 30, dailyResetTime: '00:00' },
    quranProgress: { currentPage: 1, totalPagesRead: 0, totalKhatma: 0, dailyPages: {}, currentJuz: 1, currentHizb: 1, quranReadProgress: {} },
    adhkarProgress: {}, adhkarHistory: {},
    prayerLogs: {}, naflPrayers: [], naflLogs: {}, customAdhkar: [],
    defaultAzkar: {
        morning: structuredCloneAzkar(DEFAULT_MORNING_AZKAR),
        evening: structuredCloneAzkar(DEFAULT_EVENING_AZKAR),
        night: structuredCloneAzkar(DEFAULT_NIGHT_AZKAR),
        afterprayer: structuredCloneAzkar(DEFAULT_AFTER_PRAYER_AZKAR)
    },
    editedAzkar: {
        morning: structuredCloneAzkar(DEFAULT_MORNING_AZKAR),
        evening: structuredCloneAzkar(DEFAULT_EVENING_AZKAR),
        night: structuredCloneAzkar(DEFAULT_NIGHT_AZKAR),
        afterprayer: structuredCloneAzkar(DEFAULT_AFTER_PRAYER_AZKAR)
    },
    journal: [], reminders: [], lastActivityDate: null,
    preferredName: null, lastDailyReset: null,
    customPodcasts: [], naflsInitialized: false
};

async function loadUserData(uid) {
    const docRef = db.collection('users').doc(uid);
    let userData = {};
    let docSnap = null;

    try {
        docSnap = await docRef.get();
        userData = docSnap.exists ? docSnap.data() : {};
    } catch (error) {
        console.error('Error loading user data:', error);
        showToast('تعذر تحميل البيانات، يتم استخدام البيانات المحلية', 'warning');
    }

    Object.keys(defaultData).forEach(key => {
        if (!(key in userData)) {
            userData[key] = defaultData[key];
        }
    });

    userData.settings = { ...defaultData.settings, ...(userData.settings || {}) };
    userData.quranProgress = { ...defaultData.quranProgress, ...(userData.quranProgress || {}) };

    // FIX: Smart merge - keep user customizations, add new defaults
    const freshDefaults = structuredCloneAzkar(defaultData.editedAzkar);
    if (userData.editedAzkar && typeof userData.editedAzkar === 'object') {
        ['morning', 'evening', 'night', 'afterprayer'].forEach(cat => {
            const userCat = userData.editedAzkar[cat] || [];
            const defaultCat = freshDefaults[cat] || [];
            const userIds = new Set(userCat.map(d => d.id));
            // Add any new defaults that user doesn't have yet
            defaultCat.forEach(d => {
                if (!userIds.has(d.id)) userCat.push(structuredCloneAzkar([d])[0]);
            });
            userData.editedAzkar[cat] = userCat;
        });
    } else {
        userData.editedAzkar = freshDefaults;
    }

    if (!userData.defaultAzkar) userData.defaultAzkar = defaultData.defaultAzkar;

    if (!userData.adhkarHistory) userData.adhkarHistory = {};
    if (!userData.naflLogs) userData.naflLogs = {};
    if (!userData.customAdhkar) userData.customAdhkar = [];

    if (!userData.naflsInitialized || !userData.naflPrayers || userData.naflPrayers.length === 0) {
        if (!userData.naflsInitialized) {
            userData.naflPrayers = JSON.parse(JSON.stringify(DEFAULT_NAWAFL));
            userData.naflsInitialized = true;
        }
    }
    if (!userData.customPodcasts) userData.customPodcasts = [];

    try {
        if (!docSnap || !docSnap.exists) {
            await docRef.set(userData);
        } else {
            const existingData = docSnap.data() || {};
            const missingFields = {};
            Object.keys(userData).forEach(key => {
                if (!(key in existingData)) {
                    missingFields[key] = userData[key];
                }
            });
            if (Object.keys(missingFields).length > 0) {
                await docRef.update(missingFields);
            }
        }
    } catch (e) { console.error('Error saving default data:', e); }

    return userData;
}

// =========================================================================
//  بيانات التحليل
// =========================================================================
function getWeeklyAzkarData() {
    const history = appState.adhkarHistory || {};
    const data = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const ds = getLocalDateString(d);
        if (i === 0) data.push(calculateTodayAdhkarPoints());
        else data.push(history[ds] || 0);
    }
    return data;
}

function getWeeklyPrayerData() {
    const logs = appState.prayerLogs || {};
    const data = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const ds = getLocalDateString(d);
        data.push(logs[ds] ? ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']
            .filter(p => logs[ds][p]?.status && logs[ds][p].status !== 'missed').length : 0);
    }
    return data;
}

function getWeeklyQuranData() {
    const daily = appState.quranProgress?.dailyPages || {};
    const data = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        data.push(daily[getLocalDateString(d)] || 0);
    }
    return data;
}

function calculateCommitmentStats() {
    const days = 7;
    const today = new Date();
    let totalPrayers = 0, performedPrayers = 0;
    let azkarPointsSum = 0, azkarMaxPoints = 0;
    let quranTotal = 0;
    const expectedQuranPages = (appState.settings?.quranPagesPerDay || 2) * days;
    const logs = appState.prayerLogs || {};
    const adhkarHistory = appState.adhkarHistory || {};

    const allDhikr = [
        ...(appState.editedAzkar?.morning || []),
        ...(appState.editedAzkar?.evening || []),
        ...(appState.editedAzkar?.night || []),
        ...(appState.editedAzkar?.afterprayer || []),
        ...(appState.customAdhkar || [])
    ];
    const maxDailyAzkar = allDhikr.reduce((s, d) => s + (d.points || 5), 0);

    for (let i = 0; i < days; i++) {
        const d = new Date(today); d.setDate(d.getDate() - i);
        const ds = getLocalDateString(d);
        totalPrayers += 5;
        if (logs[ds]) {
            ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'].forEach(p => {
                if (logs[ds][p]?.status && logs[ds][p].status !== 'missed') performedPrayers++;
            });
        }
        azkarMaxPoints += maxDailyAzkar;
        if (i === 0) azkarPointsSum += calculateTodayAdhkarPoints();
        else azkarPointsSum += adhkarHistory[ds] || 0;
    }

    const dailyPages = appState.quranProgress?.dailyPages || {};
    for (let i = 0; i < days; i++) {
        const d = new Date(today); d.setDate(d.getDate() - i);
        quranTotal += dailyPages[getLocalDateString(d)] || 0;
    }

    const ratios = [
        { name: 'الصلاة', ratio: totalPrayers ? performedPrayers / totalPrayers : 0 },
        { name: 'الأذكار', ratio: azkarMaxPoints ? azkarPointsSum / azkarMaxPoints : 0 },
        { name: 'القرآن', ratio: expectedQuranPages ? quranTotal / expectedQuranPages : 0 }
    ].sort((a, b) => b.ratio - a.ratio);

    return { mostCommitted: ratios[0].name, mostNeglected: ratios[ratios.length - 1].name, ratios };
}

function showCommitmentInfo() {
    showToast('يتم الحساب بناءً على آخر 7 أيام:\n• الصلاة: عدد الصلوات من أصل 35\n• الأذكار: مقارنة بالنقاط الكاملة\n• القرآن: مقارنة بالهدف اليومي');
}

// =========================================================================
//  Auth
// =========================================================================
window.signInWithGoogle = async function () {
    try {
        await auth.signInWithPopup(googleProvider);
    } catch (e) {
        showToast('فشل تسجيل الدخول: ' + e.message, 'error');
    }
};

window.signOut = async function () {
    if (reminderIntervalId) { clearInterval(reminderIntervalId); reminderIntervalId = null; }
    if (dailyResetIntervalId) { clearInterval(dailyResetIntervalId); dailyResetIntervalId = null; }
    pendingSaveCount = 0;
    await auth.signOut();
    appState = null; currentUser = null; userId = null; appInitialized = false;
    showToast('تم تسجيل الخروج');
};

// =========================================================================
//  Login Screen
// =========================================================================
function renderLoginScreen() {
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';

    const content = document.getElementById('content');
    content.textContent = '';                       // clear safely

    // ---- helpers ----
    const el = (tag, attrs, children) => {
        const node = document.createElement(tag);
        if (attrs) Object.entries(attrs).forEach(([k, v]) => {
            if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
            else if (k === 'className') node.className = v;
            else node.setAttribute(k, v);
        });
        if (children) [].concat(children).forEach(c =>
            node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
        return node;
    };

    // ---- feature rows ----
    const features = [
        { icon: '📿', text: 'تتبع الأذكار والصلوات يومياً' },
        { icon: '📖', text: 'مصحف كامل مع تتبع الختمات' },
        { icon: '📈', text: 'تحليلات وإحصائيات لمتابعة تقدمك' }
    ];
    const featureRows = features.map(f => {
        const row = el('div', { className: 'flex items-center gap-3 p-3 rounded-xl', style: { background: 'rgba(200,170,78,0.06)' } });
        row.appendChild(el('span', { className: 'text-2xl' }, f.icon));
        row.appendChild(el('span', { style: { color: 'rgba(242,234,216,0.8)', fontSize: '0.9rem' } }, f.text));
        return row;
    });
    const featureList = el('div', { className: 'space-y-4 mb-8' }, featureRows);

    // ---- Google sign-in button ----
    const googleImg = el('img', { src: 'https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg', width: '22', height: '22', alt: 'Google' });
    const btnLabel = el('span', { className: 'font-bold text-lg' }, 'تسجيل الدخول بـ Google');
    const loginBtn = el('button', {
        id: 'login-btn',
        className: 'w-full py-4 px-6 rounded-xl flex items-center justify-center gap-3 transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]',
        style: { background: 'linear-gradient(135deg,rgba(200,170,78,0.15),rgba(200,170,78,0.08))', border: '2px solid rgba(200,170,78,0.4)', color: '#c9a84c' }
    }, [googleImg, btnLabel]);
    loginBtn.addEventListener('click', signInWithGoogle);

    const privacyNote = el('p', {
        className: 'text-center mt-4',
        style: { color: 'rgba(242,234,216,0.35)', fontSize: '0.8rem' }
    }, 'بياناتك محمية ومشفرة بالكامل 🔒');

    // ---- card ----
    const card = el('div', {
        className: 'card p-8',
        style: { background: 'rgba(15,53,39,0.7)', border: '1px solid rgba(200,170,78,0.2)' }
    }, [featureList, loginBtn, privacyNote]);

    // ---- header ----
    const logoWrap = el('div', { className: 'inline-block mb-6' });
    logoWrap.innerHTML = getLogo('large');           // SVG logo — safe static markup
    const heading = el('h1', {
        className: 'text-5xl font-black mb-3',
        style: { color: '#c9a84c', letterSpacing: '0.05em' }
    }, 'Nafs Tracker');
    const subtitle = el('p', {
        className: 'text-lg',
        style: { color: 'rgba(242,234,216,0.6)' }
    }, 'تتبع عباداتك بسهولة');
    const header = el('div', { className: 'text-center mb-8' }, [logoWrap, heading, subtitle]);

    // ---- assemble ----
    const wrapper = el('div', { className: 'w-full max-w-md' }, [header, card]);
    const outer = el('div', {
        className: 'min-h-screen flex items-center justify-center p-4',
        style: { background: 'linear-gradient(160deg,#071a12 0%,#0d2b1f 35%,#0f3224 60%,#081f16 100%)' }
    }, [wrapper]);

    content.appendChild(outer);

    document.getElementById('mobile-nav').style.display = 'none';
    const _toggleBtnLogin = document.getElementById('nav-toggle-btn');
    if (_toggleBtnLogin) _toggleBtnLogin.style.display = 'none';
}

// =========================================================================
//  Render All Functions
// =========================================================================
// =========================================================================
//  What's New (تحديثات جديدة) — shows once per version
// =========================================================================
const NAFS_APP_VERSION = '2.5.0';

function showWhatsNew() {
    // Only show if user already completed onboarding (not a new user)
    if (!safeLocalStorageGet('nafs_onboarding_v2_done')) return;
    // Only show once per version
    if (safeLocalStorageGet('nafs_whats_new_seen') === NAFS_APP_VERSION) return;

    const updates = [
        { icon: '🌙', title: 'تتبع الصيام', desc: 'شاشة صيام كاملة بتقويم شهري، أيام السنة (إثنين/خميس/أيام بيض)، إحصائيات وسلاسل صيام مع نقاط.' },
        { icon: '🖼️', title: 'مشاركة الإنجاز كصورة', desc: 'شارك تقدمك كصورة جميلة فيها إحصائياتك — الداشبورد فيه زرار "صورة إنجاز" جديد.' },
        { icon: '🌃', title: 'وضع القراءة الليلية', desc: 'الوضع الليلي في المصحف — خلفية سوداء مريحة للعينين أثناء القراءة بالليل.' },
        { icon: '🎨', title: 'ثلاث أوضاع مظهر', desc: 'داكن / فاتح / تلقائي (يتبع نظام جهازك). بدّل من الإعدادات أو زرار الشمس.' },
        { icon: '⚡', title: 'تحسين الأداء والأمان', desc: 'حماية من الطلبات المتكررة للـ API، وقائمة انتظار ذكية للكتابة أثناء انقطاع الإنترنت.' },
        { icon: '♿', title: 'دعم إمكانية الوصول', desc: 'تحسينات لقارئات الشاشة، تنقل بالكيبورد، ورابط تخطي للمحتوى.' },
    ];

    let currentIdx = 0;

    function render() {
        const u = updates[currentIdx];
        const isLast = currentIdx === updates.length - 1;
        const dots = updates.map((_, i) =>
            `<div style="width:${i === currentIdx ? '18px' : '6px'};height:6px;border-radius:3px;background:${i === currentIdx ? '#c9a84c' : i < currentIdx ? 'rgba(200,170,78,0.5)' : 'rgba(200,170,78,0.12)'};transition:all 0.3s"></div>`
        ).join('');

        return `
        <div style="position:fixed;inset:0;z-index:210;background:rgba(0,0,0,0.85);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);display:flex;align-items:center;justify-content:center;padding:1rem;animation:fadeIn 0.3s ease">
            <div style="background:linear-gradient(145deg,#0f2b1e,#081f16);border:1.5px solid rgba(200,170,78,0.25);border-radius:1.25rem;max-width:420px;width:100%;padding:2rem 1.5rem;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.5);position:relative;overflow:hidden">
                <!-- Decorative top glow -->
                <div style="position:absolute;top:-40px;left:50%;transform:translateX(-50%);width:200px;height:80px;background:radial-gradient(ellipse,rgba(200,170,78,0.15),transparent);pointer-events:none"></div>

                <!-- Header badge -->
                <div style="display:inline-flex;align-items:center;gap:0.4rem;background:rgba(200,170,78,0.1);border:1px solid rgba(200,170,78,0.25);border-radius:2rem;padding:0.3rem 1rem;font-size:0.8rem;color:#c9a84c;margin-bottom:1.25rem;font-weight:700">
                    🎉 جديد في v${NAFS_APP_VERSION}
                </div>

                <!-- Counter -->
                <div style="position:absolute;top:1rem;left:1rem;color:rgba(200,170,78,0.4);font-size:0.75rem">${currentIdx + 1}/${updates.length}</div>

                <!-- Content -->
                <div style="font-size:3.5rem;margin-bottom:1rem;animation:slideInUp 0.35s ease">${u.icon}</div>
                <h3 style="font-size:1.35rem;font-weight:800;color:#c9a84c;margin-bottom:0.6rem;animation:slideInUp 0.35s ease 0.05s both">${u.title}</h3>
                <p style="font-size:0.95rem;color:rgba(242,234,216,0.7);line-height:1.7;max-width:340px;margin:0 auto 1.5rem;animation:slideInUp 0.35s ease 0.1s both">${u.desc}</p>

                <!-- Dots -->
                <div style="display:flex;gap:4px;justify-content:center;margin-bottom:1.25rem">${dots}</div>

                <!-- Buttons -->
                <div style="display:flex;gap:0.6rem;justify-content:center;animation:slideInUp 0.35s ease 0.15s both">
                    ${currentIdx > 0 ? `<button onclick="window._whatsNewPrev()" style="padding:0.6rem 1.2rem;border-radius:0.8rem;background:transparent;border:1px solid rgba(200,170,78,0.2);color:rgba(242,234,216,0.5);font-size:0.9rem;cursor:pointer;transition:all 0.2s">→ السابق</button>` : ''}
                    ${isLast ? `
                        <button onclick="window._whatsNewClose()" style="padding:0.7rem 2rem;border-radius:0.8rem;background:linear-gradient(135deg,rgba(200,170,78,0.25),rgba(200,170,78,0.1));border:1px solid rgba(200,170,78,0.5);color:#c9a84c;font-size:1rem;font-weight:800;cursor:pointer;min-width:180px;transition:all 0.2s">✨ يلا نبدأ!</button>
                    ` : `
                        <button onclick="window._whatsNewNext()" style="padding:0.6rem 1.8rem;border-radius:0.8rem;background:linear-gradient(135deg,rgba(200,170,78,0.2),rgba(200,170,78,0.08));border:1px solid rgba(200,170,78,0.4);color:#c9a84c;font-size:0.95rem;font-weight:700;cursor:pointer;transition:all 0.2s">التالي ←</button>
                    `}
                </div>
            </div>
        </div>`;
    }

    window._whatsNewNext = () => {
        if (currentIdx < updates.length - 1) {
            currentIdx++;
            document.getElementById('whats-new-container').innerHTML = render();
        }
    };

    window._whatsNewPrev = () => {
        if (currentIdx > 0) {
            currentIdx--;
            document.getElementById('whats-new-container').innerHTML = render();
        }
    };

    window._whatsNewClose = () => {
        safeLocalStorageSet('nafs_whats_new_seen', NAFS_APP_VERSION);
        const c = document.getElementById('whats-new-container');
        if (c) {
            c.style.opacity = '0';
            c.style.transition = 'opacity 0.3s ease';
            setTimeout(() => c.remove(), 300);
        }
    };

    // Swipe support
    let sx = 0;
    const container = document.createElement('div');
    container.id = 'whats-new-container';
    container.innerHTML = render();
    container.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
    container.addEventListener('touchend', e => {
        const diff = sx - e.changedTouches[0].clientX;
        if (Math.abs(diff) > 50) {
            if (diff > 0 && currentIdx < updates.length - 1) window._whatsNewNext();
            else if (diff < 0 && currentIdx > 0) window._whatsNewPrev();
        }
    }, { passive: true });
    document.body.appendChild(container);
}

// =========================================================================
//  Onboarding (3-screen intro for new users)
// =========================================================================
function showOnboarding() {
    const tourSteps = [
        { icon: '🕌', title: 'مرحباً بك في Nafs Tracker', desc: 'تطبيقك الشامل لمتابعة عباداتك اليومية من أذكار وصلاة وقرآن والمزيد', screen: null },
        { icon: '📿', title: 'أذكار الصباح والمساء', desc: 'أذكار مصنفة مع عداد تلقائي ونقاط لكل ذكر – قم بتحريك شريط التقدم لإكمال الورد', screen: 'adhkar' },
        { icon: '🕐', title: 'مواقيت الصلاة', desc: 'مواقيت دقيقة حسب موقعك مع تنبيهات وتتبع للصلوات اليومية', screen: 'prayer' },
        { icon: '📖', title: 'المصحف والقرآن', desc: 'قراءة المصحف والاستماع لأشهر القراء مع تتبع الصفحات والختمات', screen: 'quran' },
        { icon: '🧿', title: 'السبحة الإلكترونية', desc: 'تسبيح إلكتروني مع أذكار متنوعة وإمكانية إضافة أذكار خاصة بك', screen: 'tasbih' },
        { icon: '📜', title: 'حديث اليومي وأدعية', desc: 'حديث يومي متجدد وأدعية مصنفة لكل مناسبة من القرآن والسنة', screen: 'hadith' },
        { icon: '🧭', title: 'القبلة وأسماء الله', desc: 'بوصلة القبلة الذكية و99 اسماً من أسماء الله الحسنى مع معانيها', screen: 'qibla' },
        { icon: '🏆', title: 'الشارات والمكافآت', desc: 'اكسب النقاط والشارات، حافظ على سلسلة المواظبة، وتابع إحصائياتك', screen: 'rewards' },
        { icon: '🚀', title: 'أنت جاهز!', desc: 'ابدأ رحلتك الآن وحافظ على عباداتك اليومية – بارك الله فيك', screen: null }
    ];
    let currentSlide = 0;

    function renderSlide() {
        const s = tourSteps[currentSlide];
        const dots = tourSteps.map((_, i) =>
            `<div style="width:${i === currentSlide ? '20px' : '6px'};height:6px;border-radius:3px;background:${i === currentSlide ? 'var(--accent-gold)' : i < currentSlide ? 'rgba(200,170,78,0.5)' : 'rgba(200,170,78,0.15)'};transition:all 0.3s"></div>`
        ).join('');

        const isFirst = currentSlide === 0;
        const isLast = currentSlide === tourSteps.length - 1;
        const progress = Math.round((currentSlide / (tourSteps.length - 1)) * 100);

        return `
        <div style="position:fixed;inset:0;z-index:200;background:var(--bg-primary);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:1.5rem;overflow:hidden">
            <!-- Progress bar -->
            <div style="position:absolute;top:0;left:0;right:0;height:3px;background:rgba(200,170,78,0.1)">
                <div style="height:100%;width:${progress}%;background:var(--accent-gold);transition:width 0.4s ease;border-radius:0 2px 2px 0"></div>
            </div>
            <!-- Step counter -->
            <div style="position:absolute;top:1rem;left:1rem;color:var(--text-muted);font-size:0.85rem">${currentSlide + 1} / ${tourSteps.length}</div>
            <!-- Skip button -->
            ${!isLast ? `<button onclick="window._onboardingSkip()" style="position:absolute;top:1rem;right:1rem;color:var(--text-muted);background:none;border:none;font-size:0.9rem;cursor:pointer;padding:0.5rem">تخطي</button>` : ''}
            
            <div style="font-size:4.5rem;margin-bottom:1.5rem;animation:slideInUp 0.4s ease">${s.icon}</div>
            <h2 style="font-size:1.6rem;font-weight:800;color:var(--accent-gold);margin-bottom:0.8rem;animation:slideInUp 0.4s ease 0.1s both">${s.title}</h2>
            <p style="font-size:1rem;color:var(--text-secondary);max-width:320px;line-height:1.7;margin-bottom:2rem;animation:slideInUp 0.4s ease 0.15s both">${s.desc}</p>
            <div style="display:flex;gap:4px;margin-bottom:1.5rem;flex-wrap:wrap;justify-content:center">${dots}</div>
            <div style="display:flex;gap:0.75rem;animation:slideInUp 0.4s ease 0.2s both">
                ${!isFirst && !isLast ? `<button onclick="window._onboardingPrev()" style="padding:0.7rem 1.5rem;border-radius:1rem;background:transparent;border:1px solid rgba(200,170,78,0.25);color:var(--text-muted);font-size:0.95rem;cursor:pointer">→ السابق</button>` : ''}
                ${isLast ? `
                    <button onclick="window._onboardingSkip()" style="padding:0.8rem 2.5rem;border-radius:1rem;background:linear-gradient(135deg,rgba(200,170,78,0.25),rgba(200,170,78,0.1));border:1px solid var(--accent-gold);color:var(--accent-gold);font-size:1.1rem;font-weight:800;cursor:pointer;min-width:200px">🚀 ابدأ الآن</button>
                ` : `
                    <button onclick="window._onboardingNext()" style="padding:0.7rem 2rem;border-radius:1rem;background:linear-gradient(135deg,rgba(200,170,78,0.2),rgba(200,170,78,0.1));border:1px solid rgba(200,170,78,0.5);color:var(--accent-gold);font-size:0.95rem;font-weight:700;cursor:pointer">التالي ←</button>
                `}
            </div>
        </div>`;
    }

    window._onboardingNext = () => {
        if (currentSlide < tourSteps.length - 1) {
            currentSlide++;
            document.getElementById('onboarding-container').innerHTML = renderSlide();
        }
    };

    window._onboardingPrev = () => {
        if (currentSlide > 0) {
            currentSlide--;
            document.getElementById('onboarding-container').innerHTML = renderSlide();
        }
    };

    window._onboardingSkip = () => {
        safeLocalStorageSet('nafs_onboarding_v2_done', 'true');
        const container = document.getElementById('onboarding-container');
        if (container) {
            container.style.opacity = '0';
            container.style.transition = 'opacity 0.3s ease';
            setTimeout(() => container.remove(), 300);
        }
    };

    // Swipe support
    let touchStartX = 0;
    const handleTouchStart = (e) => { touchStartX = e.touches[0].clientX; };
    const handleTouchEnd = (e) => {
        const diff = touchStartX - e.changedTouches[0].clientX;
        if (Math.abs(diff) > 50) {
            if (diff > 0 && currentSlide < tourSteps.length - 1) window._onboardingNext();
            else if (diff < 0 && currentSlide > 0) window._onboardingPrev();
        }
    };

    const container = document.createElement('div');
    container.id = 'onboarding-container';
    container.innerHTML = renderSlide();
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchend', handleTouchEnd, { passive: true });
    document.body.appendChild(container);
}

function renderMainApp() {
    if (appInitialized) return;
    appInitialized = true;

    loadSavedTheme();

    const logoHtml = getLogo('small');

    const header = `
        <header style="background:rgba(8,31,22,0.97);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-bottom:1px solid rgba(200,170,78,0.15)">
            <div style="max-width:1400px;margin:0 auto;padding:0.75rem 1rem">
                <div class="flex items-center justify-between gap-3">
                    <div class="flex items-center gap-3 cursor-pointer min-w-0" onclick="showScreen('dashboard')">
                        ${logoHtml}
                        <div class="min-w-0">
                            <h1 class="text-2xl font-black leading-none" style="color:#c9a84c">Nafs Tracker</h1>
                            <p class="text-sm truncate" style="color:rgba(242,234,216,0.55)">مرحباً، <span id="header-user-name">${escapeHtml(appState.preferredName || currentUser?.displayName || 'مستخدم')}</span></p>
                        </div>
                    </div>
                    <div class="flex items-center gap-2 flex-shrink-0">
                        <div style="background:rgba(200,170,78,0.1);border:1px solid rgba(200,170,78,0.35)" class="px-3 py-1.5 rounded-full flex items-center gap-2">
                            <i class="fas fa-fire text-base" style="color:#c9a84c"></i>
                            <span id="streakDisplay" class="font-bold text-lg" style="color:#c9a84c">${appState.streak}</span>
                            <span class="text-xs hidden sm:inline" style="color:rgba(242,234,216,0.5)">يوم</span>
                        </div>
                        <button onclick="toggleTheme()" class="bg-white/10 hover:bg-white/20 p-2.5 rounded-full transition" title="وضع ليلي/نهاري">
                            <i id="theme-icon" class="fas fa-sun" style="color:#c9a84c"></i>
                        </button>
                        <button onclick="signOut()" class="bg-white/10 hover:bg-white/20 p-2.5 rounded-full transition hidden sm:flex" title="تسجيل الخروج">
                            <i class="fas fa-sign-out-alt" style="color:#c9a84c"></i>
                        </button>
                    </div>
                </div>
            </div>
        </header>`;

    const sidebar = `
        <aside class="desktop-sidebar">
            <nav class="sticky top-20 space-y-1">
                ${[
            ['dashboard', '🏠', 'الرئيسية'], ['adhkar', '📿', 'الأذكار'], ['prayer', '🕌', 'الصلاة'],
            ['mushaf', '📖', 'المصحف'], ['quran', '📊', 'تتبع القرآن'], ['tasbih', '🧿', 'السبحة'], ['hadith', '📜', 'حديث اليوم'],
            ['qibla', '🧭', 'القبلة'], ['names99', '✨', 'أسماء الله'], ['dua', '🤲', 'أدعية'], ['analysis', '📈', 'التحليل'], ['podcasts', '🎙️', 'البودكاستات'],
            ['journal', '📔', 'يومياتي'], ['rewards', '🏆', 'المكافآت'], ['reminders', '⏰', 'التذكيرات'],
            ['zakat', '💰', 'الزكاة'], ['adhan', '🔔', 'الأذان'], ['fasting', '🌙', 'الصيام'], ['settings', '⚙️', 'الإعدادات']
        ].map(([id, icon, label]) => `
                    <button onclick="showScreen('${id}')" id="nav-${id}" class="nav-link">
                        <span>${icon}</span><span class="font-semibold">${label}</span>
                    </button>`).join('')}
            </nav>
        </aside>`;

    const screens = `
        <main class="flex-1 min-w-0">
            ${['dashboard', 'adhkar', 'prayer', 'mushaf', 'quran', 'analysis', 'podcasts', 'journal', 'rewards', 'reminders', 'zakat', 'adhan', 'settings', 'tasbih', 'qibla', 'names99', 'hadith', 'dua', 'privacy', 'fasting']
            .map(id => `<div id="screen-${id}" class="screen hidden space-y-5"></div>`).join('')}
        </main>`;

    document.getElementById('content').innerHTML =
        header + `<div class="main-layout"><div class="flex gap-6 w-full">${sidebar}${screens}</div></div>`;

    document.getElementById('mobile-nav').style.display = 'flex';
    const _toggleBtn = document.getElementById('nav-toggle-btn');
    if (_toggleBtn) { _toggleBtn.style.display = 'block'; _toggleBtn.style.bottom = '70px'; _toggleBtn.querySelector('i').className = 'fas fa-chevron-down'; }
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';

    window.showScreen = function (screenId) {
        document.querySelectorAll('.screen').forEach(el => el.classList.add('hidden'));
        const screenEl = document.getElementById(`screen-${screenId}`);
        if (screenEl) screenEl.classList.remove('hidden');

        document.querySelectorAll('.nav-link').forEach(btn => btn.classList.remove('active'));
        const navBtn = document.getElementById(`nav-${screenId}`);
        if (navBtn) navBtn.classList.add('active');

        document.querySelectorAll('.mobile-nav-btn').forEach(b => b.classList.remove('active'));
        const mnavBtn = document.getElementById(`mnav-${screenId}`);
        if (mnavBtn) mnavBtn.classList.add('active');

        // Save last screen for "continue where you left off"
        safeLocalStorageSet('nafs_last_screen', screenId);

        window.scrollTo({ top: 0, behavior: 'smooth' });

        destroyCharts();

        const renders = {
            dashboard: renderDashboard, adhkar: renderAdhkar, prayer: renderPrayer,
            mushaf: renderMushaf, quran: renderQuran, zakat: renderZakat, adhan: renderAdhan, analysis: renderAnalysis, podcasts: renderPodcasts,
            journal: renderJournal, rewards: renderRewards, reminders: renderReminders,
            settings: renderSettings, tasbih: renderTasbih, qibla: renderQibla, names99: renderNames99, hadith: renderHadith, dua: renderDua, privacy: renderPrivacy,
            fasting: renderFasting
        };
        // Error boundary: wrap each render in try/catch with recovery options
        if (renders[screenId]) {
            try {
                renders[screenId]();
            } catch (e) {
                console.error(`Error rendering ${screenId}:`, e);
                const el = document.getElementById(`screen-${screenId}`);
                if (el) el.innerHTML = `<div class="card p-5 text-center">
                    <p class="text-4xl mb-3">⚠️</p>
                    <p class="text-red-400 text-lg mb-2">حدث خطأ في تحميل هذه الشاشة</p>
                    <p class="text-white/40 text-xs mb-4 font-mono" dir="ltr">${escapeHtml(e.message)}</p>
                    <div class="flex items-center justify-center gap-3">
                        <button onclick="showScreen('${screenId}')" class="btn-primary px-5 py-2 rounded-xl">
                            <i class="fas fa-redo me-1"></i>إعادة المحاولة
                        </button>
                        <button onclick="showScreen('dashboard')" class="bg-white/10 border border-white/20 text-white/70 px-5 py-2 rounded-xl">
                            <i class="fas fa-home me-1"></i>الرئيسية
                        </button>
                    </div>
                </div>`;
            }
        }
    };

    showScreen('dashboard');
    checkAndResetDailyProgress();
    startDailyResetChecker();
    if (!appState.preferredName) {
        setTimeout(() => {
            if (!appState.preferredName) openModal('preferred-name-modal');
        }, 500);
    }
    startReminderChecker();
    initBackToTop();
    requestNotificationPermission();
    restoreEmergencyState();
}

const chartInstances = {};
function destroyCharts() {
    Object.keys(chartInstances).forEach(key => {
        try { chartInstances[key].destroy(); } catch (e) { }
        delete chartInstances[key];
    });
    // Clean up Qibla compass listeners when navigating away
    if (typeof destroyQibla === 'function') destroyQibla();
}

// =========================================================================
//  Dashboard
// =========================================================================
function renderDashboard() {
    const level = appState.level || 1;
    const pointsInLevel = (appState.totalPoints || 0) % 100;
    const nextLevelPoints = 100 - pointsInLevel;
    const treeProgress = pointsInLevel;

    let nextBadge;
    if (appState.streak < 7) nextBadge = `🌱 ${appState.streak}/7 أيام`;
    else if (appState.streak < 30) nextBadge = `🌿 ${appState.streak}/30 يوم`;
    else if (appState.streak < 90) nextBadge = `🌳 ${appState.streak}/90 يوم`;
    else if (appState.streak < 365) nextBadge = `🏔️ ${appState.streak}/365 يوم`;
    else nextBadge = `🏆 ${appState.streak} يوم - أسطوري!`;

    const stats = calculateCommitmentStats();

    const todayStr = new Date().toDateString();
    const stored = safeLocalStorageGet('dailyChallenge');
    const parsed = safeJsonParse(stored);
    if (parsed && parsed.date === todayStr) {
        dailyChallenge = parsed;
    } else {
        const challenges = ['أكمل أذكار الصباح كاملة', 'صلِّ الفجر في وقتها', 'اقرأ 3 صفحات من القرآن',
            'صلِّ سنة الضحى', 'اقرأ دعاء السفر', 'استغفر 100 مرة', 'صلِّ على النبي 100 مرة', 'تصدق ولو بالقليل'];
        dailyChallenge = { text: challenges[Math.floor(Math.random() * challenges.length)], date: todayStr };
        safeLocalStorageSet('dailyChallenge', JSON.stringify(dailyChallenge));
    }

    const treeEmoji = pointsInLevel === 0 && appState.totalPoints > 0 ? '🏆' :
        treeProgress < 25 ? '🌱' : treeProgress < 50 ? '🌿' : treeProgress < 75 ? '🌳' : '🏆';

    // Daily challenge completion tracking
    const challengeCompletedKey = 'dailyChallengeCompleted_' + new Date().toDateString();
    const isChallengeCompleted = safeLocalStorageGet(challengeCompletedKey) === 'true';

    // Continue where you left off
    const lastScreen = safeLocalStorageGet('nafs_last_screen');
    const lastScreenName = { adhkar: 'الأذكار', prayer: 'الصلاة', quran: 'القرآن', mushaf: 'المصحف', analysis: 'التحليل', journal: 'يومياتي', tasbih: 'السبحة', hadith: 'حديث اليوم', names99: 'أسماء الله', dua: 'الأدعية', qibla: 'القبلة' }[lastScreen];

    // Hijri date
    const hijriDate = getHijriDate();

    document.getElementById('screen-dashboard').innerHTML = `
        ${getRamadanBanner()}

        ${lastScreenName && lastScreen !== 'dashboard' ? `<div class="card p-3 mb-4 flex items-center justify-between border border-gold/20 cursor-pointer hover:bg-white/5 transition" onclick="showScreen('${lastScreen}')">
            <div class="flex items-center gap-2"><i class="fas fa-arrow-right text-gold"></i><span class="text-sm text-[var(--text-primary)]">أكمل من حيث توقفت: <strong class="text-gold">${lastScreenName}</strong></span></div>
            <i class="fas fa-chevron-left text-gold/50"></i>
        </div>` : ''}

        ${hijriDate ? `<div class="text-center mb-3"><span class="text-sm text-gold/70 font-arabic">${hijriDate}</span></div>` : ''}

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div class="card p-5 glass-card">
                <div class="flex items-center gap-3 mb-2"><span class="text-3xl">🔥</span><h3 class="text-lg font-bold text-gold">أيام متتالية</h3></div>
                <p class="text-4xl font-black text-gold mb-1">${appState.streak}</p>
                <p class="text-sm text-[var(--text-muted)]">أفضل سلسلة: ${appState.longestStreak}</p>
            </div>
            <div class="card p-5 glass-card">
                <div class="flex items-center gap-3 mb-2"><span class="text-3xl">⭐</span><h3 class="text-lg font-bold text-gold">نقاط الإنجاز</h3></div>
                <p id="total-points-display" class="text-4xl font-black text-gold mb-1">${appState.totalPoints}</p>
                <p class="text-sm text-[var(--text-muted)]">المستوى ${level}</p>
            </div>
            <div class="card p-5 glass-card">
                <div class="flex items-center gap-3 mb-2"><span class="text-3xl">📖</span><h3 class="text-lg font-bold text-gold">قراءة اليوم</h3></div>
                <p class="text-4xl font-black text-gold mb-1">${appState.quranProgress?.dailyPages?.[getLocalDateString()] || 0}</p>
                <p class="text-sm text-[var(--text-muted)]">صفحات</p>
            </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div class="card p-5 border-blue-500/30">
                <div class="flex items-center gap-3 mb-2"><span class="text-3xl">🎯</span><h3 class="text-lg font-bold text-blue-400">التحدي اليومي</h3></div>
                <p class="text-lg font-bold text-[var(--text-primary)]">${escapeHtml(dailyChallenge.text)}</p>
                ${isChallengeCompleted
            ? '<p class="text-sm text-green-400 mt-2"><i class="fas fa-check-circle"></i> تم الإكمال ✅ +10 نقاط</p>'
            : `<button onclick="completeDailyChallenge()" class="mt-2 w-full bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/40 text-blue-400 font-bold py-2 rounded-xl text-sm transition ripple-btn">أكملت التحدي (+10 نقاط)</button>`}
            </div>
            <div class="card p-5 border-green-500/30">
                <div class="flex items-center gap-3 mb-2"><span class="text-3xl">☪️</span><h3 class="text-lg font-bold text-green-400">الأذكار</h3></div>
                <p class="text-3xl font-bold text-green-400"><span id="adhkar-points-today">${calculateTodayAdhkarPoints()}</span> نقطة</p>
                <p class="text-sm text-[var(--text-muted)] mt-1">اليوم</p>
            </div>
            <div class="card p-5 border-yellow-500/30">
                <div class="flex items-center gap-3 mb-2"><span class="text-3xl">📕</span><h3 class="text-lg font-bold text-yellow-400">الختمات</h3></div>
                <p class="text-3xl font-bold text-yellow-400">${appState.quranProgress?.totalKhatma || 0}</p>
                <p class="text-sm text-[var(--text-muted)] mt-1">اكتملت</p>
            </div>
        </div>

        <!-- Dashboard Shortcuts -->
        <div class="card p-4">
            <h3 class="font-bold text-sm mb-3 text-gold"><i class="fas fa-bolt me-1"></i>اختصارات سريعة</h3>
            <div class="grid grid-cols-4 sm:grid-cols-6 gap-2">
                <button onclick="showScreen('adhkar')" class="shortcut-btn"><span class="text-xl">📿</span><span class="text-xs mt-1">الأذكار</span></button>
                <button onclick="showScreen('tasbih')" class="shortcut-btn"><span class="text-xl">🧿</span><span class="text-xs mt-1">السبحة</span></button>
                <button onclick="showScreen('mushaf')" class="shortcut-btn"><span class="text-xl">📖</span><span class="text-xs mt-1">المصحف</span></button>
                <button onclick="showScreen('prayer')" class="shortcut-btn"><span class="text-xl">🕌</span><span class="text-xs mt-1">الصلاة</span></button>
                <button onclick="showScreen('hadith')" class="shortcut-btn"><span class="text-xl">📜</span><span class="text-xs mt-1">حديث</span></button>
                <button onclick="showScreen('dua')" class="shortcut-btn"><span class="text-xl">🤲</span><span class="text-xs mt-1">أدعية</span></button>
                <button onclick="showScreen('qibla')" class="shortcut-btn"><span class="text-xl">🧭</span><span class="text-xs mt-1">القبلة</span></button>
                <button onclick="showScreen('names99')" class="shortcut-btn"><span class="text-xl">✨</span><span class="text-xs mt-1">الأسماء</span></button>
            </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="card p-5">
                <h3 class="font-bold text-lg mb-3 text-gold"><i class="fas fa-tree me-2"></i>شجرة التقدم</h3>
                <div class="flex items-center gap-4">
                    <div class="text-5xl">${treeEmoji}</div>
                    <div class="flex-1 min-w-0">
                        <div class="flex justify-between mb-1 text-sm"><span>المستوى ${level}</span><span>${Math.round(treeProgress)}%</span></div>
                        <div class="progress-bar"><div class="progress-fill" style="width:${treeProgress}%"></div></div>
                        <p class="text-xs text-[var(--text-muted)] mt-1">${nextLevelPoints} نقطة للمستوى التالي</p>
                    </div>
                </div>
            </div>
            <div class="card p-5">
                <h3 class="font-bold text-lg mb-3 text-gold"><i class="fas fa-medal me-2"></i>التقدم للوسام</h3>
                <p class="text-2xl font-bold text-[var(--text-primary)]">${nextBadge}</p>
            </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="card p-5 bg-gradient-islamic border-2 border-gold/40">
                <div class="flex items-center gap-3">
                    <span class="text-4xl">✅</span>
                    <div>
                        <div class="flex items-center gap-2">
                            <h3 class="text-base font-bold text-gold">أكثر عبادة التزاماً</h3>
                            <button class="info-btn" onclick="showCommitmentInfo()" aria-label="معلومات الحساب">ⓘ</button>
                        </div>
                        <p class="text-3xl font-bold text-[var(--text-primary)] mt-1">${stats.mostCommitted}</p>
                    </div>
                </div>
            </div>
            <div class="card p-5 bg-gradient-islamic border-2 border-gold/40">
                <div class="flex items-center gap-3">
                    <span class="text-4xl">⚠️</span>
                    <div>
                        <div class="flex items-center gap-2">
                            <h3 class="text-base font-bold text-gold">أكثر عبادة تقصيراً</h3>
                            <button class="info-btn" onclick="showCommitmentInfo()" aria-label="معلومات الحساب">ⓘ</button>
                        </div>
                        <p class="text-3xl font-bold text-[var(--text-primary)] mt-1">${stats.mostNeglected}</p>
                    </div>
                </div>
            </div>
        </div>

        ${renderActivityHeatmap()}

        <div class="islamic-divider"></div>
        <div class="card p-6 text-center bg-gradient-to-br from-[var(--accent-gold)]/10 to-transparent border-2 border-gold/30">
            <p class="text-2xl font-arabic text-[var(--text-primary)] leading-relaxed">${getSeasonalHadith()}</p>
        </div>
        <div class="grid grid-cols-3 gap-3">
            <button onclick="activateEmergency()" class="bg-gradient-islamic border-2 border-gold text-gold font-bold py-4 rounded-2xl text-base transition-all shadow-lg ripple-btn">
                <span class="text-xl ms-1">🧘</span> لحظة تأمل
            </button>
            <button onclick="shareAppAchievement()" class="bg-gradient-islamic border-2 border-gold/50 text-gold font-bold py-4 rounded-2xl text-base transition-all shadow-lg ripple-btn">
                <span class="text-xl ms-1">📤</span> شارك إنجازك
            </button>
            <button onclick="shareProgressAsImage()" class="bg-gradient-islamic border-2 border-gold/50 text-gold font-bold py-4 rounded-2xl text-base transition-all shadow-lg ripple-btn">
                <span class="text-xl ms-1">🖼️</span> صورة إنجاز
            </button>
        </div>`;
}

function getSeasonalHadith() {
    const month = new Date().getMonth();
    if (month === 2 || month === 1) return '﴿شَهۡرُ رَمَضَانَ ٱلَّذِيٓ أُنزِلَ فِيهِ ٱلۡقُرۡءَانُ هُدٗى لِّلنَّاسِ وَبَيِّنَٰتٖ مِّنَ ٱلۡهُدَىٰ وَٱلۡفُرۡقَانِ﴾ — البقرة: 185';
    if (month === 5 || month === 6) return '"أفضل أيام الدنيا أيام العشر" – عشر ذي الحجة';
    if (month === 0) return '"إنَما الأعمالُ بالنياتِ" – متفق عليه';
    return '"وَذَكِّرۡ فَإِنَّ ٱلذِّكۡرَىٰ تَنفَعُ ٱلۡمُؤۡمِنِينَ"';
}

// =========================================================================
//  Daily Challenge Completion
// =========================================================================
window.completeDailyChallenge = async function () {
    const challengeCompletedKey = 'dailyChallengeCompleted_' + new Date().toDateString();
    if (safeLocalStorageGet(challengeCompletedKey) === 'true') {
        showToast('لقد أكملت تحدي اليوم بالفعل!', 'info');
        return;
    }
    safeLocalStorageSet(challengeCompletedKey, 'true');
    const bonus = isRamadan() ? 20 : 10; // Double points in Ramadan
    appState.totalPoints = (appState.totalPoints || 0) + bonus;
    appState.level = Math.floor(appState.totalPoints / 100) + 1;
    await saveUserField('totalPoints', appState.totalPoints);
    await saveUserField('level', appState.level);
    await updateStreak(true);
    showToast(`🎯 أحسنت! أكملت التحدي اليومي +${bonus} نقاط${isRamadan() ? ' (مضاعفة رمضان!)' : ''}`, 'success');
    triggerConfetti();
    refreshDashboard();
};

// =========================================================================
//  Hijri Date Helper
// =========================================================================
function getHijriDate() {
    try {
        const formatter = new Intl.DateTimeFormat('ar-SA-u-ca-islamic', {
            day: 'numeric', month: 'long', year: 'numeric'
        });
        return formatter.format(new Date());
    } catch { return ''; }
}

// =========================================================================
//  Web Share API
// =========================================================================
window.shareAppAchievement = async function () {
    const text = `🌙 Nafs Tracker\n🔥 سلسلة ${appState.streak} يوم\n⭐ ${appState.totalPoints} نقطة\n📖 المستوى ${appState.level}\nتتبع عباداتك يومياً مع Nafs Tracker`;
    if (navigator.share) {
        try {
            await navigator.share({ title: 'Nafs Tracker - إنجازاتي', text });
        } catch (e) { if (e.name !== 'AbortError') showToast('تعذر المشاركة', 'error'); }
    } else {
        try {
            await navigator.clipboard.writeText(text);
            showToast('تم نسخ الإنجاز للمشاركة 📋');
        } catch { showToast('تعذر النسخ', 'error'); }
    }
};

// =========================================================================
//  Export / Import Data
// =========================================================================
window.exportUserData = function () {
    if (!appState) return;
    const data = JSON.stringify(appState, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nafs-tracker-backup-${getLocalDateString()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('تم تصدير البيانات بنجاح 📁');
};

window.importUserData = function () {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (!data.editedAzkar && !data.totalPoints) {
                showToast('ملف غير صالح', 'error');
                return;
            }
            showConfirm('هل تريد استبدال بياناتك الحالية ببيانات النسخة الاحتياطية؟', async () => {
                Object.assign(appState, data);
                await db.collection('users').doc(userId).set(appState);
                showToast('تم استيراد البيانات بنجاح! سيتم إعادة التحميل...');
                setTimeout(() => location.reload(), 1500);
            });
        } catch { showToast('خطأ في قراءة الملف', 'error'); }
    };
    input.click();
};

// =========================================================================
//  Confetti Animation
// =========================================================================
function triggerConfetti() {
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999;overflow:hidden;';
    document.body.appendChild(container);
    const colors = ['#c9a84c', '#4ade80', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa'];
    for (let i = 0; i < 60; i++) {
        const confetti = document.createElement('div');
        confetti.style.cssText = `position:absolute;width:${6 + Math.random() * 8}px;height:${6 + Math.random() * 8}px;background:${colors[Math.floor(Math.random() * colors.length)]};left:${Math.random() * 100}%;top:-10px;border-radius:${Math.random() > 0.5 ? '50%' : '2px'};opacity:0.9;animation:confettiFall ${2 + Math.random() * 2}s ease-out forwards;animation-delay:${Math.random() * 0.5}s;`;
        container.appendChild(confetti);
    }
    setTimeout(() => container.remove(), 4000);
}

// =========================================================================
//  الأذكار - Abbreviated
// =========================================================================
async function renderAdhkar() {
    document.getElementById('screen-adhkar').innerHTML = `
        <div class="card p-5">
            <div class="flex items-center gap-3 mb-3"><span class="text-3xl">📿</span><h2 class="text-2xl font-bold text-gold">الأذكار اليومية</h2></div>
            <div class="mb-4">
                <input type="text" id="adhkar-search" placeholder="🔍 بحث في الأذكار..." class="w-full" oninput="filterAdhkar(this.value)">
            </div>
            <div class="flex border-b border-gold/20 gap-2 mb-5 overflow-x-auto pb-2" id="adhkar-tabs">
                ${['morning', 'evening', 'night', 'afterprayer', 'custom'].map(tab => `
                    <button onclick="showAdhkarTab('${tab}')" id="tab-${tab}"
                        class="adhkar-tab ${tab === activeAdhkarTab ? 'tab-active' : ''}">
                        ${{ morning: 'الصباح', evening: 'المساء', night: 'النوم', afterprayer: 'بعد الصلاة', custom: 'أذكاري' }[tab]}
                    </button>`).join('')}
            </div>
            <div id="adhkar-content" class="space-y-5"></div>
            <button onclick="openModal('add-dhikr-modal')" class="mt-5 w-full bg-white/10 hover:bg-white/20 border border-dashed border-gold/50 rounded-xl py-3 text-white/80 transition ripple-btn">
                <i class="fas fa-plus me-2"></i> إضافة ذكر مخصص
            </button>
        </div>`;
    showAdhkarTab(activeAdhkarTab);
}

window.filterAdhkar = function (query) {
    if (!query || !query.trim()) {
        showAdhkarTab(activeAdhkarTab);
        return;
    }
    const q = query.trim().toLowerCase();
    const allDhikr = [
        ...(appState.editedAzkar?.morning || []).map(d => ({ ...d, _cat: 'morning' })),
        ...(appState.editedAzkar?.evening || []).map(d => ({ ...d, _cat: 'evening' })),
        ...(appState.editedAzkar?.night || []).map(d => ({ ...d, _cat: 'night' })),
        ...(appState.editedAzkar?.afterprayer || []).map(d => ({ ...d, _cat: 'afterprayer' })),
        ...(appState.customAdhkar || []).map(d => ({ ...d, _cat: 'custom' }))
    ];
    const filtered = allDhikr.filter(d => d.text.toLowerCase().includes(q) || (d.virtue && d.virtue.toLowerCase().includes(q)));
    const container = document.getElementById('adhkar-content');
    if (!container) return;
    if (filtered.length === 0) {
        container.innerHTML = '<p class="text-center text-white/40 py-6">لا توجد نتائج</p>';
        return;
    }
    const catNames = { morning: 'الصباح', evening: 'المساء', night: 'النوم', afterprayer: 'بعد الصلاة', custom: 'أذكاري' };
    container.innerHTML = filtered.map(d => {
        const progress = appState.adhkarProgress?.[d.id] || 0;
        const total = d.count || 1;
        const pct = Math.min(100, Math.round((progress / total) * 100));
        const done = progress >= total;
        const perRep = getDhikrPointsPerRep(d);
        const earnedPts = Math.round(perRep * progress * 10) / 10;
        const R = 38, C = 2 * Math.PI * R;
        const offset = C - (pct / 100) * C;
        return `<div class="dhikr-card ${done ? 'dhikr-completed' : ''}">
            <div class="flex justify-between items-start mb-2">
                <span class="text-xs bg-gold/10 text-gold px-2 py-0.5 rounded-full">${catNames[d._cat]}</span>
                <span class="text-xs text-gold/60">⭐ ${earnedPts}</span>
            </div>
            <p class="font-arabic text-lg leading-relaxed mb-2">${escapeHtml(d.text).replace(/\n/g, '<br>')}</p>
            ${d.virtue ? `<p class="text-xs text-gold/70 mb-2">💡 ${escapeHtml(d.virtue)}</p>` : ''}
            <div class="dhikr-counter-area dhikr-counter-compact">
                <div class="dhikr-ring-btn dhikr-ring-static ${done ? 'dhikr-ring-done' : ''}" aria-label="${done ? 'مكتمل' : pct + '%'}">
                    <svg class="dhikr-ring-svg" viewBox="0 0 88 88" aria-hidden="true">
                        <circle class="dhikr-ring-bg" cx="44" cy="44" r="${R}" />
                        <circle class="dhikr-ring-fill ${done ? 'dhikr-ring-fill-done' : ''}" cx="44" cy="44" r="${R}" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" />
                    </svg>
                    <span class="dhikr-ring-label">${done ? '<i class="fas fa-check"></i>' : `<span class="dhikr-ring-count">${progress}</span>`}</span>
                </div>
                <div class="dhikr-info-col">
                    <span class="dhikr-fraction">${progress}<span class="dhikr-fraction-sep">/</span>${total}</span>
                    <span class="dhikr-pct">${done ? 'مكتمل ✅' : pct + '%'}</span>
                </div>
            </div>
        </div>`;
    }).join('');
};

window.showAdhkarTab = function (tab) {
    activeAdhkarTab = tab;
    document.querySelectorAll('.adhkar-tab').forEach(btn => btn.classList.remove('tab-active'));
    const activeBtn = document.getElementById(`tab-${tab}`);
    if (activeBtn) activeBtn.classList.add('tab-active');

    let azkarList = tab === 'custom' ? (appState.customAdhkar || []) : (appState.editedAzkar?.[tab] || []);

    const container = document.getElementById('adhkar-content');
    if (!azkarList.length) {
        container.innerHTML = '<div class="text-center py-10 text-white/50">لا توجد أذكار في هذا القسم</div>';
        return;
    }

    container.innerHTML = azkarList.map(dhikr => {
        const progress = appState.adhkarProgress?.[dhikr.id] || 0;
        const percent = Math.min(100, (progress / dhikr.count) * 100);
        const completed = progress >= dhikr.count;
        const perRep = getDhikrPointsPerRep(dhikr);
        const earnedPts = Math.round(perRep * progress * 10) / 10;
        const totalPts = Math.round(perRep * dhikr.count * 10) / 10;
        // SVG ring params: radius=38, circumference=2*PI*38≈238.76
        const R = 38, C = 2 * Math.PI * R;
        const offset = C - (percent / 100) * C;
        return `
            <div class="dhikr-card ${completed ? 'completed' : ''}" data-dhikr-id="${escapeHtml(dhikr.id)}">
                <!-- Top: text + edit -->
                <div class="flex justify-between items-start gap-3 mb-2">
                    <div class="ayah-text flex-1">${escapeHtml(dhikr.text)}</div>
                    ${tab !== 'custom' ? `
                        <button onclick="openEditDhikrModal('${escapeHtml(dhikr.id)}','${tab}')" class="edit-btn flex-shrink-0" title="تعديل" aria-label="تعديل الذكر">
                            <i class="fas fa-pencil-alt text-gold"></i>
                        </button>` : ''}
                </div>
                ${dhikr.surah ? `<div class="surah-ref mb-1">${escapeHtml(dhikr.surah)}</div>` : ''}
                ${dhikr.virtue ? `<div class="virtue-text mb-2">${escapeHtml(dhikr.virtue)}</div>` : ''}

                <!-- Counter area: ring + controls -->
                <div class="dhikr-counter-area">
                    <!-- Circular progress ring (tappable to increment) -->
                    <button class="dhikr-ring-btn ${completed ? 'dhikr-ring-done' : ''}"
                            onclick="updateDhikr('${escapeHtml(dhikr.id)}', 1)"
                            ${completed ? 'disabled' : ''}
                            aria-label="${completed ? 'مكتمل' : 'اضغط للتسبيح'}"
                            title="${completed ? 'مكتمل' : 'اضغط للعد'}">
                        <svg class="dhikr-ring-svg" viewBox="0 0 88 88" aria-hidden="true">
                            <circle class="dhikr-ring-bg" cx="44" cy="44" r="${R}" />
                            <circle class="dhikr-ring-fill ${completed ? 'dhikr-ring-fill-done' : ''}"
                                    cx="44" cy="44" r="${R}"
                                    stroke-dasharray="${C.toFixed(2)}"
                                    stroke-dashoffset="${offset.toFixed(2)}" />
                        </svg>
                        <span class="dhikr-ring-label">
                            ${completed
                ? '<i class="fas fa-check"></i>'
                : `<span class="dhikr-ring-count">${progress}</span>`}
                        </span>
                    </button>

                    <!-- Info column -->
                    <div class="dhikr-info-col">
                        <span class="dhikr-fraction">${progress}<span class="dhikr-fraction-sep">/</span>${dhikr.count}</span>
                        <span class="dhikr-pct">${completed ? 'مكتمل ✅' : Math.round(percent) + '%'}</span>
                        <span class="dhikr-pts">⭐ ${earnedPts}/${totalPts}</span>
                    </div>

                    <!-- Action buttons -->
                    <div class="dhikr-actions">
                        <button onclick="updateDhikr('${escapeHtml(dhikr.id)}', -1)" class="dhikr-act-btn dhikr-act-minus" ${progress <= 0 ? 'disabled' : ''} aria-label="إنقاص"><i class="fas fa-minus"></i></button>
                        <button onclick="openSetProgressModal('${escapeHtml(dhikr.id)}','${tab}')" class="dhikr-act-btn" title="ضبط يدوي" aria-label="ضبط العدد يدوياً"><i class="fas fa-pen"></i></button>
                        ${tab === 'custom' ? `<button onclick="deleteCustomAdhkar('${escapeHtml(dhikr.id)}')" class="dhikr-act-btn dhikr-act-delete" aria-label="حذف الذكر"><i class="fas fa-trash-alt"></i></button>` : ''}
                    </div>
                </div>
            </div>`;
    }).join('');
};

window.openEditDhikrModal = function (id, category) {
    const dhikr = appState.editedAzkar[category]?.find(d => d.id === id);
    if (!dhikr) return;
    currentEditDhikrId = id;
    currentEditCategory = category;
    document.getElementById('edit-dhikr-text').value = dhikr.text;
    document.getElementById('edit-dhikr-count').value = dhikr.count;
    document.getElementById('edit-dhikr-virtue').value = dhikr.virtue || '';
    document.getElementById('edit-dhikr-points').value = dhikr.points || 5;
    openModal('edit-dhikr-modal');
};

window.saveEditedDhikr = async function () {
    if (!currentEditDhikrId || !currentEditCategory) return;
    const dhikr = appState.editedAzkar[currentEditCategory]?.find(d => d.id === currentEditDhikrId);
    if (!dhikr) return;
    const newText = document.getElementById('edit-dhikr-text').value.trim();
    if (!newText) { showToast('نص الذكر لا يمكن أن يكون فارغاً', 'error'); return; }
    const newCount = parseInt(document.getElementById('edit-dhikr-count').value);
    if (isNaN(newCount) || newCount < 1) { showToast('العدد يجب أن يكون 1 على الأقل', 'error'); return; }
    const newPoints = parseInt(document.getElementById('edit-dhikr-points').value);
    dhikr.text = newText;
    dhikr.count = newCount;
    dhikr.virtue = document.getElementById('edit-dhikr-virtue').value.trim();
    dhikr.points = isNaN(newPoints) || newPoints < 1 ? 5 : newPoints;
    await saveUserField(`editedAzkar.${currentEditCategory}`, appState.editedAzkar[currentEditCategory]);
    showToast('تم تعديل الذكر بنجاح');
    closeModal('edit-dhikr-modal');
    showAdhkarTab(currentEditCategory);
    currentEditDhikrId = null; currentEditCategory = null;
};

window.saveNewDhikr = async function () {
    const category = document.getElementById('add-dhikr-category').value;
    const text = document.getElementById('add-dhikr-text').value.trim();
    if (!text) { showToast('الرجاء إدخال نص الذكر', 'error'); return; }
    const count = parseInt(document.getElementById('add-dhikr-count').value);
    if (isNaN(count) || count < 1) { showToast('العدد يجب أن يكون 1 على الأقل', 'error'); return; }
    let points = parseInt(document.getElementById('add-dhikr-points').value);
    if (isNaN(points) || points < 1) points = 5;
    const virtue = document.getElementById('add-dhikr-virtue').value.trim();
    const newDhikr = { id: generateId('dhikr'), text, surah: '', virtue: virtue || '', count, category, points };
    if (category === 'custom') {
        if (!appState.customAdhkar) appState.customAdhkar = [];
        appState.customAdhkar.push(newDhikr);
        await saveUserField('customAdhkar', appState.customAdhkar);
    } else {
        if (!appState.editedAzkar[category]) appState.editedAzkar[category] = [];
        appState.editedAzkar[category].push(newDhikr);
        await saveUserField(`editedAzkar.${category}`, appState.editedAzkar[category]);
    }
    showToast('تم إضافة الذكر بنجاح');
    closeModal('add-dhikr-modal');
    document.getElementById('add-dhikr-text').value = '';
    document.getElementById('add-dhikr-virtue').value = '';
    showAdhkarTab(category);
};

// Rate limiter: max 5 clicks per second per dhikr
const dhikrRateLimit = {};
window.updateDhikr = async function (id, delta) {
    const now = Date.now();
    if (!dhikrRateLimit[id]) dhikrRateLimit[id] = [];
    dhikrRateLimit[id] = dhikrRateLimit[id].filter(t => now - t < 1000);
    if (dhikrRateLimit[id].length >= 5) return;
    dhikrRateLimit[id].push(now);
    // Periodic cleanup: remove stale rate-limit entries every 50 calls
    if (Math.random() < 0.02) {
        for (const k of Object.keys(dhikrRateLimit)) {
            if (!dhikrRateLimit[k].length || now - dhikrRateLimit[k][dhikrRateLimit[k].length - 1] > 5000) {
                delete dhikrRateLimit[k];
            }
        }
    }

    if (!appState.adhkarProgress) appState.adhkarProgress = {};
    const current = appState.adhkarProgress[id] || 0;

    let dhikr = null;
    for (const cat of ['morning', 'evening', 'night', 'afterprayer']) {
        const found = appState.editedAzkar?.[cat]?.find(d => d.id === id);
        if (found) { dhikr = found; break; }
    }
    if (!dhikr) dhikr = appState.customAdhkar?.find(d => d.id === id);
    if (!dhikr) return;

    const newVal = Math.min(dhikr.count, Math.max(0, current + delta));
    if (newVal === current) return;
    appState.adhkarProgress[id] = newVal;

    // --- Per-rep point awarding ---
    const repsChanged = Math.abs(newVal - current);           // usually 1
    const perRep = getDhikrPointsPerRep(dhikr);
    const pointsDelta = Math.round(perRep * repsChanged * 10) / 10;
    if (delta > 0) {
        console.log(`🟢 +${pointsDelta} point(s) for repeating: ${dhikr.text.slice(0, 50)}`);
        // Per-repetition sound (if enabled)
        onDhikrRepetition(dhikr);
        // Completion feedback — fires once per dhikr per session
        if (newVal >= dhikr.count && !dhikrCompletedSet.has(id)) {
            dhikrCompletedSet.add(id);
            onDhikrComplete(dhikr);
        }
    } else {
        console.log(`🔴 -${pointsDelta} point(s) reverted: ${dhikr.text.slice(0, 50)}`);
        // Allow re-triggering if user decrements below count
        if (newVal < dhikr.count) dhikrCompletedSet.delete(id);
    }

    // Live-update the total points display without full recalc
    if (appState.totalPoints != null) {
        appState.totalPoints = Math.max(0, appState.totalPoints + (delta > 0 ? pointsDelta : -pointsDelta));
        appState.totalPoints = Math.round(appState.totalPoints);
        appState.level = Math.floor(appState.totalPoints / 100) + 1;
        const ptEl = document.getElementById('total-points-display');
        if (ptEl) ptEl.innerText = appState.totalPoints;
    }
    // Live-update adhkar card on dashboard
    const adhkarPtsEl = document.getElementById('adhkar-points-today');
    if (adhkarPtsEl) adhkarPtsEl.innerText = calculateTodayAdhkarPoints();

    if (dhikrDebounceMap[id]) clearTimeout(dhikrDebounceMap[id]);
    dhikrDebounceMap[id] = setTimeout(async () => {
        await saveUserField(`adhkarProgress.${id}`, appState.adhkarProgress[id]);
        if (delta > 0) await updateStreak(true);
        delete dhikrDebounceMap[id];
    }, 800);

    showAdhkarTab(activeAdhkarTab);
    refreshDashboard();
};

window.openSetProgressModal = function (id, category) {
    currentSetProgressId = id;
    currentSetProgressCategory = category;
    document.getElementById('set-progress-value').value = appState.adhkarProgress?.[id] || 0;
    openModal('set-dhikr-progress-modal');
};

window.saveManualProgress = async function () {
    if (!currentSetProgressId) return;
    const newVal = parseInt(document.getElementById('set-progress-value').value);
    if (isNaN(newVal) || newVal < 0) { showToast('الرجاء إدخال عدد صحيح', 'error'); return; }
    let dhikr = null;
    for (const cat of ['morning', 'evening', 'night', 'afterprayer']) {
        const found = appState.editedAzkar?.[cat]?.find(d => d.id === currentSetProgressId);
        if (found) { dhikr = found; break; }
    }
    if (!dhikr) dhikr = appState.customAdhkar?.find(d => d.id === currentSetProgressId);
    if (!dhikr) return;
    const clampedVal = Math.min(newVal, dhikr.count);
    if (!appState.adhkarProgress) appState.adhkarProgress = {};
    const prevVal = appState.adhkarProgress[currentSetProgressId] || 0;
    appState.adhkarProgress[currentSetProgressId] = clampedVal;

    // Log the manual adjustment for testing
    const perRep = getDhikrPointsPerRep(dhikr);
    const manualDelta = clampedVal - prevVal;
    if (manualDelta !== 0) {
        const manualPts = Math.round(Math.abs(manualDelta) * perRep * 10) / 10;
        console.log(`${manualDelta > 0 ? '🟢' : '🔴'} ${manualDelta > 0 ? '+' : '-'}${manualPts} point(s) manual set: ${dhikr.text.slice(0, 50)}`);
    }

    await saveUserField(`adhkarProgress.${currentSetProgressId}`, clampedVal);
    if (clampedVal > 0) await updateStreak(true);
    closeModal('set-dhikr-progress-modal');
    showAdhkarTab(currentSetProgressCategory || 'morning');
    refreshDashboard();
    currentSetProgressId = null; currentSetProgressCategory = null;
};

window.deleteCustomAdhkar = async function (id) {
    showConfirm('هل أنت متأكد من حذف هذا الذكر؟', async () => {
        appState.customAdhkar = (appState.customAdhkar || []).filter(d => d.id !== id);
        if (appState.adhkarProgress && id in appState.adhkarProgress) {
            delete appState.adhkarProgress[id];
            await saveUserField('adhkarProgress', appState.adhkarProgress);
        }
        await saveUserField('customAdhkar', appState.customAdhkar);
        showAdhkarTab('custom');
        showToast('تم الحذف');
    });
};

// =========================================================================
//  PRAYER, QURAN, ANALYSIS, PODCASTS, JOURNAL, REWARDS, REMINDERS, SETTINGS
//  Due to message length limits, abbreviated versions included
// =========================================================================
//  الصلوات المكتوبة – Redesigned Prayer Tracker
// =========================================================================

// Prayer theme gradients & config
const PRAYER_THEMES = {
    Fajr: { ar: 'الفجر', en: 'Fajr', icon: '🌅', gradient: 'linear-gradient(135deg, #1a3a5c 0%, #2d5a87 100%)', accent: '#5b9bd5', emoji: '🌙' },
    Dhuhr: { ar: 'الظهر', en: 'Dhuhr', icon: '☀️', gradient: 'linear-gradient(135deg, #5a4a1a 0%, #8b7a2e 100%)', accent: '#d4af37', emoji: '☀️' },
    Asr: { ar: 'العصر', en: 'Asr', icon: '🌤️', gradient: 'linear-gradient(135deg, #4a3520 0%, #7a5a35 100%)', accent: '#e8a849', emoji: '🌤️' },
    Maghrib: { ar: 'المغرب', en: 'Maghrib', icon: '🌅', gradient: 'linear-gradient(135deg, #4a1a3a 0%, #8b3a5a 100%)', accent: '#d47ab5', emoji: '🌇' },
    Isha: { ar: 'العشاء', en: 'Isha', icon: '🌙', gradient: 'linear-gradient(135deg, #0d1b2a 0%, #1b2d4a 100%)', accent: '#7b9fd4', emoji: '🌙' }
};

const PRAYER_MOTIVATIONS = [
    { condition: 'onTime+jamah', msg: '🔥 ماشاء الله! صلاة في وقتها جماعة = 27 ضعف!' },
    { condition: 'onTime', msg: '✨ بارك الله فيك! الصلاة في وقتها أفضل الأعمال' },
    { condition: 'late', msg: '💪 الحمد لله أنك صليت. حاول في الوقت غداً!' },
    { condition: 'streak3', msg: '🔥 3 أيام متتالية! استمر فأنت على خير عظيم' },
    { condition: 'streak7', msg: '🏆 أسبوع كامل! أنت من المحافظين على الصلاة' },
    { condition: 'streak30', msg: '👑 شهر كامل! اللهم ثبتنا على الصلاة' },
    { condition: 'allDone', msg: '🎉 أتممت صلوات اليوم! جعلها الله في ميزان حسناتك' },
    { condition: 'fajrOnTime', msg: '🌅 صلاة الفجر في وقتها = نور يوم القيامة' }
];

const PRAYER_KEY_REWARDS = [
    { keys: 5, type: 'dua', title: 'دعاء الثبات', text: 'اللهم يا مقلب القلوب ثبت قلبي على دينك', badge: '🏅 المواظب' },
    { keys: 10, type: 'hadith', title: 'فضل الصلاة', text: '"أرأيتم لو أن نهراً بباب أحدكم يغتسل منه كل يوم خمس مرات، هل يبقى من درنه شيء؟" متفق عليه', badge: '⭐ حارس الصلاة' },
    { keys: 15, type: 'dua', title: 'دعاء الخشوع', text: 'اللهم أعني على ذكرك وشكرك وحسن عبادتك', badge: '💎 الخاشع' },
    { keys: 20, type: 'hadith', title: 'فضل الجماعة', text: '"صلاة الجماعة أفضل من صلاة الفذ بسبع وعشرين درجة" متفق عليه', badge: '🕌 عاشق الجماعة' },
    { keys: 30, type: 'badge', title: 'إنجاز عظيم', text: 'جمعت 30 مفتاحاً ذهبياً!', badge: '👑 المحافِظ' },
    { keys: 50, type: 'hadith', title: 'البشرى', text: '"بشروا المشائين في الظُّلَم إلى المساجد بالنور التام يوم القيامة" رواه أبو داود', badge: '🌟 نور المساجد' }
];

function getNextPrayerInfo() {
    if (!prayerTimesCache) return null;
    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const prayers = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
    for (const p of prayers) {
        const timeStr = prayerTimesCache[p];
        if (!timeStr) continue;
        const [h, m] = timeStr.split(':').map(Number);
        const prayerMinutes = h * 60 + m;
        if (prayerMinutes > nowMinutes) {
            const diff = prayerMinutes - nowMinutes;
            const hours = Math.floor(diff / 60);
            const mins = diff % 60;
            const remaining = hours > 0 ? `${hours} ساعة ${mins > 0 ? `و ${mins} دقيقة` : ''}` : `${mins} دقيقة`;
            return { prayer: p, time: timeStr, remaining, theme: PRAYER_THEMES[p] };
        }
    }
    // All prayers passed — next is tomorrow's Fajr
    return { prayer: 'Fajr', time: prayerTimesCache.Fajr || '--:--', remaining: 'غداً إن شاء الله', theme: PRAYER_THEMES.Fajr };
}

function getPrayerKeysToday() {
    const today = getLocalDateString();
    const log = appState.prayerLogs?.[today] || {};
    let keys = 0;
    ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'].forEach(p => {
        if (log[p]?.status === 'onTime') { keys++; if (log[p]?.congregation === 'jamah') keys++; }
        else if (log[p]?.status === 'late') { keys += 0; } // late = no key
    });
    return keys;
}

function getTotalPrayerKeys() {
    const logs = appState.prayerLogs || {};
    let keys = 0;
    Object.values(logs).forEach(day => {
        ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'].forEach(p => {
            if (day[p]?.status === 'onTime') { keys++; if (day[p]?.congregation === 'jamah') keys++; }
        });
    });
    return keys;
}

function getPrayerStreak() {
    const logs = appState.prayerLogs || {};
    let streak = 0;
    const today = new Date();
    for (let i = 0; i < 365; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const ds = getLocalDateString(d);
        const day = logs[ds];
        if (!day) break;
        const allPrayed = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'].every(p =>
            day[p]?.status === 'onTime' || day[p]?.status === 'late'
        );
        if (allPrayed) streak++;
        else break;
    }
    return streak;
}

function getPrayerMotivation(prayer) {
    const today = getLocalDateString();
    const log = appState.prayerLogs?.[today] || {};
    const pData = log[prayer];
    const streak = getPrayerStreak();
    const allDone = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'].every(p =>
        log[p]?.status === 'onTime' || log[p]?.status === 'late'
    );

    if (allDone) return '🎉 أتممت صلوات اليوم! جعلها الله في ميزان حسناتك';
    if (streak >= 30) return '👑 شهر كامل من المحافظة! اللهم ثبتنا';
    if (streak >= 7) return '🏆 أسبوع كامل! أنت من المحافظين';
    if (streak >= 3) return '🔥 ' + streak + ' أيام متتالية! استمر';
    if (pData?.status === 'onTime' && pData?.congregation === 'jamah') return '🔥 جماعة في وقتها = 27 ضعف!';
    if (pData?.status === 'onTime') return '✨ بارك الله فيك! صلاة في وقتها';
    if (pData?.status === 'late') return '💪 الحمد لله أنك صليت';
    if (prayer === 'Fajr') return '🌅 من صلى الفجر فهو في ذمة الله';
    if (prayer === 'Isha') return '🌙 من صلى العشاء في جماعة كأنما قام نصف الليل';
    return '📿 حافظ على صلاتك فهي نور';
}

function getTodayPrayerSummary() {
    const today = getLocalDateString();
    const log = appState.prayerLogs?.[today] || {};
    let done = 0, onTime = 0;
    ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'].forEach(p => {
        if (log[p]?.status === 'onTime') { done++; onTime++; }
        else if (log[p]?.status === 'late') { done++; }
    });
    return { done, onTime, total: 5 };
}

function calculatePrayerCompletion() {
    const logs = appState.prayerLogs || {};
    let total = 0, comp = 0;
    for (let i = 0; i < 7; i++) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const ds = getLocalDateString(d);
        total += 5;
        if (logs[ds]) {
            ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'].forEach(p => {
                if (logs[ds][p]?.status && logs[ds][p].status !== 'missed') comp++;
            });
        }
    }
    return total ? Math.round((comp / total) * 100) : 0;
}

function getMostMissedPrayer() {
    const logs = appState.prayerLogs || {};
    const misses = { Fajr: 0, Dhuhr: 0, Asr: 0, Maghrib: 0, Isha: 0 };
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = getLocalDateString(cutoff);
    Object.entries(logs).forEach(([date, day]) => {
        if (date < cutoffStr) return;
        Object.keys(misses).forEach(p => {
            if (!day[p] || !day[p].status || day[p].status === 'missed') misses[p]++;
        });
    });
    const max = Math.max(...Object.values(misses));
    if (max === 0) return '🎉 ممتاز!';
    const names = { Fajr: 'الفجر', Dhuhr: 'الظهر', Asr: 'العصر', Maghrib: 'المغرب', Isha: 'العشاء' };
    return names[Object.keys(misses).find(p => misses[p] === max)] || '--';
}

async function renderPrayer() {
    const cached = safeLocalStorageGet('nafs_prayer_cache');
    if (cached) {
        const parsed = safeJsonParse(cached);
        if (parsed && typeof parsed === 'object' && parsed.Fajr) prayerTimesCache = parsed;
    }

    const nextPrayer = getNextPrayerInfo();
    const summary = getTodayPrayerSummary();
    const streak = getPrayerStreak();
    const totalKeys = getTotalPrayerKeys();
    const todayKeys = getPrayerKeysToday();
    const nextReward = PRAYER_KEY_REWARDS.find(r => r.keys > totalKeys) || PRAYER_KEY_REWARDS[PRAYER_KEY_REWARDS.length - 1];
    const rewardProgress = nextReward ? Math.min(100, Math.round((totalKeys / nextReward.keys) * 100)) : 100;
    const hijriDate = getHijriDate();

    const progressPercent = Math.round((summary.done / summary.total) * 100);
    const circumference = 2 * Math.PI * 54;
    const dashOffset = circumference - (progressPercent / 100) * circumference;

    document.getElementById('screen-prayer').innerHTML = `
        <div class="prayer-tracker-container space-y-5">
            <!-- ====== Summary Card ====== -->
            <div class="prayer-summary-card">
                <div class="prayer-summary-header">
                    <div class="prayer-summary-date">
                        <span class="text-gold font-bold text-lg">${new Date().toLocaleDateString('ar-EG', { weekday: 'long' })}</span>
                        ${hijriDate ? `<span class="text-white/50 text-sm">${hijriDate}</span>` : ''}
                    </div>
                    <div class="prayer-summary-actions">
                        <button onclick="fetchPrayerTimesGeo()" class="prayer-location-btn" aria-label="تحديد الموقع">
                            <i class="fas fa-location-dot"></i>
                        </button>
                        <button onclick="openCountrySelector()" class="prayer-location-btn" aria-label="اختر دولة">
                            <i class="fas fa-globe"></i>
                        </button>
                    </div>
                </div>

                <div class="prayer-summary-body">
                    <!-- Progress Ring -->
                    <div class="prayer-progress-ring-container">
                        <svg class="prayer-progress-ring" viewBox="0 0 120 120">
                            <circle class="prayer-ring-bg" cx="60" cy="60" r="54" />
                            <circle class="prayer-ring-fill" cx="60" cy="60" r="54"
                                stroke-dasharray="${circumference.toFixed(2)}"
                                stroke-dashoffset="${dashOffset.toFixed(2)}" />
                        </svg>
                        <div class="prayer-ring-label">
                            <span class="prayer-ring-count">${summary.done}</span>
                            <span class="prayer-ring-total">/ ${summary.total}</span>
                        </div>
                    </div>

                    <!-- Stats -->
                    <div class="prayer-summary-stats">
                        ${nextPrayer ? `
                        <div class="prayer-next-box">
                            <span class="prayer-next-icon">${nextPrayer.theme.emoji}</span>
                            <div>
                                <span class="prayer-next-label">الصلاة القادمة</span>
                                <span class="prayer-next-name">${nextPrayer.theme.ar} — ${nextPrayer.time}</span>
                                <span class="prayer-next-remaining">${nextPrayer.remaining}</span>
                            </div>
                        </div>` : ''}
                        <div class="prayer-mini-stats">
                            <div class="prayer-mini-stat">
                                <i class="fas fa-fire text-orange-400"></i>
                                <span>${streak}</span>
                                <small>يوم متتالي</small>
                            </div>
                            <div class="prayer-mini-stat">
                                <i class="fas fa-key text-gold"></i>
                                <span>${todayKeys}</span>
                                <small>مفاتيح اليوم</small>
                            </div>
                            <div class="prayer-mini-stat">
                                <i class="fas fa-percentage text-green-400"></i>
                                <span>${calculatePrayerCompletion()}%</span>
                                <small>آخر 7 أيام</small>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Keys Progress Bar -->
                <div class="prayer-keys-bar">
                    <div class="prayer-keys-info">
                        <span><i class="fas fa-key text-gold me-1"></i>${totalKeys} مفتاح ذهبي</span>
                        <span class="text-white/40 text-xs">${nextReward ? `التالي: ${nextReward.keys} 🔑` : '🏆 أنجزت الكل!'}</span>
                    </div>
                    <div class="prayer-keys-track">
                        <div class="prayer-keys-fill" style="width:${rewardProgress}%"></div>
                    </div>
                </div>
            </div>

            <!-- ====== Prayer Cards ====== -->
            <div id="prayer-cards-container" class="prayer-cards-grid">
                ${renderPrayerCards()}
            </div>

            <!-- ====== Nawafl Section ====== -->
            <div class="prayer-nawafl-section">
                <div class="flex items-center justify-between mb-4">
                    <h3 class="font-bold text-xl text-gold"><i class="fas fa-mosque me-2"></i>صلوات النوافل</h3>
                    <button onclick="openModal('nafl-modal')" class="prayer-add-nafl-btn">
                        <i class="fas fa-plus me-1"></i>إضافة
                    </button>
                </div>
                <div id="nafl-prayers-list" class="space-y-3"></div>
            </div>

            <!-- ====== Weekly Stats ====== -->
            <div class="prayer-weekly-stats">
                <h3 class="font-bold text-lg text-gold mb-4"><i class="fas fa-chart-bar me-2"></i>إحصائيات الأسبوع</h3>
                <div class="prayer-week-chart" id="prayer-week-bars"></div>
                <div class="prayer-stats-footer">
                    <div class="prayer-stat-pill">
                        <span class="text-white/50 text-xs">أكثر صلاة تفوتك</span>
                        <span class="text-gold font-bold">${getMostMissedPrayer()}</span>
                    </div>
                </div>
            </div>
        </div>`;

    renderPrayerLogCards();
    renderNaflPrayersList();
    renderPrayerWeekBars();
}

function renderPrayerCards() {
    const today = getLocalDateString();
    const log = appState.prayerLogs?.[today] || {};
    const prayers = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];

    return prayers.map(p => {
        const theme = PRAYER_THEMES[p];
        const data = log[p] || {};
        const status = data.status || 'none';
        const congregation = data.congregation || 'alone';
        const place = data.place || 'home';
        const focus = data.focus || 'medium';
        const time = prayerTimesCache?.[p] || '--:--';
        const note = data.note || '';

        const statusIndicator = status === 'onTime' ? '🟢' : status === 'late' ? '🟡' : status === 'missed' ? '🔴' : '⚪';
        const statusText = status === 'onTime' ? 'في الوقت' : status === 'late' ? 'قضاء' : status === 'missed' ? 'فاتت' : 'لم تُسجَّل';
        const isDone = status === 'onTime' || status === 'late';
        const motivation = getPrayerMotivation(p);

        return `
        <div class="prayer-card ${isDone ? 'prayer-card-done' : ''} prayer-card-${p.toLowerCase()}" data-prayer="${p}">
            <div class="prayer-card-bg" style="background:${theme.gradient}"></div>
            <div class="prayer-card-content">
                <!-- Header -->
                <div class="prayer-card-header">
                    <div class="prayer-card-name">
                        <span class="prayer-card-icon">${theme.emoji}</span>
                        <div>
                            <span class="prayer-card-ar">${theme.ar}</span>
                            <span class="prayer-card-en">${theme.en}</span>
                        </div>
                    </div>
                    <div class="prayer-card-time-box">
                        <span class="prayer-card-time">${time}</span>
                        <span class="prayer-card-status-dot">${statusIndicator}</span>
                    </div>
                </div>

                <!-- Status Button Row -->
                <div class="prayer-card-status-row">
                    <button onclick="cyclePrayerStatus('${p}')"
                        class="prayer-status-btn prayer-status-${status}"
                        aria-label="حالة صلاة ${theme.ar}">
                        <span class="prayer-status-icon">${status === 'onTime' ? '✅' : status === 'late' ? '⏰' : status === 'missed' ? '❌' : '○'}</span>
                        <span>${statusText}</span>
                    </button>
                </div>

                <!-- Toggles (visible when prayer is done) -->
                ${isDone ? `
                <div class="prayer-card-toggles">
                    <button onclick="togglePrayerField('${p}','congregation','${congregation === 'jamah' ? 'alone' : 'jamah'}')"
                        class="prayer-toggle ${congregation === 'jamah' ? 'active' : ''}" aria-label="جماعة">
                        <i class="fas fa-users"></i>
                        <span>${congregation === 'jamah' ? 'جماعة' : 'منفرد'}</span>
                    </button>
                    <button onclick="cyclePrayerPlace('${p}','${place}')"
                        class="prayer-toggle ${place === 'masjid' ? 'active' : ''}" aria-label="المكان">
                        <i class="fas ${place === 'masjid' ? 'fa-mosque' : place === 'home' ? 'fa-home' : place === 'work' ? 'fa-briefcase' : 'fa-map-pin'}"></i>
                        <span>${place === 'masjid' ? 'مسجد' : place === 'home' ? 'منزل' : place === 'work' ? 'عمل' : 'أخرى'}</span>
                    </button>
                    <div class="prayer-focus-selector">
                        ${['low', 'medium', 'high'].map(f => `
                            <button onclick="togglePrayerField('${p}','focus','${f}')"
                                class="prayer-focus-btn ${focus === f ? 'active' : ''}"
                                aria-label="تركيز ${f === 'high' ? 'عالي' : f === 'medium' ? 'متوسط' : 'منخفض'}">
                                ${f === 'high' ? '🎯' : f === 'medium' ? '😐' : '😔'}
                            </button>`).join('')}
                    </div>
                </div>

                <!-- Note -->
                <div class="prayer-card-note">
                    <button onclick="togglePrayerNote('${p}')" class="prayer-note-btn">
                        <i class="fas fa-sticky-note me-1"></i>${note ? 'تعديل الملاحظة' : 'إضافة ملاحظة'}
                    </button>
                    ${note ? `<p class="prayer-note-text">${escapeHtml(note)}</p>` : ''}
                </div>
                ` : ''}

                <!-- Motivation -->
                <div class="prayer-card-motivation">${motivation}</div>
            </div>
            ${isDone ? '<div class="prayer-card-done-glow"></div>' : ''}
        </div>`;
    }).join('');
}

// Alias old function name for backward compat
function renderPrayerLogForm() { renderPrayerLogCards(); }

function renderPrayerLogCards() {
    const container = document.getElementById('prayer-cards-container');
    if (container) container.innerHTML = renderPrayerCards();
}

function renderPrayerWeekBars() {
    const container = document.getElementById('prayer-week-bars');
    if (!container) return;
    const logs = appState.prayerLogs || {};
    const days = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const ds = getLocalDateString(d);
        const dayLog = logs[ds] || {};
        let count = 0;
        ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'].forEach(p => {
            if (dayLog[p]?.status === 'onTime' || dayLog[p]?.status === 'late') count++;
        });
        const dayName = d.toLocaleDateString('ar-EG', { weekday: 'short' });
        days.push({ name: dayName, count, isToday: i === 0 });
    }
    container.innerHTML = days.map(d => `
        <div class="prayer-bar-col ${d.isToday ? 'today' : ''}">
            <div class="prayer-bar-track">
                <div class="prayer-bar-fill" style="height:${(d.count / 5) * 100}%"></div>
            </div>
            <span class="prayer-bar-count">${d.count}</span>
            <span class="prayer-bar-day">${d.name}</span>
        </div>`).join('');
}

// ---- Prayer interactions ----

window.cyclePrayerStatus = async function (prayer) {
    const today = getLocalDateString();
    if (!appState.prayerLogs) appState.prayerLogs = {};
    if (!appState.prayerLogs[today]) appState.prayerLogs[today] = {};
    if (!appState.prayerLogs[today][prayer]) appState.prayerLogs[today][prayer] = {};

    const current = appState.prayerLogs[today][prayer].status || 'none';
    const cycle = { none: 'onTime', onTime: 'late', late: 'missed', missed: 'none' };
    const next = cycle[current] || 'onTime';

    appState.prayerLogs[today][prayer].status = next;
    await saveUserFieldDual(`prayerLogs.${today}`, appState.prayerLogs[today]);
    await recalculateTotalPoints();

    if (next === 'onTime' || next === 'late') await updateStreak(true);

    // Check for key rewards
    checkPrayerKeyReward();

    renderPrayerLogCards();
    renderPrayerWeekBars();
    // Update summary card stats
    refreshPrayerSummary();
    refreshDashboard();

    // Card animation
    const card = document.querySelector(`[data-prayer="${prayer}"]`);
    if (card) {
        card.classList.add('prayer-card-pulse');
        setTimeout(() => card.classList.remove('prayer-card-pulse'), 600);
    }
};

window.togglePrayerField = async function (prayer, field, value) {
    const today = getLocalDateString();
    if (!appState.prayerLogs) appState.prayerLogs = {};
    if (!appState.prayerLogs[today]) appState.prayerLogs[today] = {};
    if (!appState.prayerLogs[today][prayer]) appState.prayerLogs[today][prayer] = {};

    appState.prayerLogs[today][prayer][field] = value;
    await saveUserFieldDual(`prayerLogs.${today}`, appState.prayerLogs[today]);
    await recalculateTotalPoints();

    if (field === 'congregation' && value === 'jamah') checkPrayerKeyReward();

    renderPrayerLogCards();
    refreshPrayerSummary();
    refreshDashboard();
};

window.cyclePrayerPlace = async function (prayer, current) {
    const cycle = { home: 'masjid', masjid: 'work', work: 'other', other: 'home' };
    const next = cycle[current] || 'home';
    await window.togglePrayerField(prayer, 'place', next);
};

window.togglePrayerNote = function (prayer) {
    const today = getLocalDateString();
    const currentNote = appState.prayerLogs?.[today]?.[prayer]?.note || '';
    const theme = PRAYER_THEMES[prayer];

    const div = document.createElement('div');
    div.id = 'prayer-note-modal';
    div.className = 'modal-overlay active';
    div.setAttribute('data-closable', 'true');
    div.innerHTML = `
        <div class="modal-content" style="max-width:400px">
            <h3 class="text-xl font-bold text-gold mb-4">${theme.emoji} ملاحظة صلاة ${theme.ar}</h3>
            <textarea id="prayer-note-input" class="w-full p-3 rounded-xl bg-white/10 border border-gold/30 text-white text-sm"
                rows="3" placeholder="مثال: صليت مع أبي في المسجد...">${escapeHtml(currentNote)}</textarea>
            <div class="flex gap-3 mt-4">
                <button onclick="savePrayerNote('${prayer}')" class="flex-1 bg-gradient-islamic border border-gold text-gold font-bold py-3 rounded-xl">حفظ</button>
                <button onclick="document.getElementById('prayer-note-modal').remove()" class="flex-1 bg-white/10 text-white font-bold py-3 rounded-xl">إلغاء</button>
            </div>
        </div>`;
    document.body.appendChild(div);
};

window.savePrayerNote = async function (prayer) {
    const noteEl = document.getElementById('prayer-note-input');
    if (!noteEl) return;
    const today = getLocalDateString();
    if (!appState.prayerLogs[today]) appState.prayerLogs[today] = {};
    if (!appState.prayerLogs[today][prayer]) appState.prayerLogs[today][prayer] = {};
    appState.prayerLogs[today][prayer].note = noteEl.value.trim();
    await saveUserFieldDual(`prayerLogs.${today}`, appState.prayerLogs[today]);
    document.getElementById('prayer-note-modal')?.remove();
    renderPrayerLogCards();
    showToast('تم حفظ الملاحظة');
};

function checkPrayerKeyReward() {
    const totalKeys = getTotalPrayerKeys();
    const lastRewardKeys = parseInt(safeLocalStorageGet('nafs_last_prayer_reward') || '0');
    const reward = PRAYER_KEY_REWARDS.find(r => r.keys > lastRewardKeys && r.keys <= totalKeys);
    if (reward) {
        safeLocalStorageSet('nafs_last_prayer_reward', reward.keys.toString());
        showPrayerRewardPopup(reward);
    }
}

function showPrayerRewardPopup(reward) {
    const div = document.createElement('div');
    div.className = 'prayer-reward-overlay';
    div.innerHTML = `
        <div class="prayer-reward-popup">
            <div class="prayer-reward-badge">${reward.badge}</div>
            <h3 class="prayer-reward-title">${escapeHtml(reward.title)}</h3>
            <p class="prayer-reward-text">${escapeHtml(reward.text)}</p>
            <div class="prayer-reward-keys"><i class="fas fa-key text-gold me-1"></i>${reward.keys} مفتاح ذهبي</div>
            <button onclick="this.closest('.prayer-reward-overlay').remove()" class="prayer-reward-close">ما شاء الله! 🎉</button>
        </div>`;
    document.body.appendChild(div);
    triggerConfetti();
    if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 100]);
}

function refreshPrayerSummary() {
    const summaryCard = document.querySelector('.prayer-summary-card');
    if (!summaryCard) return;
    // Re-render the whole prayer section for consistency
    // This is lightweight enough since it's just DOM updates
    const summary = getTodayPrayerSummary();
    const todayKeys = getPrayerKeysToday();
    const streak = getPrayerStreak();
    const totalKeys = getTotalPrayerKeys();

    const progressPercent = Math.round((summary.done / summary.total) * 100);
    const circumference = 2 * Math.PI * 54;
    const dashOffset = circumference - (progressPercent / 100) * circumference;

    const ringFill = summaryCard.querySelector('.prayer-ring-fill');
    if (ringFill) ringFill.setAttribute('stroke-dashoffset', dashOffset.toFixed(2));
    const ringCount = summaryCard.querySelector('.prayer-ring-count');
    if (ringCount) ringCount.textContent = summary.done;

    const miniStats = summaryCard.querySelectorAll('.prayer-mini-stat span:not(small)');
    if (miniStats[0]) miniStats[0].textContent = streak;
    if (miniStats[1]) miniStats[1].textContent = todayKeys;
    if (miniStats[2]) miniStats[2].textContent = calculatePrayerCompletion() + '%';

    const nextReward = PRAYER_KEY_REWARDS.find(r => r.keys > totalKeys) || PRAYER_KEY_REWARDS[PRAYER_KEY_REWARDS.length - 1];
    const rewardProgress = nextReward ? Math.min(100, Math.round((totalKeys / nextReward.keys) * 100)) : 100;
    const keysFill = summaryCard.querySelector('.prayer-keys-fill');
    if (keysFill) keysFill.style.width = rewardProgress + '%';
    const keysInfo = summaryCard.querySelector('.prayer-keys-info span:first-child');
    if (keysInfo) keysInfo.innerHTML = `<i class="fas fa-key text-gold me-1"></i>${totalKeys} مفتاح ذهبي`;
}

// Keep old updatePrayer for any external callers
window.updatePrayer = async function (prayer, field, value) {
    const today = getLocalDateString();
    if (!appState.prayerLogs) appState.prayerLogs = {};
    if (!appState.prayerLogs[today]) appState.prayerLogs[today] = {};
    if (!appState.prayerLogs[today][prayer]) appState.prayerLogs[today][prayer] = {};
    if (field === 'stars') value = parseInt(value);
    appState.prayerLogs[today][prayer][field] = value;
    await saveUserFieldDual(`prayerLogs.${today}`, appState.prayerLogs[today]);
    await recalculateTotalPoints();
    const isPositive = !(field === 'status' && value === 'missed');
    if (isPositive) await updateStreak(true);
    renderPrayerLogCards();
    refreshPrayerSummary();
    refreshDashboard();
};

window.openCountrySelector = function () {
    document.getElementById('country-select-modal')?.remove();
    const div = document.createElement('div');
    div.id = 'country-select-modal';
    div.className = 'modal-overlay active';
    div.setAttribute('data-closable', 'true');
    div.innerHTML = `
        <div class="modal-content">
            <h3 class="text-2xl font-bold text-gold mb-5">🌍 اختر دولتك</h3>
            <select id="country-select" class="w-full mb-5">
                ${COUNTRIES.map(c => `<option value="${c.lat},${c.lng},${c.method}">${escapeHtml(c.name)}</option>`).join('')}
            </select>
            <div class="flex gap-3">
                <button onclick="fetchPrayerTimesFromCountry()" class="flex-1 bg-gradient-islamic border border-gold text-gold font-bold py-3 rounded-xl">تحديث</button>
                <button onclick="document.getElementById('country-select-modal').remove()" class="flex-1 bg-white/10 text-white font-bold py-3 rounded-xl">إلغاء</button>
            </div>
        </div>`;
    document.body.appendChild(div);
};

window.fetchPrayerTimesFromCountry = function () {
    const select = document.getElementById('country-select');
    if (!select) return;
    const parts = select.value.split(',');
    const lat = parseFloat(parts[0]);
    const lng = parseFloat(parts[1]);
    const method = parseInt(parts[2]) || 5;
    document.getElementById('country-select-modal')?.remove();
    fetchPrayerTimesByCoords(lat, lng, method);
};

window.fetchPrayerTimesGeo = async function () {
    showToast('جاري تحديد الموقع...');
    try {
        if (!navigator.geolocation) throw new Error('الموقع غير مدعوم');
        const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 10000 }));
        await fetchPrayerTimesByCoords(pos.coords.latitude, pos.coords.longitude, 5);
    } catch (e) {
        showToast('فشل تحديد الموقع. استخدم "اختر دولة".', 'error');
    }
};

window.fetchPrayerTimesByCoords = async function (lat, lng, method = 5) {
    try {
        if (!rateLimitOk('aladhan', 10000)) { showToast('انتظر قليلاً قبل التحديث مرة أخرى'); return; }
        const date = new Date();
        const url = `https://api.aladhan.com/v1/timings/${date.getDate()}-${date.getMonth() + 1}-${date.getFullYear()}?latitude=${lat}&longitude=${lng}&method=${method}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('فشل الاتصال بالخادم');
        const data = await res.json();
        const t = data.data.timings;
        prayerTimesCache = { Fajr: t.Fajr, Sunrise: t.Sunrise, Dhuhr: t.Dhuhr, Asr: t.Asr, Maghrib: t.Maghrib, Isha: t.Isha };
        safeLocalStorageSet('nafs_prayer_cache', JSON.stringify(prayerTimesCache));
        showToast('تم تحديث المواقيت');
        renderPrayer(); // Re-render entire prayer screen with new times
    } catch (e) {
        showToast(e.message || 'فشل تحديث المواقيت', 'error');
    }
};

window.saveNaflPrayer = async function () {
    const name = document.getElementById('nafl-name').value.trim();
    if (!name) { showToast('الرجاء إدخال اسم النافلة', 'error'); return; }
    const rakaat = parseInt(document.getElementById('nafl-rakaat').value);
    if (isNaN(rakaat) || rakaat < 1) { showToast('عدد الركعات غير صحيح', 'error'); return; }
    const time = document.getElementById('nafl-time').value;
    const notes = document.getElementById('nafl-notes').value.trim();
    if (!appState.naflPrayers) appState.naflPrayers = [];
    appState.naflPrayers.push({ id: generateId('nafl'), name, rakaat, time, notes, points: 5 });
    await saveUserField('naflPrayers', appState.naflPrayers);
    showToast('تم إضافة النافلة');
    closeModal('nafl-modal');
    document.getElementById('nafl-name').value = '';
    document.getElementById('nafl-notes').value = '';
    renderNaflPrayersList();
};

function renderNaflPrayersList() {
    const container = document.getElementById('nafl-prayers-list');
    if (!container) return;
    const nafls = appState.naflPrayers || [];
    if (!nafls.length) { container.innerHTML = '<div class="text-center py-5 text-white/50">لا توجد نوافل</div>'; return; }
    const today = getLocalDateString();
    if (!appState.naflLogs) appState.naflLogs = {};
    if (!appState.naflLogs[today]) appState.naflLogs[today] = {};
    const todayLog = appState.naflLogs[today];
    const timesMap = { any: 'أي وقت', fajr: 'بعد الفجر', dhuha: 'الضحى', dhuhr: 'قبل/بعد الظهر', asr: 'بعد العصر', maghrib: 'بعد المغرب', isha: 'بعد العشاء', tahajjud: 'قيام الليل' };
    const defaultIds = DEFAULT_NAWAFL.map(d => d.id);
    container.innerHTML = nafls.map(nafl => {
        const done = todayLog[nafl.id] || false;
        const isDefault = defaultIds.includes(nafl.id);
        return `
            <div class="nafl-prayer-card ${done ? 'completed' : ''}">
                <div class="nafl-info">
                    <h4>${escapeHtml(nafl.name)}</h4>
                    <p>${nafl.rakaat} ركعات • ${escapeHtml(timesMap[nafl.time] || nafl.time)}</p>
                    ${nafl.notes ? `<p style="color: rgba(255, 255, 255, 0.4); font-size: 0.8rem; margin-top: 0.3rem;">${escapeHtml(nafl.notes)}</p>` : ''}
                </div>
                <div class="nafl-actions">
                    <button onclick="toggleNafl('${escapeHtml(nafl.id)}')"
                        class="nafl-toggle-btn ${done ? 'done' : ''}">
                        <i class="fas ${done ? 'fa-check-circle' : 'fa-circle'} me-1"></i>${done ? 'أديت' : 'تسجيل'}
                    </button>
                    ${!isDefault ? `
                        <button onclick="deleteNafl('${escapeHtml(nafl.id)}')" class="nafl-delete-btn" aria-label="حذف النافلة">
                            <i class="fas fa-trash-alt"></i>
                        </button>` : ''}
                </div>
            </div>`;
    }).join('');
}

window.toggleNafl = async function (id) {
    const today = getLocalDateString();
    if (!appState.naflLogs) appState.naflLogs = {};
    if (!appState.naflLogs[today]) appState.naflLogs[today] = {};
    appState.naflLogs[today][id] = !appState.naflLogs[today][id];
    await saveUserFieldDual(`naflLogs.${today}`, appState.naflLogs[today]);
    await recalculateTotalPoints();
    if (appState.naflLogs[today][id]) await updateStreak(true);
    renderNaflPrayersList();

    // Add animation to the toggled nafl card
    setTimeout(() => {
        const naflCard = document.querySelector(`[onclick*="toggleNafl('${id}')"]`)?.closest('.nafl-prayer-card');
        if (naflCard) {
            naflCard.style.animation = 'statusPulse 0.5s ease-out';
            setTimeout(() => naflCard.style.animation = '', 500);
        }
    }, 100);

    refreshDashboard();
};

window.deleteNafl = async function (id) {
    showConfirm('هل تريد حذف هذه النافلة؟', async () => {
        appState.naflPrayers = (appState.naflPrayers || []).filter(n => n.id !== id);
        await saveUserField('naflPrayers', appState.naflPrayers);
        renderNaflPrayersList();
        showToast('تم الحذف');
    });
};

// =========================================================================
//  القرآن الكريم - محسّن مع القراءة والاستماع
// =========================================================================
function renderQuran() {
    if (!appState.quranProgress) {
        appState.quranProgress = { currentPage: 1, totalPagesRead: 0, totalKhatma: 0, dailyPages: {}, currentJuz: 1, currentHizb: 1, quranReadProgress: {} };
    }
    const q = appState.quranProgress;
    const targetPerDay = appState.settings?.quranPagesPerDay || 2;
    const targetDays = appState.settings?.targetKhatmaDays || 30;
    const khatmaProgress = ((q.currentPage - 1) / 604) * 100;
    const today = getLocalDateString();
    const todayPages = q.dailyPages?.[today] || 0;
    const weeklyPagesTotal = Object.entries(q.dailyPages || {})
        .filter(([d]) => {
            const diff = (new Date() - new Date(d)) / (1000 * 60 * 60 * 24);
            return diff >= 0 && diff <= 7;
        })
        .reduce((s, [, p]) => s + p, 0);

    document.getElementById('screen-quran').innerHTML = `
        <div class="space-y-5">
            <div class="card p-5">
                <div class="flex items-center gap-3 mb-5"><span class="text-3xl">📖</span><h2 class="text-2xl font-bold text-gold">القرآن الكريم</h2></div>
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div class="bg-white/5 border border-white/10 rounded-2xl p-5 text-center">
                        <i class="fas fa-book-open text-3xl text-gold mb-2"></i>
                        <p class="text-white/60 text-sm mt-1">الصفحة الحالية</p>
                        <div class="flex items-baseline justify-center gap-1">
                            <span class="text-4xl font-bold">${q.currentPage}</span>
                            <span class="text-sm text-white/40">/ 604</span>
                        </div>
                        <div class="progress-bar mt-3"><div class="progress-fill" style="width:${khatmaProgress.toFixed(1)}%"></div></div>
                    </div>
                    <div class="bg-white/5 border border-white/10 rounded-2xl p-5 text-center">
                        <i class="fas fa-star text-3xl text-yellow-400 mb-2"></i>
                        <p class="text-white/60 text-sm mt-1">عدد الختمات</p>
                        <span class="text-4xl font-bold">${q.totalKhatma}</span>
                    </div>
                    <div class="bg-white/5 border border-white/10 rounded-2xl p-5 text-center">
                        <i class="fas fa-bullseye text-3xl text-green-400 mb-2"></i>
                        <p class="text-white/60 text-sm mt-1">هدف الختمة</p>
                        <span class="text-2xl font-bold">${targetDays} يوم</span>
                        <span class="text-sm block text-white/40 mt-1">(${targetPerDay} ص/يوم)</span>
                    </div>
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
                    <div class="bg-gold-soft p-3 rounded-xl text-center"><p class="text-white/60 text-xs">الجزء</p><p class="text-2xl font-bold text-gold">${Math.min(30, Math.floor((q.currentPage - 1) / 20) + 1)}</p></div>
                    <div class="bg-gold-soft p-3 rounded-xl text-center"><p class="text-white/60 text-xs">الحزب</p><p class="text-2xl font-bold text-gold">${Math.min(60, Math.floor((q.currentPage - 1) / 10) + 1)}</p></div>
                    <div class="bg-gold-soft p-3 rounded-xl text-center"><p class="text-white/60 text-xs">قراءة اليوم</p><p class="text-2xl font-bold text-gold">${todayPages}</p></div>
                    <div class="bg-gold-soft p-3 rounded-xl text-center"><p class="text-white/60 text-xs">آخر 7 أيام</p><p class="text-2xl font-bold text-gold">${weeklyPagesTotal}</p></div>
                </div>
                <div class="mt-5"><canvas id="quranWeeklyChart" height="80"></canvas></div>
                <div class="mt-5 grid grid-cols-2 gap-3">
                    <button onclick="openModal('quran-pages-modal')" class="bg-gradient-islamic border border-gold text-gold font-bold py-3 rounded-xl transition">
                        <i class="fas fa-plus me-1"></i>تسجيل صفحات
                    </button>
                    <button onclick="openModal('khatma-goal-modal')" class="bg-gradient-islamic border border-gold text-gold font-bold py-3 rounded-xl transition">
                        <i class="fas fa-bullseye me-1"></i>ضبط الهدف
                    </button>
                </div>
            </div>
            
            <div class="card p-5">
                <div class="flex items-center gap-3 mb-5"><span class="text-3xl">📖</span><h2 class="text-2xl font-bold text-gold">قراءة المصحف</h2></div>
                <div class="mb-4 flex flex-wrap gap-2">
                    <button onclick="showQuranReadingMode('list')" class="read-mode-btn active px-4 py-2 rounded-full border transition text-sm" data-mode="list">
                        <i class="fas fa-list me-1"></i>السور
                    </button>
                    <button onclick="showQuranReadingMode('pages')" class="read-mode-btn px-4 py-2 rounded-full border transition text-sm" data-mode="pages">
                        <i class="fas fa-book-open me-1"></i>الصفحات
                    </button>
                </div>
                <div id="quran-reading-container" class="space-y-3"></div>
            </div>

            <div class="card p-5">
                <div class="flex items-center gap-3 mb-5"><span class="text-3xl">🎧</span><h2 class="text-2xl font-bold text-gold">استماع القرآن</h2></div>
                <div class="mb-4">
                    <label class="block text-sm mb-2">اختر الشيخ</label>
                    <select id="reciter-select" onchange="loadQuranAudio(this.value)" class="w-full">
                        <option value="">-- اختر الشيخ --</option>
                        ${QURAN_RECITERS.map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('')}
                    </select>
                </div>
                <div id="quran-audio-content" class="space-y-3 max-h-96 overflow-y-auto"></div>
            </div>
        </div>`;
    drawQuranWeeklyChart();
    renderQuranReading('list');
}

window.showQuranReadingMode = function (mode) {
    document.querySelectorAll('.read-mode-btn').forEach(btn => {
        if (btn.getAttribute('data-mode') === mode) {
            btn.classList.add('active');
            btn.style.background = 'rgba(200,170,78,0.3)';
            btn.style.borderColor = 'var(--accent-gold)';
            btn.style.color = 'var(--accent-gold)';
        } else {
            btn.classList.remove('active');
            btn.style.background = 'transparent';
            btn.style.borderColor = 'rgba(200,170,78,0.3)';
            btn.style.color = 'var(--text-muted)';
        }
    });
    renderQuranReading(mode);
};

function renderQuranReading(mode) {
    const container = document.getElementById('quran-reading-container');
    if (!container) return;

    if (mode === 'list') {
        // عرض السور
        container.innerHTML = QURAN_SURAHS.map(s => `
                    <div class="bg-white/5 p-4 rounded-xl flex items-center justify-between hover:bg-white/10 transition cursor-pointer" onclick="selectQuranSurah(${s.num})">
                        <div class="flex-1">
                            <p class="font-bold text-gold">${s.num}. ${escapeHtml(s.name)}</p>
                            <p class="text-xs text-white/50">الصفحات ${s.startPage} - ${s.endPage}</p>
                        </div>
                        <div class="text-right">
                            <span style="background: rgba(200,170,78,0.15); color: var(--accent-gold); padding: 0.4rem 0.8rem; border-radius: 9999px; font-size: 0.9rem; display: inline-block;">
                                📖 ${s.points} نقطة
                            </span>
                        </div>
                    </div>`).join('');
    } else if (mode === 'pages') {
        // عرض الصفحات
        let pagesHtml = '';
        for (let page = 1; page <= 604; page++) {
            const surah = QURAN_SURAHS.find(s => page >= s.startPage && page <= s.endPage);
            const isRead = appState.quranProgress?.quranReadProgress?.[page] || false;
            pagesHtml += `
                        <button onclick="togglePageRead(${page})" class="px-3 py-2 rounded-lg text-sm transition ${isRead ? 'bg-green-500/30 border border-green-500/50 text-green-400' : 'bg-white/5 border border-white/20 text-white/70'}">
                            ${page}
                        </button>`;
        }
        container.innerHTML = `<div class="grid grid-cols-12 gap-2">${pagesHtml}</div>`;
    }
}

window.selectQuranSurah = function (surahNum) {
    const surah = QURAN_SURAHS.find(s => s.num === surahNum);
    if (!surah) return;

    showToast(`اختير سورة: ${surah.name} (الصفحات ${surah.startPage} - ${surah.endPage})`, 'success');
    // فتح Modal لقراءة السورة
    openModal('surah-reading-modal');
    renderSurahReading(surah);
};

function renderSurahReading(surah) {
    const modal = document.getElementById('surah-reading-modal');
    if (!modal) return;
    modal.classList.add('active');
    modal.innerHTML = `
        <div class="modal-content surah-modal-content">
            <!-- Decorative surah header -->
            <div class="surah-modal-header">
                <span class="surah-modal-ornament">❁</span>
                <div class="surah-modal-title-block">
                    <h2 class="surah-modal-title">سورة ${escapeHtml(surah.name)}</h2>
                    <p class="surah-modal-meta">الصفحات ${surah.startPage} - ${surah.endPage}</p>
                </div>
                <span class="surah-modal-ornament">❁</span>
            </div>

            <div id="surah-reading-body" class="surah-reading-body">
                <div class="text-center py-10"><div class="spinner mb-3"></div><p style="color:rgba(255,255,255,0.5)">جاري تحميل نص السورة...</p></div>
            </div>

            <!-- Font size slider -->
            <div class="surah-font-slider">
                <label>حجم الخط</label>
                <input type="range" min="18" max="48" value="28" oninput="document.getElementById('surah-ayat-container').style.fontSize=this.value+'px'">
            </div>

            <div class="surah-modal-actions">
                <button onclick="markSurahAsRead(${surah.num})" class="surah-btn-done">✅ تم قراءة السورة</button>
                <button onclick="closeModal('surah-reading-modal')" class="surah-btn-close">إغلاق</button>
            </div>
        </div>`;

    // Fetch Uthmani text from API
    if (!rateLimitOk('alquran_surah', 3000)) return;
    fetch(`https://api.alquran.cloud/v1/surah/${surah.num}/quran-uthmani`)
        .then(r => r.json())
        .then(data => {
            const body = document.getElementById('surah-reading-body');
            if (!body || !data.data?.ayahs) {
                if (body) body.innerHTML = '<p class="text-red-400 text-center py-6">تعذر تحميل نص السورة</p>';
                return;
            }
            const bismillah = surah.num !== 1 && surah.num !== 9
                ? '<div class="mushaf-bismillah">بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ</div>' : '';

            const ayahsHtml = data.data.ayahs.map(a => {
                const num = toArabicNumeral(a.numberInSurah);
                return `<span class="mushaf-ayah-text">${a.text}</span><span class="mushaf-ayah-marker" aria-label="آية ${a.numberInSurah}"><span class="mushaf-marker-inner">${num}</span></span> `;
            }).join('');

            body.innerHTML = `${bismillah}<div id="surah-ayat-container" class="mushaf-text-body surah-text-body" dir="rtl">${ayahsHtml}</div>`;
        })
        .catch(() => {
            const body = document.getElementById('surah-reading-body');
            if (body) body.innerHTML = '<p class="text-red-400 text-center py-6">تعذر تحميل نص السورة - تحقق من الاتصال</p>';
        });
}

window.markSurahAsRead = async function (surahNum) {
    const surah = QURAN_SURAHS.find(s => s.num === surahNum);
    if (!surah) return;

    if (!appState.quranProgress) appState.quranProgress = {};
    if (!appState.quranProgress.quranReadProgress) appState.quranProgress.quranReadProgress = {};

    // تحديد جميع الصفحات في السورة كمقروءة
    for (let page = surah.startPage; page <= surah.endPage; page++) {
        appState.quranProgress.quranReadProgress[page] = true;
    }

    const today = getLocalDateString();
    if (!appState.quranProgress.dailyPages) appState.quranProgress.dailyPages = {};
    const pagesInSurah = surah.endPage - surah.startPage + 1;
    appState.quranProgress.dailyPages[today] = (appState.quranProgress.dailyPages[today] || 0) + pagesInSurah;

    await saveUserField('quranProgress', appState.quranProgress);
    await recalculateTotalPoints();
    await updateStreak(true);

    closeModal('surah-reading-modal');
    showToast(`✅ تم تسجيل ${pagesInSurah} صفحات من سورة ${surah.name}!`);
    renderQuran();
    refreshDashboard();
};

window.togglePageRead = async function (page) {
    if (!appState.quranProgress) appState.quranProgress = {};
    if (!appState.quranProgress.quranReadProgress) appState.quranProgress.quranReadProgress = {};

    const isCurrentlyRead = appState.quranProgress.quranReadProgress[page];
    appState.quranProgress.quranReadProgress[page] = !isCurrentlyRead;

    const today = getLocalDateString();
    if (!appState.quranProgress.dailyPages) appState.quranProgress.dailyPages = {};

    if (!isCurrentlyRead) {
        // تم تحديد الصفحة كمقروءة
        appState.quranProgress.dailyPages[today] = (appState.quranProgress.dailyPages[today] || 0) + 1;
    } else {
        // تم إزالة تحديد قراءة الصفحة
        appState.quranProgress.dailyPages[today] = Math.max(0, (appState.quranProgress.dailyPages[today] || 0) - 1);
    }

    await saveUserField('quranProgress', appState.quranProgress);
    await recalculateTotalPoints();
    if (!isCurrentlyRead) await updateStreak(true);

    renderQuran();
    refreshDashboard();
};

window.loadQuranAudio = function (reciterId) {
    const container = document.getElementById('quran-audio-content');
    if (!container) return;

    if (!reciterId) {
        container.innerHTML = '<p class="text-white/50 text-center py-6">اختر شيخاً لتحميل التسجيلات</p>';
        return;
    }

    const reciter = QURAN_RECITERS.find(r => r.id === reciterId);
    if (!reciter) return;

    const serverUrl = reciter.server;

    container.innerHTML = QURAN_SURAHS.map(surah => `
                <div class="bg-white/5 p-3 rounded-xl flex items-center justify-between hover:bg-white/10 transition">
                    <div class="flex-1">
                        <p class="font-bold text-sm">${surah.num}. ${escapeHtml(surah.name)}</p>
                    </div>
                    <button onclick="playQuranSurah(${surah.num}, '${serverUrl}', this)" class="bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 px-3 py-2 rounded-lg text-xs text-emerald-300 transition">
                        <i class="fas fa-play me-1"></i>استماع
                    </button>
                </div>`).join('');
};

// In-app Quran audio player with fallback
let quranAudioPlayer = null;

// Fallback audio sources (islamic.network CDN)

window.playQuranSurah = function (surahNum, serverUrl, btnEl) {
    // Stop if already playing
    if (quranAudioPlayer) {
        quranAudioPlayer.pause();
        quranAudioPlayer = null;
        document.querySelectorAll('.quran-playing').forEach(el => {
            el.classList.remove('quran-playing');
            el.innerHTML = '<i class="fas fa-play me-1"></i>استماع';
        });
        if (btnEl && btnEl.dataset.playing === 'true') {
            btnEl.dataset.playing = 'false';
            return;
        }
    }

    const surahPadded = String(surahNum).padStart(3, '0');
    const primaryUrl = `${serverUrl}/${surahPadded}.mp3`;

    // Find reciter ID for fallback
    const reciter = QURAN_RECITERS.find(r => r.server === serverUrl);
    const fallbackBase = reciter ? QURAN_AUDIO_FALLBACKS[reciter.id] : null;
    const fallbackUrl = fallbackBase ? `${fallbackBase}/${surahNum}.mp3` : null;

    function setPlaying() {
        if (btnEl) {
            btnEl.classList.add('quran-playing');
            btnEl.innerHTML = '<i class="fas fa-pause me-1"></i>إيقاف';
            btnEl.dataset.playing = 'true';
        }
        showToast(`تشغيل سورة ${QURAN_SURAHS[surahNum - 1]?.name || surahNum}`);
    }

    function setError() {
        if (btnEl) {
            btnEl.classList.remove('quran-playing');
            btnEl.innerHTML = '<i class="fas fa-play me-1"></i>استماع';
            btnEl.dataset.playing = 'false';
        }
        showToast('فشل تشغيل الصوت - جرب قارئاً آخر', 'error');
        quranAudioPlayer = null;
    }

    // Show loading state
    if (btnEl) {
        btnEl.innerHTML = '<i class="fas fa-spinner fa-spin me-1"></i>جاري التحميل...';
        btnEl.dataset.playing = 'true';
    }

    quranAudioPlayer = new Audio(primaryUrl);
    quranAudioPlayer.preload = 'auto';

    // Timeout: if no data after 8s, try fallback
    const loadTimeout = setTimeout(() => {
        if (quranAudioPlayer && quranAudioPlayer.readyState < 2) {
            console.warn('Primary audio timeout, trying fallback...');
            quranAudioPlayer.pause();
            if (fallbackUrl) {
                quranAudioPlayer.src = fallbackUrl;
                quranAudioPlayer.load();
            } else {
                setError();
            }
        }
    }, 8000);

    quranAudioPlayer.play().then(() => {
        clearTimeout(loadTimeout);
        setPlaying();
    }).catch(() => {
        clearTimeout(loadTimeout);
        // Try fallback
        if (fallbackUrl) {
            console.warn('Primary failed, trying fallback:', fallbackUrl);
            quranAudioPlayer.src = fallbackUrl;
            quranAudioPlayer.load();
            quranAudioPlayer.play().then(() => {
                setPlaying();
            }).catch(() => {
                setError();
            });
        } else {
            setError();
        }
    });

    quranAudioPlayer.onerror = function () {
        clearTimeout(loadTimeout);
        if (fallbackUrl && quranAudioPlayer && !quranAudioPlayer.src.includes('islamic.network')) {
            console.warn('Audio error, trying fallback...');
            quranAudioPlayer.src = fallbackUrl;
            quranAudioPlayer.load();
            quranAudioPlayer.play().then(() => setPlaying()).catch(() => setError());
        } else {
            setError();
        }
    };

    quranAudioPlayer.onended = function () {
        if (btnEl) {
            btnEl.classList.remove('quran-playing');
            btnEl.innerHTML = '<i class="fas fa-play me-1"></i>استماع';
            btnEl.dataset.playing = 'false';
        }
        quranAudioPlayer = null;
    };
};

window.saveMultipleQuranPages = async function () {
    const pages = parseInt(document.getElementById('quran-pages-count').value);
    if (isNaN(pages) || pages < 1 || pages > 604) { showToast('عدد الصفحات يجب بين 1 و 604', 'error'); return; }
    if (!appState.quranProgress) appState.quranProgress = { currentPage: 1, totalPagesRead: 0, totalKhatma: 0, dailyPages: {} };
    const today = getLocalDateString();
    if (!appState.quranProgress.dailyPages) appState.quranProgress.dailyPages = {};
    appState.quranProgress.dailyPages[today] = (appState.quranProgress.dailyPages[today] || 0) + pages;
    appState.quranProgress.currentPage = (appState.quranProgress.currentPage || 1) + pages;
    appState.quranProgress.totalPagesRead = (appState.quranProgress.totalPagesRead || 0) + pages;

    // FIX: protected while loop with reasonable max
    let khatmaAdded = 0;
    const maxKhatma = Math.ceil(pages / 604) + 1;
    while (appState.quranProgress.currentPage > 604 && khatmaAdded <= maxKhatma) {
        appState.quranProgress.currentPage -= 604;
        appState.quranProgress.totalKhatma = (appState.quranProgress.totalKhatma || 0) + 1;
        khatmaAdded++;
    }
    // safety clamp
    appState.quranProgress.currentPage = Math.max(1, Math.min(604, appState.quranProgress.currentPage));

    await saveUserField('quranProgress', appState.quranProgress);
    await recalculateTotalPoints();
    await updateStreak(true);
    closeModal('quran-pages-modal');
    document.getElementById('quran-pages-count').value = '1';
    renderQuran();
    refreshDashboard();

    const toastMsg = khatmaAdded > 0
        ? `🎉 تم إتمام ${khatmaAdded} ختمة! (${pages} صفحات)`
        : `تم تسجيل ${pages} صفحات ✅`;
    showToast(toastMsg);
};

window.setKhatmaGoal = async function (days) {
    if (!appState.settings) appState.settings = {};
    appState.settings.targetKhatmaDays = days;
    appState.settings.quranPagesPerDay = Math.ceil(604 / days);
    await saveUserField('settings', appState.settings);
    showToast(`تم ضبط هدف الختمة على ${days} يوم`);
    closeModal('khatma-goal-modal');
    renderQuran();
};

window.saveCustomKhatmaGoal = async function () {
    const days = parseInt(document.getElementById('custom-khatma-days').value);
    if (isNaN(days) || days < 1 || days > 365) { showToast('عدد الأيام يجب بين 1 و 365', 'error'); return; }
    await setKhatmaGoal(days);
};

function drawQuranWeeklyChart() {
    const canvas = document.getElementById('quranWeeklyChart');
    if (!canvas) return;
    const dailyPages = appState.quranProgress?.dailyPages || {};
    const labels = [], data = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const key = getLocalDateString(d);
        labels.push(d.toLocaleDateString('ar-EG', { weekday: 'short' }));
        data.push(dailyPages[key] || 0);
    }
    const goldColor = getComputedStyle(document.documentElement).getPropertyValue('--accent-gold').trim() || '#c9a84c';
    const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim();

    // Update in-place if chart already exists
    if (chartInstances['quranWeekly']) {
        const chart = chartInstances['quranWeekly'];
        chart.data.labels = labels;
        chart.data.datasets[0].data = data;
        chart.data.datasets[0].backgroundColor = goldColor;
        chart.data.datasets[0].borderColor = goldColor;
        chart.update('none');
        return;
    }
    chartInstances['quranWeekly'] = new Chart(canvas, {
        type: 'bar',
        data: { labels, datasets: [{ label: 'صفحات', data, backgroundColor: goldColor, borderColor: goldColor, borderWidth: 2, borderRadius: 6 }] },
        options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, grid: { color: 'rgba(200,170,78,0.1)' }, ticks: { color: textColor, stepSize: 1 } },
                x: { grid: { display: false }, ticks: { color: textColor } }
            }
        }
    });
}

// =========================================================================
//  المصحف الشريف
// =========================================================================
function renderMushaf() {
    const savedPage = appState.quranProgress?.currentPage || 1;
    currentMushafPage = Math.max(1, Math.min(604, savedPage));

    document.getElementById('screen-mushaf').innerHTML = `
        <div class="mushaf-wrapper">
            <div class="mushaf-top-bar">
                <div class="flex items-center gap-2">
                    <span class="text-xl">📖</span>
                    <h2 class="text-lg font-bold" style="color:var(--accent-gold)">المصحف الشريف</h2>
                </div>
                <div class="flex items-center gap-2">
                    <button onclick="toggleMushafNightMode()" class="mushaf-fullscreen-btn" title="وضع القراءة الليلية">
                        <i class="fas ${_mushafNightMode ? 'fa-sun' : 'fa-moon'}"></i>
                    </button>
                    <button onclick="toggleMushafFullscreen()" class="mushaf-fullscreen-btn" id="mushaf-fs-btn" title="شاشة كاملة">
                        <i class="fas fa-expand"></i>
                    </button>
                    <button onclick="prevMushafPage()" class="mushaf-nav-btn" title="الصفحة السابقة">
                        <i class="fas fa-chevron-right"></i>
                    </button>
                    <div class="mushaf-page-indicator">
                        <input type="number" id="mushaf-page-input" min="1" max="604" value="${currentMushafPage}"
                            class="mushaf-page-input" onkeydown="if(event.key==='Enter')goToMushafPage(this.value)">
                        <span style="opacity:0.5">/ ٦٠٤</span>
                    </div>
                    <button onclick="nextMushafPage()" class="mushaf-nav-btn" title="الصفحة التالية">
                        <i class="fas fa-chevron-left"></i>
                    </button>
                </div>
            </div>

            <div class="mushaf-page-container" id="mushaf-page-container">
                <div class="mushaf-page" id="mushaf-page-content">
                    <div class="text-center py-12">
                        <div class="spinner mx-auto" style="border-color:rgba(200,170,78,0.2);border-top-color:#c9a84c"></div>
                        <p class="mt-4" style="color:#5a4a20;opacity:0.7">جاري تحميل الصفحة...</p>
                    </div>
                </div>
            </div>

            <div class="mushaf-bottom-bar">
                <button onclick="prevMushafPage()" class="mushaf-nav-btn-lg">
                    <i class="fas fa-arrow-right"></i><span>السابقة</span>
                </button>
                <div class="mushaf-page-info">
                    <span id="mushaf-page-num">صفحة ${currentMushafPage}</span>
                    <span id="mushaf-juz-info" style="font-size:0.75rem;opacity:0.5">الجزء ${Math.ceil(currentMushafPage / 20)}</span>
                </div>
                <button onclick="nextMushafPage()" class="mushaf-nav-btn-lg">
                    <span>التالية</span><i class="fas fa-arrow-left"></i>
                </button>
            </div>
        </div>`;

    // Apply night mode class if enabled
    if (_mushafNightMode) {
        document.getElementById('screen-mushaf')?.classList.add('mushaf-night-mode');
    }

    loadMushafPage(currentMushafPage);
}

async function loadMushafPage(pageNum) {
    if (mushafLoading) return;
    mushafLoading = true;

    const container = document.getElementById('mushaf-page-content');
    if (!container) { mushafLoading = false; return; }

    // Check LRU cache first
    const cached = mushafCacheGet(pageNum);
    if (cached) {
        displayMushafPage(cached, pageNum);
        mushafLoading = false;
        return;
    }

    container.innerHTML = `<div class="text-center py-12">
        <div class="spinner mx-auto" style="border-color:rgba(200,170,78,0.2);border-top-color:#c9a84c"></div>
    </div>`;

    try {
        if (!rateLimitOk('mushaf_page', 1500)) { mushafLoading = false; return; }
        const res = await fetch(`https://api.alquran.cloud/v1/page/${pageNum}/quran-uthmani`);
        const data = await res.json();

        if (data.code === 200 && data.data && data.data.ayahs) {
            mushafCacheSet(pageNum, data.data.ayahs);
            displayMushafPage(data.data.ayahs, pageNum);
        } else {
            container.innerHTML = '<div class="text-center py-12" style="color:#a0522d">فشل تحميل الصفحة - حاول مرة أخرى</div>';
        }
    } catch (e) {
        container.innerHTML = '<div class="text-center py-12" style="color:#a0522d">فشل الاتصال - تحقق من الإنترنت</div>';
    }

    mushafLoading = false;

    // Prefetch adjacent pages
    if (pageNum < 604) prefetchMushafPage(pageNum + 1);
    if (pageNum > 1) prefetchMushafPage(pageNum - 1);
}

async function prefetchMushafPage(pageNum) {
    if (mushafPageCache.has(pageNum)) return;
    try {
        const res = await fetch(`https://api.alquran.cloud/v1/page/${pageNum}/quran-uthmani`);
        const data = await res.json();
        if (data.code === 200 && data.data && data.data.ayahs) {
            mushafCacheSet(pageNum, data.data.ayahs);
        }
    } catch (e) { /* silent prefetch */ }
}

function displayMushafPage(ayahs, pageNum) {
    const container = document.getElementById('mushaf-page-content');
    if (!container) return;

    let html = '';
    let currentSurahNum = null;

    ayahs.forEach(ayah => {
        if (ayah.surah.number !== currentSurahNum) {
            currentSurahNum = ayah.surah.number;
            // Decorative surah header banner
            html += `<div class="mushaf-surah-header">
                <span class="mushaf-surah-ornament">❁</span>
                <span class="mushaf-surah-name">${escapeHtml(ayah.surah.name)}</span>
                <span class="mushaf-surah-ornament">❁</span>
            </div>`;
            if (currentSurahNum !== 1 && currentSurahNum !== 9) {
                html += '<div class="mushaf-bismillah">بِسْمِ ٱللَّهِ ٱلرَّحْمَـٰنِ ٱلرَّحِيمِ</div>';
            }
        }
        // Ayah text with decorative end-of-ayah marker (Medina Mushaf style)
        const num = toArabicNumeral(ayah.numberInSurah);
        html += `<span class="mushaf-ayah-text">${ayah.text}</span><span class="mushaf-ayah-marker" aria-label="آية ${ayah.numberInSurah}"><span class="mushaf-marker-inner">${num}</span></span> `;
    });

    container.innerHTML = `<div class="mushaf-text-body" dir="rtl">${html}</div>`;

    // Update indicators
    const pn = document.getElementById('mushaf-page-num');
    const ji = document.getElementById('mushaf-juz-info');
    const pi = document.getElementById('mushaf-page-input');
    if (pn) pn.textContent = `صفحة ${pageNum}`;
    if (ji) ji.textContent = `الجزء ${Math.ceil(pageNum / 20)}`;
    if (pi) pi.value = pageNum;

    // Save progress
    if (appState.quranProgress) {
        appState.quranProgress.currentPage = pageNum;
        saveUserField('quranProgress.currentPage', pageNum);
    }
}

function toArabicNumeral(num) {
    const digits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
    return num.toString().split('').map(d => digits[parseInt(d)]).join('');
}

window.nextMushafPage = function () {
    if (currentMushafPage < 604) {
        currentMushafPage++;
        loadMushafPage(currentMushafPage);
        const c = document.getElementById('mushaf-page-container');
        if (c) c.scrollTop = 0;
    }
};

window.prevMushafPage = function () {
    if (currentMushafPage > 1) {
        currentMushafPage--;
        loadMushafPage(currentMushafPage);
        const c = document.getElementById('mushaf-page-container');
        if (c) c.scrollTop = 0;
    }
};

window.goToMushafPage = function (val) {
    const page = parseInt(val);
    if (isNaN(page) || page < 1 || page > 604) {
        showToast('أدخل رقم صفحة صحيح (1-604)', 'error');
        return;
    }
    currentMushafPage = page;
    loadMushafPage(page);
    const c = document.getElementById('mushaf-page-container');
    if (c) c.scrollTop = 0;
};

window.toggleMushafFullscreen = function () {
    const screen = document.getElementById('screen-mushaf');
    if (!screen) return;
    const isFS = screen.classList.toggle('mushaf-fullscreen');
    const btn = document.getElementById('mushaf-fs-btn');
    if (btn) btn.innerHTML = isFS ? '<i class="fas fa-compress"></i>' : '<i class="fas fa-expand"></i>';
    // Hide/show nav bars when fullscreen
    const header = document.querySelector('header');
    const sidebar = document.querySelector('.desktop-sidebar');
    const bottomNav = document.querySelector('.mobile-bottom-nav');
    if (header) header.style.display = isFS ? 'none' : '';
    if (sidebar) sidebar.style.display = isFS ? 'none' : '';
    if (bottomNav) bottomNav.style.display = isFS ? 'none' : '';
    // ESC key to exit
    if (isFS) {
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                screen.classList.remove('mushaf-fullscreen');
                if (btn) btn.innerHTML = '<i class="fas fa-expand"></i>';
                if (header) header.style.display = '';
                if (sidebar) sidebar.style.display = '';
                if (bottomNav) bottomNav.style.display = '';
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    }
};

// Add touch swipe support for mushaf
(function () {
    let touchStartX = 0;
    let touchEndX = 0;
    document.addEventListener('touchstart', function (e) {
        const mc = document.getElementById('mushaf-page-container');
        if (mc && mc.contains(e.target)) {
            touchStartX = e.changedTouches[0].screenX;
        }
    }, { passive: true });
    document.addEventListener('touchend', function (e) {
        const mc = document.getElementById('mushaf-page-container');
        if (mc && mc.contains(e.target)) {
            touchEndX = e.changedTouches[0].screenX;
            const diff = touchStartX - touchEndX;
            if (Math.abs(diff) > 60) {
                // RTL: swipe left (diff>0) = previous, swipe right (diff<0) = next
                if (diff > 0) { window.prevMushafPage(); }
                else { window.nextMushafPage(); }
            }
        }
    }, { passive: true });
})();

// =========================================================================
//  التحليل
// =========================================================================
function renderAnalysis() {
    document.getElementById('screen-analysis').innerHTML = `
        <div class="card p-5">
            <div class="flex items-center gap-3 mb-5"><span class="text-3xl">📈</span><h2 class="text-2xl font-bold text-gold">التحليل والإحصاءات</h2></div>
            <div class="flex gap-2 mb-5 flex-wrap">
                <button onclick="changeAnalysisPeriod('week')" id="period-week" class="px-4 py-2 rounded-full bg-gold-soft text-white border border-gold/50 text-sm">أسبوعي</button>
                <button onclick="changeAnalysisPeriod('month')" id="period-month" class="px-4 py-2 rounded-full bg-white/10 text-white/60 hover:bg-white/20 text-sm">شهري</button>
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
                <div class="bg-white/5 p-4 rounded-xl text-center"><p class="text-white/60 text-sm">إجمالي الأذكار اليوم</p><p class="text-3xl font-bold text-gold">${getTotalCompletedAzkar()}</p></div>
                <div class="bg-white/5 p-4 rounded-xl text-center"><p class="text-white/60 text-sm">الصلوات المكتملة</p><p class="text-3xl font-bold text-gold">${getTotalCompletedPrayers()}</p></div>
                <div class="bg-white/5 p-4 rounded-xl text-center"><p class="text-white/60 text-sm">إجمالي صفحات القرآن</p><p class="text-3xl font-bold text-gold">${appState.quranProgress?.totalPagesRead || 0}</p></div>
            </div>
            <div class="mt-5"><canvas id="analysisChart" height="80"></canvas></div>
        </div>`;
    drawAnalysisChart('week');
}

window.changeAnalysisPeriod = function (period) {
    ['week', 'month'].forEach(p => {
        const btn = document.getElementById(`period-${p}`);
        if (!btn) return;
        btn.className = p === period
            ? 'px-4 py-2 rounded-full bg-gold-soft text-white border border-gold/50 text-sm'
            : 'px-4 py-2 rounded-full bg-white/10 text-white/60 hover:bg-white/20 text-sm';
    });
    drawAnalysisChart(period);
};

function getTotalCompletedAzkar() {
    return Object.values(appState.adhkarProgress || {}).reduce((a, b) => a + (b || 0), 0);
}
function getTotalCompletedPrayers() {
    let total = 0;
    Object.values(appState.prayerLogs || {}).forEach(day =>
        ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'].forEach(p => {
            if (day[p]?.status && day[p].status !== 'missed') total++;
        }));
    return total;
}

function drawAnalysisChart(period) {
    const canvas = document.getElementById('analysisChart');
    if (!canvas) return;

    let labels, azkarData, prayerData, quranData;

    if (period === 'week') {
        labels = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(); d.setDate(d.getDate() - i);
            labels.push(d.toLocaleDateString('ar-EG', { weekday: 'short' }));
        }
        azkarData = getWeeklyAzkarData();
        prayerData = getWeeklyPrayerData();
        quranData = getWeeklyQuranData();
    } else {
        labels = ['الأسبوع 1', 'الأسبوع 2', 'الأسبوع 3', 'الأسبوع 4'];
        const dailyPages = appState.quranProgress?.dailyPages || {};
        const prayerLogs = appState.prayerLogs || {};
        const adhkarHistory = appState.adhkarHistory || {};
        azkarData = [0, 0, 0, 0]; prayerData = [0, 0, 0, 0]; quranData = [0, 0, 0, 0];
        for (let i = 27; i >= 0; i--) {
            const d = new Date(); d.setDate(d.getDate() - i);
            const key = getLocalDateString(d);
            const weekIndex = Math.min(3, Math.floor(i / 7));
            const wi = 3 - weekIndex;
            quranData[wi] += dailyPages[key] || 0;
            if (i === 0) azkarData[wi] += calculateTodayAdhkarPoints();
            else azkarData[wi] += adhkarHistory[key] || 0;
            if (prayerLogs[key]) {
                prayerData[wi] += ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']
                    .filter(p => prayerLogs[key][p]?.status && prayerLogs[key][p].status !== 'missed').length;
            }
        }
    }

    const goldColor = getComputedStyle(document.documentElement).getPropertyValue('--accent-gold').trim() || '#c9a84c';
    const textPrimary = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim();
    const textSecondary = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim();

    // Update in-place if chart already exists
    if (chartInstances['analysis']) {
        const chart = chartInstances['analysis'];
        chart.data.labels = labels;
        chart.data.datasets[0].data = azkarData;
        chart.data.datasets[1].data = prayerData;
        chart.data.datasets[2].data = quranData;
        chart.update('none');
        return;
    }

    chartInstances['analysis'] = new Chart(canvas, {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'الأذكار', data: azkarData, borderColor: goldColor, backgroundColor: 'rgba(200,170,78,0.1)', tension: 0.3, fill: true },
                { label: 'الصلوات', data: prayerData, borderColor: '#4ade80', backgroundColor: 'rgba(74,222,128,0.1)', tension: 0.3, fill: true },
                { label: 'القرآن (صفحات)', data: quranData, borderColor: '#60a5fa', backgroundColor: 'rgba(96,165,250,0.1)', tension: 0.3, fill: true }
            ]
        },
        options: {
            responsive: true,
            plugins: { legend: { labels: { color: textPrimary, font: { size: 12 } } } },
            scales: {
                y: { beginAtZero: true, grid: { color: 'rgba(200,170,78,0.1)' }, ticks: { color: textSecondary } },
                x: { grid: { display: false }, ticks: { color: textSecondary } }
            }
        }
    });
}

// =========================================================================
//  البودكاستات
// =========================================================================
function renderPodcasts() {
    const customPodcasts = appState.customPodcasts || [];
    document.getElementById('screen-podcasts').innerHTML = `
        <div class="card p-5">
            <div class="flex items-center gap-3 mb-5"><span class="text-3xl">🎙️</span><h2 class="text-2xl font-bold text-gold">البودكاستات الإسلامية</h2></div>
            <button onclick="openModal('add-podcast-modal')" class="mb-5 w-full bg-white/10 hover:bg-white/20 border border-dashed border-gold/50 rounded-xl py-3 text-white/80 transition">
                <i class="fas fa-plus me-1"></i>إضافة بودكاست مخصص
            </button>
            <h3 class="text-lg font-bold text-gold mb-3">القنوات المختارة</h3>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                ${DEFAULT_PODCASTS.map(pod => `
                    <div class="podcast-card">
                        <div class="podcast-icon"><i class="fas ${pod.icon}"></i></div>
                        <div class="flex-1 min-w-0">
                            <h3 class="font-bold text-gold truncate">${escapeHtml(pod.name)}</h3>
                            <p class="text-[var(--text-muted)] text-sm">قناة يوتيوب</p>
                        </div>
                        <a href="${safeUrl(pod.url)}" target="_blank" rel="noopener noreferrer" aria-label="فتح قناة ${escapeHtml(pod.name)}">
                            <i class="fas fa-external-link-alt text-gold"></i>
                        </a>
                    </div>`).join('')}
            </div>
            ${customPodcasts.length ? `
                <h3 class="text-lg font-bold text-gold mb-3">قنواتي المخصصة</h3>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    ${customPodcasts.map(pod => `
                        <div class="podcast-card">
                            <div class="podcast-icon"><i class="fas ${escapeHtml(pod.icon)}"></i></div>
                            <div class="flex-1 min-w-0">
                                <h3 class="font-bold text-gold truncate">${escapeHtml(pod.name)}</h3>
                                <p class="text-[var(--text-muted)] text-sm">مخصص</p>
                            </div>
                            <div class="flex items-center gap-2 flex-shrink-0">
                                <a href="${safeUrl(pod.url)}" target="_blank" rel="noopener noreferrer" aria-label="فتح القناة">
                                    <i class="fas fa-external-link-alt text-gold"></i>
                                </a>
                                <button onclick="deleteCustomPodcast('${escapeHtml(pod.id)}')" class="text-red-400 hover:text-red-300" aria-label="حذف البودكاست">
                                    <i class="fas fa-trash-alt"></i>
                                </button>
                            </div>
                        </div>`).join('')}
                </div>` : ''}
        </div>`;
}

window.saveCustomPodcast = async function () {
    const name = document.getElementById('podcast-name').value.trim();
    const url = document.getElementById('podcast-url').value.trim();
    const icon = document.getElementById('podcast-icon').value;
    if (!name || !url) { showToast('الرجاء إدخال الاسم والرابط', 'error'); return; }
    // FIX: proper URL validation
    if (!url.startsWith('https://') && !url.startsWith('http://')) {
        showToast('الرابط يجب أن يبدأ بـ https://', 'error'); return;
    }
    try { new URL(url); } catch { showToast('الرابط غير صحيح', 'error'); return; }
    if (!appState.customPodcasts) appState.customPodcasts = [];
    appState.customPodcasts.push({ id: generateId('pod'), name, url, icon });
    await saveUserField('customPodcasts', appState.customPodcasts);
    showToast('تم إضافة البودكاست');
    closeModal('add-podcast-modal');
    document.getElementById('podcast-name').value = '';
    document.getElementById('podcast-url').value = '';
    renderPodcasts();
};

window.deleteCustomPodcast = async function (id) {
    showConfirm('هل تريد حذف هذا البودكاست؟', async () => {
        appState.customPodcasts = (appState.customPodcasts || []).filter(p => p.id !== id);
        await saveUserField('customPodcasts', appState.customPodcasts);
        renderPodcasts();
        showToast('تم الحذف');
    });
};

// =========================================================================
//  يومياتي
// =========================================================================
function renderJournal() {
    document.getElementById('screen-journal').innerHTML = `
        <div class="card p-5">
            <div class="flex items-center gap-3 mb-5"><span class="text-3xl">📔</span><h2 class="text-2xl font-bold text-gold">يومياتي</h2></div>
            <div class="bg-white/5 p-5 rounded-xl mb-5">
                <h3 class="text-xl font-bold mb-4">كيف كان يومك؟</h3>
                <div class="flex justify-center gap-3 sm:gap-5 mb-5">
                    ${[['great', '🤩', 'ممتاز'], ['happy', '😊', 'سعيد'], ['neutral', '😐', 'عادي'], ['sad', '😔', 'حزين'], ['terrible', '😢', 'سيء']].map(([m, e, l]) => `
                        <button onclick="setMood('${m}',this)" data-mood="${m}" class="mood-btn flex flex-col items-center p-2 sm:p-3 rounded-xl hover:bg-white/10 transition border-2 border-transparent">
                            <span class="text-4xl sm:text-5xl mb-1">${e}</span>
                            <span class="text-white/70 text-xs sm:text-sm">${l}</span>
                        </button>`).join('')}
                </div>
                <input type="hidden" id="selected-mood" value="">
                <textarea id="journal-note" rows="3" class="resize-none" placeholder="اكتب ملاحظاتك..."></textarea>
                <button onclick="saveJournalEntry()" class="mt-4 w-full bg-gradient-islamic border border-gold text-gold font-bold py-3 rounded-xl transition ripple-btn">
                    <i class="fas fa-save me-1"></i>حفظ اليوميات
                </button>
            </div>
            <!-- Mini Calendar View -->
            <div class="mb-5">
                <h3 class="text-lg font-bold mb-3">📅 تقويم الحالة</h3>
                <div class="grid grid-cols-7 gap-1" id="journal-calendar"></div>
            </div>
            <div><h3 class="text-xl font-bold mb-3">السجل (آخر 14 يوم)</h3><div id="journal-history" class="space-y-3"></div></div>
        </div>`;
    renderJournalHistory();
    renderJournalCalendar();
}

window.setMood = function (mood, btn) {
    document.getElementById('selected-mood').value = mood;
    document.querySelectorAll('.mood-btn').forEach(b => {
        b.classList.remove('border-gold', 'bg-white/10');
    });
    btn.classList.add('border-gold', 'bg-white/10');
};

window.saveJournalEntry = async function () {
    const mood = document.getElementById('selected-mood').value;
    if (!mood) { showToast('الرجاء اختيار مزاجك اليوم', 'error'); return; }
    const note = document.getElementById('journal-note').value.trim();
    const today = getLocalDateString();
    if (!appState.journal) appState.journal = [];
    const existing = appState.journal.find(e => e.date === today);
    if (existing) {
        showConfirm('يوجد تسجيل لهذا اليوم بالفعل، هل تريد استبداله؟', async () => {
            await doSaveJournal(mood, note, today);
        });
    } else {
        await doSaveJournal(mood, note, today);
    }
};

async function doSaveJournal(mood, note, today) {
    appState.journal = appState.journal.filter(e => e.date !== today);
    // FIX: limit journal to last 90 days to prevent Firestore doc bloat
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
    const cutoffStr = getLocalDateString(cutoff);
    appState.journal = appState.journal.filter(e => e.date >= cutoffStr);
    appState.journal.push({ date: today, mood, note });
    // FIX: save each entry individually to avoid sending full array each time
    await saveUserField('journal', appState.journal);
    await saveToSubcollection('journal', today, { date: today, mood, note });
    showToast('تم حفظ اليوميات');
    renderJournalHistory();
    document.getElementById('journal-note').value = '';
    document.getElementById('selected-mood').value = '';
    document.querySelectorAll('.mood-btn').forEach(b => b.classList.remove('border-gold', 'bg-white/10'));
}

function renderJournalHistory() {
    const container = document.getElementById('journal-history');
    if (!container) return;
    const last14 = [...(appState.journal || [])].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 14);
    const icons = { great: '🤩', happy: '😊', neutral: '😐', sad: '😔', terrible: '😢' };
    container.innerHTML = last14.length ? last14.map(e => `
        <div class="bg-white/5 p-4 rounded-xl flex items-start gap-3">
            <span class="text-3xl">${icons[e.mood] || '📝'}</span>
            <div class="flex-1 min-w-0">
                <p class="text-white/70 font-bold">${escapeHtml(e.date)}</p>
                <p class="text-white/55 text-sm mt-0.5">${escapeHtml(e.note) || 'لا توجد ملاحظات'}</p>
            </div>
        </div>`).join('') : '<p class="text-white/50 text-center py-5">لا توجد يوميات بعد</p>';
}

function renderJournalCalendar() {
    const cal = document.getElementById('journal-calendar');
    if (!cal) return;
    const icons = { great: '🤩', happy: '😊', neutral: '😐', sad: '😔', terrible: '😢' };
    const entries = {};
    (appState.journal || []).forEach(e => entries[e.date] = e.mood);
    let html = '';
    for (let i = 29; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const ds = getLocalDateString(d);
        const mood = entries[ds];
        html += `<div class="text-center p-1 rounded ${mood ? 'bg-gold/10' : 'bg-white/5'}" title="${ds}">
            <span class="text-xs block text-white/30">${d.getDate()}</span>
            <span class="text-sm">${mood ? icons[mood] : '·'}</span>
        </div>`;
    }
    cal.innerHTML = html;
}

// =========================================================================
//  المكافآت
// =========================================================================
function renderRewards() {
    const level = appState.level || 1;
    const pointsInLevel = (appState.totalPoints || 0) % 100;
    const totalPrayers = getTotalCompletedPrayers();
    const totalKhatma = appState.quranProgress?.totalKhatma || 0;
    const badgesConfig = [
        { emoji: '🌱', label: '7 أيام متتالية', condition: appState.streak >= 7, progress: Math.min(appState.streak, 7), max: 7 },
        { emoji: '🌿', label: '30 يوم متتالية', condition: appState.streak >= 30, progress: Math.min(appState.streak, 30), max: 30 },
        { emoji: '🌳', label: '90 يوم متتالية', condition: appState.streak >= 90, progress: Math.min(appState.streak, 90), max: 90 },
        { emoji: '🏔️', label: 'سنة كاملة', condition: appState.streak >= 365, progress: Math.min(appState.streak, 365), max: 365 },
        { emoji: '📖', label: 'أول ختمة', condition: totalKhatma >= 1, progress: Math.min(totalKhatma, 1), max: 1 },
        { emoji: '📚', label: '3 ختمات', condition: totalKhatma >= 3, progress: Math.min(totalKhatma, 3), max: 3 },
        { emoji: '🕌', label: '100 صلاة', condition: totalPrayers >= 100, progress: Math.min(totalPrayers, 100), max: 100 },
        { emoji: '⭐', label: '500 نقطة', condition: (appState.totalPoints || 0) >= 500, progress: Math.min(appState.totalPoints || 0, 500), max: 500 },
        { emoji: '💎', label: '1000 نقطة', condition: (appState.totalPoints || 0) >= 1000, progress: Math.min(appState.totalPoints || 0, 1000), max: 1000 },
        { emoji: '🔥', label: 'المستوى 10', condition: level >= 10, progress: Math.min(level, 10), max: 10 }
    ];

    const levelNames = ['مبتدئ', 'مجتهد', 'منطلق', 'مثابر', 'متميز', 'رائع', 'بارع', 'خبير', 'متفوق', 'أسطوري'];
    const levelName = levelNames[Math.min(level - 1, levelNames.length - 1)] || 'مبتدئ';

    document.getElementById('screen-rewards').innerHTML = `
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div class="card p-5 text-center glass-card"><i class="fas fa-star text-4xl text-gold mb-2"></i><p class="text-white/60 text-sm">النقاط الكلية</p><span class="text-4xl font-bold text-gold">${appState.totalPoints}</span></div>
            <div class="card p-5 text-center glass-card">
                <i class="fas fa-level-up-alt text-4xl text-gold mb-2"></i>
                <p class="text-white/60 text-sm">المستوى</p>
                <span class="text-4xl font-bold text-gold">${level}</span>
                <span class="text-sm block text-gold/70 mt-1">${levelName}</span>
                <div class="progress-bar mt-2"><div class="progress-fill" style="width:${pointsInLevel}%"></div></div>
                <span class="text-xs text-white/40 mt-1">${100 - pointsInLevel} نقطة للتالي</span>
            </div>
            <div class="card p-5 text-center glass-card"><i class="fas fa-fire text-4xl text-gold mb-2"></i><p class="text-white/60 text-sm">أيام متتالية</p><span class="text-4xl font-bold text-gold">${appState.streak}</span></div>
        </div>
        <div class="card p-5">
            <h3 class="font-bold text-xl mb-4 text-gold">🏅 الأوسمة</h3>
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
                ${badgesConfig.map(b => {
        const pct = Math.round((b.progress / b.max) * 100);
        return `<div class="p-4 rounded-xl border-2 text-center transition ${b.condition ? 'bg-gold-soft border-gold badge-unlocked' : 'bg-white/5 border-white/10 badge-locked'}">
                        <div class="text-3xl mb-1 ${b.condition ? '' : 'grayscale opacity-40'}">${b.emoji}</div>
                        <div class="text-sm ${b.condition ? 'text-gold font-bold' : 'text-white/50'}">${escapeHtml(b.label)}</div>
                        ${b.condition
                ? '<div class="text-green-400 text-xs mt-1"><i class="fas fa-check-circle"></i> محقق</div>'
                : `<div class="progress-bar mt-2"><div class="progress-fill" style="width:${pct}%"></div></div><span class="text-xs text-white/30">${b.progress}/${b.max}</span>`}
                    </div>`;
    }).join('')}
            </div>
        </div>`;
}

// =========================================================================
//  التذكيرات
// =========================================================================
function renderReminders() {
    document.getElementById('screen-reminders').innerHTML = `
        <div class="card p-5">
            <div class="flex items-center gap-3 mb-5"><span class="text-3xl">⏰</span><h2 class="text-2xl font-bold text-gold">التذكيرات</h2></div>
            <button onclick="openReminderModal()" class="w-full bg-white/10 hover:bg-white/20 border border-dashed border-gold/50 rounded-xl py-4 text-white/80 transition mb-5">
                <i class="fas fa-plus me-1"></i>إضافة تذكير جديد
            </button>
            <div id="reminders-list" class="space-y-3"></div>
        </div>`;
    renderRemindersList();
}

window.openReminderModal = function () {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => { });
    }
    openModal('reminder-modal');
};

window.saveReminder = async function () {
    const dhikr = document.getElementById('reminder-dhikr').value;
    const time = document.getElementById('reminder-time').value;
    if (!time) { showToast('الرجاء اختيار الوقت', 'error'); return; }
    if (!appState.reminders) appState.reminders = [];
    appState.reminders.push({ id: generateId('rem'), dhikr, time });
    await saveUserField('reminders', appState.reminders);
    showToast('تم إضافة التذكير');
    closeModal('reminder-modal');
    document.getElementById('reminder-time').value = '';
    renderRemindersList();
};

function renderRemindersList() {
    const container = document.getElementById('reminders-list');
    if (!container) return;
    const reminders = (appState.reminders || []).slice().sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    if (!reminders.length) { container.innerHTML = '<div class="text-center py-8"><span class="text-4xl block mb-2">🔔</span><p class="text-white/50">لا توجد تذكيرات</p><p class="text-white/30 text-sm">أضف تذكيراً لتنبيهك بأوقات الأذكار</p></div>'; return; }
    const dhikrNames = { morning: 'الصباح', evening: 'المساء', night: 'النوم', afterprayer: 'بعد الصلاة', custom: 'أذكاري' };
    const dhikrIcons = { morning: '🌅', evening: '🌇', night: '🌙', afterprayer: '🕌', custom: '📿' };
    const dhikrColors = { morning: 'border-yellow-500/30', evening: 'border-orange-500/30', night: 'border-blue-500/30', afterprayer: 'border-green-500/30', custom: 'border-gold/30' };
    container.innerHTML = reminders.map(rem => `
        <div class="bg-white/5 p-4 rounded-xl flex items-center justify-between border ${dhikrColors[rem.dhikr] || 'border-white/10'}">
            <div class="flex items-center gap-3">
                <span class="text-2xl">${dhikrIcons[rem.dhikr] || '🔔'}</span>
                <div>
                    <p class="font-bold">${escapeHtml(dhikrNames[rem.dhikr] || rem.dhikr)}</p>
                    <p class="text-white/50 text-sm">⏰ ${escapeHtml(rem.time)}</p>
                </div>
            </div>
            <button onclick="deleteReminder('${escapeHtml(rem.id)}')" class="text-red-400 hover:text-red-300 text-base p-2" aria-label="حذف التذكير">
                <i class="fas fa-trash-alt"></i>
            </button>
        </div>`).join('');
}

window.deleteReminder = async function (id) {
    showConfirm('هل تريد حذف هذا التذكير؟', async () => {
        appState.reminders = (appState.reminders || []).filter(r => r.id !== id);
        await saveUserField('reminders', appState.reminders);
        renderRemindersList();
        showToast('تم الحذف');
    });
};

// FIX: reminder checker runs every 30s but tracks per-minute to avoid missing
function startReminderChecker() {
    if (reminderIntervalId) clearInterval(reminderIntervalId);
    let lastNotifiedMinute = '';
    reminderIntervalId = setInterval(() => {
        if (!appState?.reminders) return;
        const now = new Date();
        // FIX: check within the current minute window
        const currentMinute = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
        if (currentMinute === lastNotifiedMinute) return;
        appState.reminders.forEach(rem => {
            if (rem.time === currentMinute) {
                const name = { morning: 'الصباح', evening: 'المساء', night: 'النوم', afterprayer: 'بعد الصلاة', custom: 'المخصصة' }[rem.dhikr] || rem.dhikr;
                showToast(`🔔 حان وقت أذكار ${name}`, 'warning');
                showBrowserNotification('نفسي - تذكير', `حان وقت أذكار ${name}`);
            }
        });
        lastNotifiedMinute = currentMinute;
    }, 15000); // FIX: check every 15 seconds to be safer
}

// =========================================================================
//  حاسبة الزكاة
// =========================================================================
function renderZakat() {
    document.getElementById('screen-zakat').innerHTML = `
    <div class="card p-5">
        <div class="flex items-center gap-3 mb-5"><span class="text-3xl">💰</span><h2 class="text-2xl font-bold text-gold">حاسبة الزكاة</h2></div>
        
        <div class="bg-white/5 p-5 rounded-xl mb-5">
            <h3 class="text-lg font-bold text-gold mb-4">حساب زكاة المال</h3>
            
            <div class="space-y-4 mb-6">
                <div>
                    <label class="block mb-2 text-sm">الذهب بالجرام</label>
                    <input type="number" id="zakat-gold" min="0" step="0.1" placeholder="0" value="0">
                </div>
                <div>
                    <label class="block mb-2 text-sm">الفضة بالجرام</label>
                    <input type="number" id="zakat-silver" min="0" step="0.1" placeholder="0" value="0">
                </div>
                <div>
                    <label class="block mb-2 text-sm">النقود (بالدولار أو سعر الذهب)</label>
                    <input type="number" id="zakat-money" min="0" step="0.01" placeholder="0" value="0">
                </div>
                <div>
                    <label class="block mb-2 text-sm">سعر الذهب (دولار/جرام)</label>
                    <input type="number" id="gold-price" min="0" step="0.01" placeholder="70" value="70">
                </div>
            </div>
            
            <button onclick="calculateZakat()" class="w-full bg-gradient-islamic border border-gold text-gold font-bold py-3 rounded-xl transition mb-4">
                <i class="fas fa-calculator me-1"></i>احسب الزكاة
            </button>
            
            <div id="zakat-result" class="bg-gold-soft border border-gold/50 rounded-xl p-4 text-center hidden">
                <p class="text-white/60 text-sm mb-2">الزكاة المستحقة</p>
                <p class="text-4xl font-bold text-gold" id="zakat-amount">0</p>
                <p class="text-white/50 text-sm mt-2">دولار</p>
                <p class="text-white/40 text-xs mt-2">معدل الزكاة: 2.5%</p>
            </div>
        </div>
        
        <div class="bg-white/5 p-4 rounded-xl text-sm text-white/70 space-y-2">
            <p><strong>📌 ملاحظات:</strong></p>
            <p>• الزكاة على المال: 2.5% من المال النقي</p>
            <p>• النصاب: 85 جرام ذهب أو 595 جرام فضة</p>
            <p>• يتم دفع الزكاة بعد حول قمري كامل</p>
        </div>
    </div>`;
}

window.calculateZakat = function () {
    const gold = parseFloat(document.getElementById('zakat-gold').value) || 0;
    const silver = parseFloat(document.getElementById('zakat-silver').value) || 0;
    const money = parseFloat(document.getElementById('zakat-money').value) || 0;
    const goldPrice = parseFloat(document.getElementById('gold-price').value) || 70;

    const goldValue = gold * goldPrice;
    const silverValue = silver * (goldPrice / 10); // Silver is roughly 1/10 the price
    const totalValue = goldValue + silverValue + money;

    const nussab = 85 * goldPrice; // 85 grams gold
    const zakatAmount = totalValue >= nussab ? (totalValue * 0.025) : 0;

    const resultDiv = document.getElementById('zakat-result');
    document.getElementById('zakat-amount').innerText = zakatAmount.toFixed(2);
    resultDiv.classList.remove('hidden');
};

// =========================================================================
//  أوقات الأذان
// =========================================================================

let currentAdhanAudio = null;
let adhanAudioCtx = null;

// Fallback: Generate a pleasant notification tone via Web Audio API
function playNotificationTone() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        adhanAudioCtx = ctx;
        const notes = [523.25, 659.25, 783.99, 659.25, 523.25]; // C5 E5 G5 E5 C5
        const durations = [0.4, 0.4, 0.6, 0.4, 0.8];
        let time = ctx.currentTime;

        notes.forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, time);
            gain.gain.setValueAtTime(0.25, time);
            gain.gain.exponentialRampToValueAtTime(0.01, time + durations[i] - 0.05);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(time);
            osc.stop(time + durations[i]);
            time += durations[i];
        });
    } catch (e) { /* silent */ }
}

function renderAdhan() {
    const adhanTimes = {
        'Fajr': 'الفجر',
        'Dhuhr': 'الظهر',
        'Asr': 'العصر',
        'Maghrib': 'المغرب',
        'Isha': 'العشاء'
    };

    let adhanHtml = `
    <div class="space-y-5">
        <div class="card p-5">
            <div class="flex items-center gap-3 mb-5"><span class="text-3xl">🔔</span><h2 class="text-2xl font-bold text-gold">أوقات الأذان</h2></div>
            <div id="adhan-times-container" class="space-y-3">
                <div class="text-center py-6"><div class="spinner mx-auto"></div><p class="mt-2 text-sm">جاري تحميل أوقات الأذان...</p></div>
            </div>
        </div>
        
        <div class="card p-5 bg-gradient-to-br from-[var(--accent-gold)]/10 to-transparent border-2 border-gold/40">
            <h3 class="text-lg font-bold text-gold mb-4">🎵 الأذان</h3>
            <div class="flex flex-wrap gap-3">
                ${Object.keys(adhanTimes).map(key => `
                    <button onclick="playAdhan('${key}')" class="flex-1 min-w-32 bg-gradient-islamic hover:from-[#1c4e3a] hover:to-[#2d6b52] border border-gold/50 text-gold font-bold py-3 rounded-xl transition transform hover:scale-105">
                        <i class="fas fa-play me-2"></i>الأذان: ${adhanTimes[key]}
                    </button>
                `).join('')}
            </div>
            <button id="stop-adhan-btn" onclick="stopAdhan()" class="w-full mt-3 bg-red-600/30 hover:bg-red-600/50 border border-red-600/50 text-red-400 font-bold py-2 rounded-xl transition hidden">
                <i class="fas fa-stop me-2"></i>إيقاف
            </button>
        </div>
    </div>`;

    document.getElementById('screen-adhan').innerHTML = adhanHtml;

    if (prayerTimesCache) {
        let timesHtml = '';
        Object.keys(adhanTimes).forEach(key => {
            const time = prayerTimesCache[key];
            const arabicName = adhanTimes[key];
            if (time && time !== '--:--') {
                timesHtml += `
                <div class="bg-white/5 border border-white/10 rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap">
                    <div class="flex-1 min-w-32">
                        <p class="font-bold text-gold">${arabicName}</p>
                        <p class="text-white/50 text-sm">الوقت</p>
                    </div>
                    <div class="text-right">
                        <p class="text-2xl font-mono text-gold">${time}</p>
                    </div>
                    <div class="flex gap-2 flex-shrink-0">
                        <button onclick="playAdhan('${key}')" class="bg-gold-soft hover:bg-gold-soft border border-gold/50 px-3 py-2 rounded-lg text-gold transition text-sm">
                            <i class="fas fa-play me-1"></i>تشغيل
                        </button>
                        <button onclick="setAdhanReminder('${arabicName}', '${time}')" class="bg-blue-600/20 hover:bg-blue-600/30 border border-blue-600/50 px-3 py-2 rounded-lg text-blue-400 transition text-sm">
                            <i class="fas fa-bell me-1"></i>تذكير
                        </button>
                    </div>
                </div>`;
            }
        });

        if (timesHtml) {
            document.getElementById('adhan-times-container').innerHTML = timesHtml;
        } else {
            document.getElementById('adhan-times-container').innerHTML = '<div class="text-center py-6 text-white/50">اذهب لشاشة الصلاة واختر موقعك أولاً</div>';
        }
    } else {
        document.getElementById('adhan-times-container').innerHTML = '<div class="text-center py-6 text-white/50">اذهب لشاشة الصلاة واختر موقعك أولاً</div>';
    }
}

window.playAdhan = function (prayer) {
    stopAdhan();
    const url = ADHAN_URLS[prayer];
    if (!url) { showToast('عذراً، الأذان غير متاح حالياً', 'error'); return; }

    currentAdhanAudio = new Audio(url);
    currentAdhanAudio.play().then(() => {
        const stopBtn = document.getElementById('stop-adhan-btn');
        if (stopBtn) stopBtn.classList.remove('hidden');
    }).catch(() => {
        // Fallback to notification tone
        playNotificationTone();
        showToast('تم تشغيل تنبيه الصلاة');
    });

    const adhanNames = { 'Fajr': 'الفجر', 'Dhuhr': 'الظهر', 'Asr': 'العصر', 'Maghrib': 'المغرب', 'Isha': 'العشاء' };
    showToast(`تشغيل أذان ${adhanNames[prayer] || prayer}`);

    currentAdhanAudio.onended = () => {
        const btn = document.getElementById('stop-adhan-btn');
        if (btn) btn.classList.add('hidden');
    };
};

window.stopAdhan = function () {
    if (currentAdhanAudio) {
        currentAdhanAudio.pause();
        currentAdhanAudio.currentTime = 0;
        currentAdhanAudio = null;
    }
    if (adhanAudioCtx) {
        adhanAudioCtx.close().catch(() => { });
        adhanAudioCtx = null;
    }
    const stopBtn = document.getElementById('stop-adhan-btn');
    if (stopBtn) stopBtn.classList.add('hidden');
};

window.setAdhanReminder = function (prayer, time) {
    const parts = time.split(':');
    if (document.getElementById('reminder-time')) {
        document.getElementById('reminder-time').value = time;
    }
    openModal('reminder-modal');
    showToast(`سيتم إضافة تذكير لأذان ${prayer} الساعة ${time}`);
};

// =========================================================================
//  الإعدادات
// =========================================================================
function renderSettings() {
    if (!appState.settings) appState.settings = { dailyWorshipGoal: 5, quranPagesPerDay: 2, targetKhatmaDays: 30, dailyResetTime: '00:00' };
    const s = appState.settings;
    document.getElementById('screen-settings').innerHTML = `
        <div class="card p-5 space-y-5">
            <div class="flex items-center gap-3"><span class="text-3xl">⚙️</span><h2 class="text-2xl font-bold" style="color:var(--accent-gold)">الإعدادات</h2></div>

            <!-- Name -->
            <div class="settings-section">
                <h3 class="settings-section-title"><i class="fas fa-user me-2"></i>الاسم المفضل</h3>
                <div class="flex gap-3">
                    <input type="text" id="preferred-name-setting"
                        value="${escapeHtml(appState.preferredName || currentUser?.displayName || '')}"
                        placeholder="الاسم الذي تريد مناداتك به"
                        class="flex-1 p-3 rounded-xl border settings-input"
                        onkeydown="if(event.key==='Enter') updatePreferredName()">
                    <button onclick="updatePreferredName()" class="btn-primary px-5 rounded-xl flex-shrink-0">
                        <i class="fas fa-save me-1"></i>حفظ
                    </button>
                </div>
            </div>

            <!-- Quran Settings -->
            <div class="settings-section">
                <h3 class="settings-section-title"><i class="fas fa-quran me-2"></i>إعدادات القرآن</h3>
                <div class="grid sm:grid-cols-2 gap-4">
                    <div>
                        <label class="block mb-2 text-sm" style="color:var(--text-secondary)">صفحات القرآن يومياً</label>
                        <input type="number" id="quranPages" value="${s.quranPagesPerDay}" min="1" max="20" class="w-full p-3 rounded-xl border settings-input">
                    </div>
                    <div>
                        <label class="block mb-2 text-sm" style="color:var(--text-secondary)">هدف الختمة (أيام)</label>
                        <input type="number" id="targetKhatma" value="${s.targetKhatmaDays}" min="1" max="365" class="w-full p-3 rounded-xl border settings-input">
                    </div>
                </div>
                <div class="mt-3">
                    <label class="block mb-2 text-sm" style="color:var(--text-secondary)">حجم خط القرآن: <span id="quran-font-size-val">${s.quranFontSize || 24}</span>px</label>
                    <input type="range" id="quranFontSize" min="16" max="44" value="${s.quranFontSize || 24}" class="w-full" oninput="document.getElementById('quran-font-size-val').innerText=this.value">
                </div>
            </div>

            <!-- Time Settings -->
            <div class="settings-section">
                <h3 class="settings-section-title"><i class="fas fa-clock me-2"></i>إعدادات الوقت</h3>
                <div>
                    <label class="block mb-2 text-sm" style="color:var(--text-secondary)">وقت تصفير الأذكار يومياً</label>
                    <input type="time" id="dailyResetTime" value="${s.dailyResetTime || '00:00'}" class="w-full p-3 rounded-xl border settings-input">
                </div>
            </div>

            <!-- Dhikr Sound Settings -->
            <div class="settings-section">
                <h3 class="settings-section-title"><i class="fas fa-volume-up me-2"></i>صوت الأذكار</h3>
                <div class="space-y-3">
                    <div class="flex items-center justify-between">
                        <label class="text-sm" style="color:var(--text-secondary)">تفعيل الصوت عند إتمام الذكر</label>
                        <button id="toggle-dhikr-sound" onclick="toggleDhikrSound()" class="px-4 py-2 rounded-xl text-sm font-bold transition ripple-btn" style="background:${s.dhikrSoundEnabled ? 'rgba(74,222,128,0.15);border:1px solid rgba(74,222,128,0.4);color:#4ade80' : 'rgba(200,170,78,0.1);border:1px solid rgba(200,170,78,0.3);color:var(--accent-gold)'}">
                            <i class="fas ${s.dhikrSoundEnabled ? 'fa-volume-up' : 'fa-volume-mute'} me-1"></i>${s.dhikrSoundEnabled ? 'مفعّل' : 'صامت'}
                        </button>
                    </div>
                    <div class="flex items-center justify-between" id="dhikr-sound-per-rep-row" style="${s.dhikrSoundEnabled ? '' : 'opacity:0.4;pointer-events:none'}">
                        <label class="text-sm" style="color:var(--text-secondary)">صوت عند كل تكرار (وليس فقط عند الإتمام)</label>
                        <button id="toggle-dhikr-sound-per-rep" onclick="toggleDhikrSoundPerRep()" class="px-4 py-2 rounded-xl text-sm font-bold transition ripple-btn" style="background:${s.dhikrSoundPerRep ? 'rgba(74,222,128,0.15);border:1px solid rgba(74,222,128,0.4);color:#4ade80' : 'rgba(200,170,78,0.1);border:1px solid rgba(200,170,78,0.3);color:var(--accent-gold)'}">
                            <i class="fas ${s.dhikrSoundPerRep ? 'fa-check' : 'fa-times'} me-1"></i>${s.dhikrSoundPerRep ? 'مفعّل' : 'معطّل'}
                        </button>
                    </div>
                </div>
            </div>

            <!-- Display Settings -->
            <div class="settings-section">
                <h3 class="settings-section-title"><i class="fas fa-text-height me-2"></i>إعدادات العرض</h3>
                <div>
                    <label class="block mb-2 text-sm" style="color:var(--text-secondary)">حجم الخط العام: <span id="app-font-size-val">${s.appFontSize || 16}</span>px</label>
                    <input type="range" id="appFontSize" min="12" max="24" value="${s.appFontSize || 16}" class="w-full" oninput="document.getElementById('app-font-size-val').innerText=this.value; setAppFontSize(this.value)">
                </div>
                <div class="mt-3 flex items-center justify-between">
                    <label class="text-sm" style="color:var(--text-secondary)">المظهر الحالي: <span class="text-gold font-bold">${typeof _themeMode !== 'undefined' ? (_themeMode === 'dark' ? 'داكن' : _themeMode === 'light' ? 'فاتح' : 'تلقائي') : 'داكن'}</span></label>
                    <button onclick="toggleTheme(); setTimeout(renderSettings,100)" class="px-4 py-2 rounded-xl text-sm font-bold transition ripple-btn" style="background:rgba(200,170,78,0.1);border:1px solid rgba(200,170,78,0.3);color:var(--accent-gold)">
                        <i class="fas fa-palette me-1"></i>تبديل المظهر
                    </button>
                </div>
                <div class="mt-3 flex items-center justify-between">
                    <label class="text-sm" style="color:var(--text-secondary)">وضع القراءة الليلية (المصحف)</label>
                    <button onclick="toggleMushafNightMode()" class="px-4 py-2 rounded-xl text-sm font-bold transition ripple-btn" style="background:${_mushafNightMode ? 'rgba(74,222,128,0.15);border:1px solid rgba(74,222,128,0.4);color:#4ade80' : 'rgba(200,170,78,0.1);border:1px solid rgba(200,170,78,0.3);color:var(--accent-gold)'}">
                        <i class="fas ${_mushafNightMode ? 'fa-moon' : 'fa-sun'} me-1"></i>${_mushafNightMode ? 'مفعّل' : 'معطّل'}
                    </button>
                </div>
                <div class="mt-3 flex items-center justify-between">
                    <label class="text-sm" style="color:var(--text-secondary)">وضع التركيز (Alt+F)</label>
                    <button onclick="toggleFocusMode()" class="px-4 py-2 rounded-xl text-sm font-bold transition ripple-btn" style="background:rgba(200,170,78,0.1);border:1px solid rgba(200,170,78,0.3);color:var(--accent-gold)">
                        <i class="fas fa-eye-slash me-1"></i>تفعيل
                    </button>
                </div>
            </div>

            <button onclick="saveSettings()" class="w-full btn-primary py-3 rounded-xl text-lg">
                <i class="fas fa-save me-2"></i>حفظ الإعدادات
            </button>

            <!-- Security Info -->
            <div class="settings-section" style="border-color:var(--accent-emerald)">
                <h3 class="settings-section-title"><i class="fas fa-shield-alt me-2" style="color:var(--accent-emerald)"></i>الأمان</h3>
                <div class="space-y-2 text-sm" style="color:var(--text-secondary)">
                    <div class="flex items-center gap-2"><i class="fas fa-check-circle" style="color:var(--accent-emerald)"></i><span>تسجيل دخول آمن عبر Google</span></div>
                    <div class="flex items-center gap-2"><i class="fas fa-check-circle" style="color:var(--accent-emerald)"></i><span>البيانات مشفرة في Firebase</span></div>
                    <div class="flex items-center gap-2"><i class="fas fa-check-circle" style="color:var(--accent-emerald)"></i><span>لا نشارك بياناتك مع أي طرف ثالث</span></div>
                    <div class="flex items-center gap-2"><i class="fas fa-check-circle" style="color:var(--accent-emerald)"></i><span>حفظ محلي مع مزامنة سحابية</span></div>
                </div>
            </div>

            <!-- Privacy & About -->
            <div class="settings-section">
                <h3 class="settings-section-title"><i class="fas fa-info-circle me-2"></i>حول التطبيق</h3>
                <div class="space-y-2">
                    <button onclick="showScreen('privacy')" class="w-full flex items-center justify-between py-3 px-4 rounded-xl transition hover:bg-white/5" style="background:rgba(200,170,78,0.05);border:1px solid rgba(200,170,78,0.15)">
                        <span class="flex items-center gap-2 text-sm" style="color:var(--text-secondary)"><i class="fas fa-shield-alt" style="color:var(--accent-gold)"></i>سياسة الخصوصية</span>
                        <i class="fas fa-chevron-left text-xs" style="color:var(--text-muted)"></i>
                    </button>
                    <a href="privacy-policy.html" target="_blank" rel="noopener noreferrer" class="w-full flex items-center justify-between py-3 px-4 rounded-xl transition hover:bg-white/5" style="background:rgba(200,170,78,0.05);border:1px solid rgba(200,170,78,0.15);text-decoration:none">
                        <span class="flex items-center gap-2 text-sm" style="color:var(--text-secondary)"><i class="fas fa-external-link-alt" style="color:var(--accent-gold)"></i>فتح سياسة الخصوصية (صفحة منفصلة)</span>
                        <i class="fas fa-chevron-left text-xs" style="color:var(--text-muted)"></i>
                    </a>
                </div>
            </div>

            <!-- Danger Zone -->
            <div class="p-4 rounded-xl" style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2)">
                <h3 class="text-sm font-bold mb-3" style="color:#ef4444">منطقة الخطر</h3>
                <div class="space-y-2">
                    <button onclick="signOut()" class="w-full py-3 rounded-xl font-bold transition" style="background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.3);color:#ef4444">
                        <i class="fas fa-sign-out-alt me-1"></i>تسجيل الخروج
                    </button>
                </div>
            </div>

            <!-- Backup/Restore -->
            <div class="settings-section">
                <h3 class="settings-section-title"><i class="fas fa-database me-2"></i>النسخ الاحتياطي</h3>
                <div class="grid grid-cols-2 gap-3">
                    <button onclick="exportUserData()" class="bg-blue-500/10 border border-blue-500/30 text-blue-400 py-3 rounded-xl font-bold transition hover:bg-blue-500/20 ripple-btn">
                        <i class="fas fa-download me-1"></i> تصدير البيانات
                    </button>
                    <button onclick="importUserData()" class="bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 py-3 rounded-xl font-bold transition hover:bg-yellow-500/20 ripple-btn">
                        <i class="fas fa-upload me-1"></i> استيراد نسخة
                    </button>
                </div>
            </div>
        </div>`;
}

window.updatePreferredName = async function () {
    const name = document.getElementById('preferred-name-setting').value.trim();
    if (!name) { showToast('الرجاء إدخال اسم', 'error'); return; }
    appState.preferredName = name;
    await saveUserField('preferredName', name);
    const headerName = document.getElementById('header-user-name');
    if (headerName) headerName.innerText = name;
    showToast(`تم تحديث الاسم: ${name}`);
};

window.saveSettings = async function () {
    const quranPages = parseInt(document.getElementById('quranPages').value);
    const targetKhatma = parseInt(document.getElementById('targetKhatma').value);
    const resetTime = document.getElementById('dailyResetTime').value;
    if (isNaN(quranPages) || quranPages < 1) { showToast('صفحات القرآن يجب 1 على الأقل', 'error'); return; }
    if (isNaN(targetKhatma) || targetKhatma < 1) { showToast('هدف الختمة يجب 1 على الأقل', 'error'); return; }
    if (!resetTime) { showToast('يرجى اختيار وقت التصفير', 'error'); return; }
    appState.settings.quranPagesPerDay = quranPages;
    appState.settings.targetKhatmaDays = targetKhatma;
    appState.settings.dailyResetTime = resetTime;
    const fontSize = parseInt(document.getElementById('quranFontSize')?.value || '24');
    if (fontSize >= 16 && fontSize <= 44) appState.settings.quranFontSize = fontSize;
    const appFontSize = parseInt(document.getElementById('appFontSize')?.value || '16');
    if (appFontSize >= 12 && appFontSize <= 24) appState.settings.appFontSize = appFontSize;
    // Sound settings are already saved via their toggle buttons, but ensure they persist
    await saveUserField('settings', appState.settings);
    showToast('✅ تم حفظ الإعدادات');
};

// --- Dhikr sound toggle handlers ---
window.toggleDhikrSound = async function () {
    appState.settings.dhikrSoundEnabled = !appState.settings.dhikrSoundEnabled;
    // If disabling sound, also disable per-rep
    if (!appState.settings.dhikrSoundEnabled) appState.settings.dhikrSoundPerRep = false;
    await saveUserField('settings', appState.settings);
    renderSettings(); // re-render to reflect new toggle state
    // Play a preview chime if just enabled
    if (appState.settings.dhikrSoundEnabled) playDhikrChime();
};

window.toggleDhikrSoundPerRep = async function () {
    if (!appState.settings.dhikrSoundEnabled) return;
    appState.settings.dhikrSoundPerRep = !appState.settings.dhikrSoundPerRep;
    await saveUserField('settings', appState.settings);
    renderSettings();
};

// =========================================================================
//  Privacy Policy Screen (سياسة الخصوصية)
// =========================================================================
function renderPrivacy() {
    document.getElementById('screen-privacy').innerHTML = `
        <div class="card p-6">
            <div class="flex items-center justify-center gap-3 mb-6">
                <span class="text-3xl">🔒</span>
                <h2 class="text-2xl font-bold text-gold">سياسة الخصوصية</h2>
            </div>
            <p class="text-center text-white/40 text-xs mb-6">آخر تحديث: فبراير 2026</p>

            <!-- مقدمة -->
            <div class="bg-white/5 border border-white/10 rounded-xl p-4 mb-4">
                <h3 class="text-gold font-bold mb-2 flex items-center gap-2"><span>📋</span> مقدمة</h3>
                <p class="text-sm leading-relaxed" style="color:var(--text-secondary)">مرحباً بك في تطبيق <strong class="text-gold">Nafs Tracker</strong>. نحن نحترم خصوصيتك ونلتزم بحمايتها. توضح هذه السياسة ما نجمعه من بيانات، وكيف نستخدمها، وكيف نحميها.</p>
                <p class="text-sm mt-2" style="color:var(--text-secondary)">باستخدامك للتطبيق، فإنك توافق على الشروط الواردة في هذه السياسة.</p>
            </div>

            <!-- البيانات التي نجمعها -->
            <div class="bg-white/5 border border-white/10 rounded-xl p-4 mb-4">
                <h3 class="text-gold font-bold mb-2 flex items-center gap-2"><span>📦</span> البيانات التي نجمعها</h3>
                <p class="text-sm mb-2" style="color:var(--text-secondary)">يجمع التطبيق البيانات التالية عند تسجيل دخولك:</p>
                <ul class="text-sm space-y-1 pr-4" style="color:var(--text-secondary);list-style:disc">
                    <li><strong class="text-white/80">بيانات الحساب:</strong> الاسم، البريد الإلكتروني، وصورة الملف الشخصي من حساب Google.</li>
                    <li><strong class="text-white/80">بيانات العبادات:</strong> تقدمك في الأذكار، الصلوات، قراءة القرآن، التسبيح، ويومياتك الروحية.</li>
                    <li><strong class="text-white/80">الإعدادات:</strong> تفضيلاتك داخل التطبيق كحجم الخط وأوقات التذكير.</li>
                    <li><strong class="text-white/80">الموقع الجغرافي (اختياري):</strong> لتحديد مواقيت الصلاة والقبلة — لا يُخزَّن على خوادمنا.</li>
                    <li><strong class="text-white/80">بيانات الاستخدام:</strong> النقاط المكتسبة، سلاسل المواظبة، والشارات.</li>
                </ul>
                <div class="mt-3 p-3 rounded-lg" style="background:rgba(46,204,113,0.08);border:1px solid rgba(46,204,113,0.2)">
                    <p class="text-xs" style="color:#7effc0">✅ لا نجمع أي بيانات حساسة كبيانات بطاقات الائتمان أو المعلومات الصحية.</p>
                </div>
            </div>

            <!-- كيف نستخدم بياناتك -->
            <div class="bg-white/5 border border-white/10 rounded-xl p-4 mb-4">
                <h3 class="text-gold font-bold mb-2 flex items-center gap-2"><span>🔧</span> كيف نستخدم بياناتك</h3>
                <p class="text-sm mb-2" style="color:var(--text-secondary)">تُستخدم البيانات حصراً من أجل:</p>
                <ul class="text-sm space-y-1 pr-4" style="color:var(--text-secondary);list-style:disc">
                    <li>حفظ تقدمك ومزامنته عبر أجهزتك المختلفة.</li>
                    <li>عرض مواقيت الصلاة الدقيقة واتجاه القبلة بناءً على موقعك.</li>
                    <li>إرسال تذكيرات الأذكار والصلاة (إن فعّلتها).</li>
                    <li>عرض إحصائياتك وتقدمك الشخصي داخل التطبيق.</li>
                    <li>تحسين تجربة التطبيق وإصلاح الأخطاء التقنية.</li>
                </ul>
                <div class="mt-3 p-3 rounded-lg" style="background:rgba(200,170,78,0.07);border:1px solid rgba(200,170,78,0.2)">
                    <p class="text-xs text-gold">🚫 لا نبيع بياناتك لأي طرف ثالث، ولا نستخدمها لأغراض إعلانية.</p>
                </div>
            </div>

            <!-- تخزين البيانات -->
            <div class="bg-white/5 border border-white/10 rounded-xl p-4 mb-4">
                <h3 class="text-gold font-bold mb-2 flex items-center gap-2"><span>☁️</span> تخزين البيانات</h3>
                <p class="text-sm mb-2" style="color:var(--text-secondary)">يستخدم التطبيق خدمة <strong class="text-white/80">Firebase</strong> من Google لتخزين بياناتك بشكل آمن على السحابة.</p>
                <ul class="text-sm space-y-1 pr-4" style="color:var(--text-secondary);list-style:disc">
                    <li>يتم تشفير جميع البيانات أثناء النقل باستخدام بروتوكول HTTPS.</li>
                    <li>يتم تخزين البيانات على خوادم Firebase في مراكز بيانات آمنة.</li>
                    <li>يمكنك حذف حسابك وبياناتك في أي وقت من إعدادات التطبيق.</li>
                </ul>
            </div>

            <!-- تسجيل الدخول -->
            <div class="bg-white/5 border border-white/10 rounded-xl p-4 mb-4">
                <h3 class="text-gold font-bold mb-2 flex items-center gap-2"><span>🔑</span> تسجيل الدخول عبر Google</h3>
                <p class="text-sm" style="color:var(--text-secondary)">يستخدم التطبيق تسجيل الدخول عبر <strong class="text-white/80">Google OAuth</strong> فقط. لا نقوم بتخزين كلمات المرور أو إنشاء حسابات مستقلة. يمكنك إلغاء صلاحية الوصول في أي وقت من إعدادات حساب Google الخاص بك.</p>
            </div>

            <!-- الإشعارات -->
            <div class="bg-white/5 border border-white/10 rounded-xl p-4 mb-4">
                <h3 class="text-gold font-bold mb-2 flex items-center gap-2"><span>🔔</span> الإشعارات</h3>
                <p class="text-sm" style="color:var(--text-secondary)">يطلب التطبيق إذناً لإرسال إشعارات للتذكير بالأذكار ومواقيت الصلاة. هذه الإشعارات اختيارية تماماً ويمكنك تعطيلها من إعدادات جهازك في أي وقت.</p>
            </div>

            <!-- الموقع الجغرافي -->
            <div class="bg-white/5 border border-white/10 rounded-xl p-4 mb-4">
                <h3 class="text-gold font-bold mb-2 flex items-center gap-2"><span>📍</span> الموقع الجغرافي</h3>
                <p class="text-sm mb-2" style="color:var(--text-secondary)">يطلب التطبيق الوصول إلى موقعك الجغرافي لتحديد مواقيت الصلاة واتجاه القبلة بدقة.</p>
                <ul class="text-sm space-y-1 pr-4" style="color:var(--text-secondary);list-style:disc">
                    <li>لا يُخزَّن موقعك على خوادمنا.</li>
                    <li>يُستخدم الموقع فقط في اللحظة التي تطلب فيها مواقيت الصلاة.</li>
                    <li>يمكنك تعطيل هذا الإذن وإدخال موقعك يدوياً.</li>
                </ul>
            </div>

            <!-- حقوقك -->
            <div class="bg-white/5 border border-white/10 rounded-xl p-4 mb-4">
                <h3 class="text-gold font-bold mb-2 flex items-center gap-2"><span>👤</span> حقوقك</h3>
                <p class="text-sm mb-2" style="color:var(--text-secondary)">لك الحق في:</p>
                <ul class="text-sm space-y-1 pr-4" style="color:var(--text-secondary);list-style:disc">
                    <li><strong class="text-white/80">الاطلاع</strong> على جميع بياناتك المخزنة في التطبيق.</li>
                    <li><strong class="text-white/80">تعديل</strong> معلوماتك الشخصية من إعدادات التطبيق.</li>
                    <li><strong class="text-white/80">تصدير</strong> بياناتك من خيار النسخ الاحتياطي في الإعدادات.</li>
                    <li><strong class="text-white/80">حذف</strong> حسابك وجميع بياناتك بالكامل عند الطلب.</li>
                </ul>
            </div>

            <!-- خصوصية الأطفال -->
            <div class="bg-white/5 border border-white/10 rounded-xl p-4 mb-4">
                <h3 class="text-gold font-bold mb-2 flex items-center gap-2"><span>👶</span> خصوصية الأطفال</h3>
                <p class="text-sm" style="color:var(--text-secondary)">التطبيق موجه للمستخدمين من عمر 13 سنة فأكثر. لا نجمع بيانات عمدية من الأطفال دون سن 13 عاماً. إذا اكتشفنا ذلك، سنحذف البيانات فوراً.</p>
            </div>

            <!-- التحديثات -->
            <div class="bg-white/5 border border-white/10 rounded-xl p-4 mb-4">
                <h3 class="text-gold font-bold mb-2 flex items-center gap-2"><span>🔄</span> التحديثات على هذه السياسة</h3>
                <p class="text-sm" style="color:var(--text-secondary)">قد نقوم بتحديث سياسة الخصوصية من وقت لآخر. سنخطرك بأي تغييرات جوهرية عبر التطبيق. الاستمرار في استخدام التطبيق بعد التحديث يعني موافقتك على السياسة الجديدة.</p>
            </div>

            <!-- تواصل معنا -->
            <div class="bg-white/5 border border-white/10 rounded-xl p-4 mb-4">
                <h3 class="text-gold font-bold mb-2 flex items-center gap-2"><span>📩</span> تواصل معنا</h3>
                <p class="text-sm" style="color:var(--text-secondary)">إذا كان لديك أي استفسار حول سياسة الخصوصية أو بياناتك، يمكنك التواصل معنا على:</p>
                <p class="text-sm mt-1"><span>📧</span> <a href="mailto:nafstracker@gmail.com" class="text-gold hover:underline">nafstracker@gmail.com</a></p>
            </div>

            <!-- Footer -->
            <div class="text-center mt-6 pt-4 border-t border-white/10">
                <p class="font-arabic text-gold/50 text-lg mb-2">﴿ إِنَّ اللَّهَ كَانَ عَلَيْكُمْ رَقِيبًا ﴾</p>
                <p class="text-xs text-white/30">© 2026 Nafs Tracker. جميع الحقوق محفوظة.</p>
            </div>

            <button onclick="showScreen('settings')" class="w-full mt-4 py-3 rounded-xl font-bold transition text-sm" style="background:rgba(200,170,78,0.1);border:1px solid rgba(200,170,78,0.25);color:var(--accent-gold)">
                <i class="fas fa-arrow-right me-1"></i>العودة للإعدادات
            </button>
        </div>`;
}

// =========================================================================
//  Emergency Mode — لحظة تأمل (3-phase: Breathe → Reflect → Act)
// =========================================================================

const EM_AYAHS = [
    { text: 'قُلْ يَا عِبَادِيَ الَّذِينَ أَسْرَفُوا عَلَىٰ أَنفُسِهِمْ لَا تَقْنَطُوا مِن رَّحْمَةِ اللَّهِ ۚ إِنَّ اللَّهَ يَغْفِرُ الذُّنُوبَ جَمِيعًا', source: '— الزمر: ٥٣' },
    { text: 'وَمَن يَعْمَلْ سُوءًا أَوْ يَظْلِمْ نَفْسَهُ ثُمَّ يَسْتَغْفِرِ اللَّهَ يَجِدِ اللَّهَ غَفُورًا رَّحِيمًا', source: '— النساء: ١١٠' },
    { text: 'وَإِنِّي لَغَفَّارٌ لِّمَن تَابَ وَآمَنَ وَعَمِلَ صَالِحًا ثُمَّ اهْتَدَىٰ', source: '— طه: ٨٢' },
    { text: 'إِنَّ اللَّهَ يُحِبُّ التَّوَّابِينَ وَيُحِبُّ الْمُتَطَهِّرِينَ', source: '— البقرة: ٢٢٢' },
    { text: 'أَلَا بِذِكْرِ اللَّهِ تَطْمَئِنُّ الْقُلُوبُ', source: '— الرعد: ٢٨' },
    { text: 'وَاسْتَغْفِرُوا رَبَّكُمْ ثُمَّ تُوبُوا إِلَيْهِ ۚ إِنَّ رَبِّي رَحِيمٌ وَدُودٌ', source: '— هود: ٩٠' },
    { text: 'يَا أَيُّهَا الَّذِينَ آمَنُوا تُوبُوا إِلَى اللَّهِ تَوْبَةً نَّصُوحًا', source: '— التحريم: ٨' }
];
const EM_HADITHS = [
    { text: 'كل ابن آدم خطّاء، وخير الخطّائين التوّابون', source: '— رواه الترمذي' },
    { text: 'التائب من الذنب كمن لا ذنب له', source: '— رواه ابن ماجه' },
    { text: 'إن الله يبسط يده بالليل ليتوب مسيء النهار، ويبسط يده بالنهار ليتوب مسيء الليل', source: '— رواه مسلم' },
    { text: 'لَلَّهُ أشد فرحاً بتوبة عبده من أحدكم براحلته', source: '— متفق عليه' },
    { text: 'من تاب قبل أن تطلع الشمس من مغربها تاب الله عليه', source: '— رواه مسلم' }
];
const EM_ACTIONS = [
    { icon: '🕌', title: 'قم الآن وتوضأ', sub: 'الوضوء يمحو الذنوب ويصفّي القلب' },
    { icon: '📖', title: 'اقرأ سورة التوبة', sub: 'فيها سبعة وعشرون نداءً للتائبين' },
    { icon: '🤲', title: 'استغفر الله مئة مرة', sub: 'من أكثر الاستغفار جعل الله له من كل ضيق مخرجاً' },
    { icon: '🚶', title: 'اخرج وامشِ قليلاً', sub: 'غيّر بيئتك — ابتعد عن مكان الإغراء الآن' },
    { icon: '📵', title: 'ضع الهاتف بعيداً', sub: 'ابتعد عن الشاشة عشر دقائق كاملة' },
    { icon: '💧', title: 'اشرب ماء وتوضأ', sub: 'كسر اللحظة بفعل جسدي يعيدك لنفسك' },
    { icon: '🕋', title: 'صلِّ ركعتين لله', sub: 'ركعتان خير من الدنيا وما فيها' }
];

const EM_BREATH_STEPS = [
    { text: 'شهيق عميق...', dur: 4000 },
    { text: 'احبس نفسك...', dur: 4000 },
    { text: 'زفير بهدوء...', dur: 6000 },
    { text: 'ارتاح...', dur: 2000 }
];

let emBreathTimeout = null;
let emBreathIdx = 0;
let emBreathCycles = 0;
let emTimerInterval = null;

function emCreateStars() {
    const c = document.getElementById('em-stars');
    if (!c || c.children.length > 0) return;
    for (let i = 0; i < 45; i++) {
        const s = document.createElement('div');
        s.className = 'em-star';
        const sz = Math.random() * 2 + 1;
        s.style.cssText = `width:${sz}px;height:${sz}px;top:${Math.random() * 100}%;left:${Math.random() * 100}%;--d:${2 + Math.random() * 4}s;--dl:${Math.random() * 4}s;`;
        c.appendChild(s);
    }
}

function emClearStars() {
    const c = document.getElementById('em-stars');
    if (c) c.innerHTML = '';
}

function emSetRandomContent() {
    const ayah = EM_AYAHS[Math.floor(Math.random() * EM_AYAHS.length)];
    const hadith = EM_HADITHS[Math.floor(Math.random() * EM_HADITHS.length)];
    const action = EM_ACTIONS[Math.floor(Math.random() * EM_ACTIONS.length)];
    const el = (id) => document.getElementById(id);
    if (el('em-ayah-text')) el('em-ayah-text').innerText = ayah.text;
    if (el('em-ayah-source')) el('em-ayah-source').innerText = ayah.source;
    if (el('em-hadith-text')) el('em-hadith-text').innerText = hadith.text;
    if (el('em-hadith-source')) el('em-hadith-source').innerText = hadith.source;
    if (el('em-action-icon')) el('em-action-icon').innerText = action.icon;
    if (el('em-action-title')) el('em-action-title').innerText = action.title;
    if (el('em-action-sub')) el('em-action-sub').innerText = action.sub;
}

window.emGoPhase = function (n) {
    [1, 2, 3].forEach(i => {
        const phase = document.getElementById(`em-phase-${i}`);
        const dot = document.getElementById(`em-dot-${i}`);
        if (phase) phase.classList.toggle('em-hidden', i !== n);
        if (dot) dot.classList.toggle('active', i === n);
    });
    if (n === 3) emStartTimer();
    if (emBreathTimeout) { clearTimeout(emBreathTimeout); emBreathTimeout = null; }
};

function emRunBreath() {
    const pFill = document.getElementById('em-progress-fill');
    const bText = document.getElementById('em-breath-text');
    if (!pFill || !bText) return;

    const s = EM_BREATH_STEPS[emBreathIdx];
    bText.style.opacity = 0;
    setTimeout(() => { bText.innerText = s.text; bText.style.opacity = 1; }, 200);
    pFill.style.transition = 'none'; pFill.style.width = '0%';
    setTimeout(() => { pFill.style.transition = `width ${s.dur / 1000}s linear`; pFill.style.width = '100%'; }, 60);

    // Vibrate on inhale for tactile feedback
    if (emBreathIdx === 0 && navigator.vibrate) {
        try { navigator.vibrate(100); } catch (_) { }
    }

    emBreathTimeout = setTimeout(() => {
        emBreathIdx = (emBreathIdx + 1) % EM_BREATH_STEPS.length;
        if (emBreathIdx === 0) {
            emBreathCycles++;
            if (emBreathCycles >= 3) { setTimeout(() => emGoPhase(2), 600); return; }
        }
        emRunBreath();
    }, s.dur);
}

function emStartTimer() {
    if (emTimerInterval) clearInterval(emTimerInterval);
    let rem = 600;
    const el = document.getElementById('emergency-timer');
    const expiry = Date.now() + rem * 1000;
    safeLocalStorageSet('emergency_expiry', expiry.toString());

    function tick() {
        if (rem <= 0) { clearInterval(emTimerInterval); emTimerInterval = null; emFinish(); return; }
        const m = Math.floor(rem / 60), s = rem % 60;
        if (el) el.innerText = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        rem--;
    }
    tick();
    emTimerInterval = setInterval(tick, 1000);
}

function emResetPhases() {
    emBreathIdx = 0;
    emBreathCycles = 0;
    if (emBreathTimeout) { clearTimeout(emBreathTimeout); emBreathTimeout = null; }
    if (emTimerInterval) { clearInterval(emTimerInterval); emTimerInterval = null; }
    // Reset to phase 1
    [1, 2, 3].forEach(i => {
        const phase = document.getElementById(`em-phase-${i}`);
        const dot = document.getElementById(`em-dot-${i}`);
        if (phase) phase.classList.toggle('em-hidden', i !== 1);
        if (dot) dot.classList.toggle('active', i === 1);
    });
}

window.activateEmergency = function () {
    const overlay = document.getElementById('emergency-overlay');
    if (!overlay) return;
    emResetPhases();
    emCreateStars();
    emSetRandomContent();
    overlay.classList.remove('hidden');
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    emRunBreath();
};

window.emFinish = function () {
    deactivateEmergency();
};

window.deactivateEmergency = function () {
    const overlay = document.getElementById('emergency-overlay');
    if (overlay) { overlay.classList.add('hidden'); overlay.style.display = ''; }
    emResetPhases();
    emClearStars();
    document.body.style.overflow = '';
    safeLocalStorageSet('emergency_expiry', '0');
    if (emergencyInterval) { clearInterval(emergencyInterval); emergencyInterval = null; }
};

function restoreEmergencyState() {
    const expiry = parseInt(safeLocalStorageGet('emergency_expiry') || '0');
    const remaining = Math.floor((expiry - Date.now()) / 1000);
    if (remaining > 0) {
        const overlay = document.getElementById('emergency-overlay');
        if (!overlay) return;
        emCreateStars();
        emSetRandomContent();
        overlay.classList.remove('hidden');
        overlay.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        // Jump directly to phase 3 with remaining time
        emGoPhase(3);
        if (emTimerInterval) clearInterval(emTimerInterval);
        let rem = remaining;
        const el = document.getElementById('emergency-timer');
        function tick() {
            if (rem <= 0) { clearInterval(emTimerInterval); emTimerInterval = null; emFinish(); return; }
            const m = Math.floor(rem / 60), s = rem % 60;
            if (el) el.innerText = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
            rem--;
        }
        tick();
        emTimerInterval = setInterval(tick, 1000);
    }
}

// =========================================================================
//  Back to Top
// =========================================================================
function initBackToTop() {
    const btn = document.getElementById('backToTop');
    if (!btn) return;
    window.addEventListener('scroll', () => {
        if (window.scrollY > 400) btn.classList.add('visible');
        else btn.classList.remove('visible');
    }, { passive: true });
}

// =========================================================================
//  Theme System (dark/light/auto)
// =========================================================================
let _themeMode = 'dark'; // 'dark' | 'light' | 'auto'

window.toggleTheme = function () {
    // Cycle: dark → light → auto → dark
    const cycle = { dark: 'light', light: 'auto', auto: 'dark' };
    _themeMode = cycle[_themeMode] || 'dark';
    applyTheme(_themeMode);
    safeLocalStorageSet('nafs_theme', _themeMode);
    const labels = { dark: 'الوضع الداكن', light: 'الوضع الفاتح', auto: 'تلقائي (حسب النظام)' };
    showToast(`🎨 ${labels[_themeMode]}`);
};

function applyTheme(mode) {
    _themeMode = mode;
    let shouldBeLight = false;
    if (mode === 'light') shouldBeLight = true;
    else if (mode === 'auto') shouldBeLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    // else dark

    isLightMode = shouldBeLight;
    document.body.classList.toggle('light-mode', shouldBeLight);
    const icon = document.getElementById('theme-icon');
    if (icon) {
        icon.className = mode === 'auto' ? 'fas fa-adjust' : (shouldBeLight ? 'fas fa-moon' : 'fas fa-sun');
    }
    // Re-render charts if visible
    const activeScreen = document.querySelector('.screen:not(.hidden)');
    if (activeScreen) {
        const id = activeScreen.id.replace('screen-', '');
        destroyCharts();
        const renders = { quran: renderQuran, analysis: renderAnalysis };
        if (renders[id]) renders[id]();
    }
}

function loadSavedTheme() {
    const saved = safeLocalStorageGet('nafs_theme') || 'dark';
    applyTheme(saved);
}

// Listen for system theme changes (when in auto mode)
try {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
        if (_themeMode === 'auto') applyTheme('auto');
    });
} catch (_) { /* matchMedia listener not supported */ }

// =========================================================================
//  Save Preferred Name
// =========================================================================
window.savePreferredName = async function () {
    const name = document.getElementById('preferred-name-input').value.trim();
    if (!name) { showToast('الرجاء إدخال اسم', 'error'); return; }
    appState.preferredName = name;
    await saveUserField('preferredName', name);
    closeModal('preferred-name-modal');
    const headerName = document.getElementById('header-user-name');
    if (headerName) headerName.innerText = name;
    showToast(`أهلاً بك يا ${name}! 🌟`);
};

// =========================================================================
//  Digital Tasbih (سبحة إلكترونية)
// =========================================================================
let tasbihCount = 0;
let tasbihTarget = 33;
let tasbihTotal = 0;

function renderTasbih() {
    const defaultPhrases = [
        { text: 'سبحان الله', target: 33 },
        { text: 'الحمد لله', target: 33 },
        { text: 'الله أكبر', target: 34 },
        { text: 'لا إله إلا الله', target: 100 },
        { text: 'أستغفر الله', target: 100 },
        { text: 'سبحان الله وبحمده', target: 100 },
        { text: 'لا حول ولا قوة إلا بالله', target: 33 },
        { text: 'اللهم صل على محمد', target: 100 }
    ];

    // Load custom phrases from appState
    const customPhrases = (appState && appState.customTasbihPhrases) || [];
    const tasbihPhrases = [...defaultPhrases, ...customPhrases];

    document.getElementById('screen-tasbih').innerHTML = `
        <div class="card p-5 text-center">
            <div class="flex items-center justify-center gap-3 mb-5"><span class="text-3xl">🧿</span><h2 class="text-2xl font-bold text-gold">السبحة الإلكترونية</h2></div>
            <div class="flex flex-wrap justify-center gap-2 mb-4" id="tasbih-phrases">
                ${tasbihPhrases.map((p, i) => `<button onclick="setTasbihPhrase('${escapeHtml(p.text)}', ${p.target}, this)" class="tasbih-phrase-btn ${i === 0 ? 'active' : ''} px-3 py-1.5 rounded-full text-sm border border-gold/30 transition hover:bg-gold/20">${escapeHtml(p.text)}${i >= defaultPhrases.length ? '<span onclick="event.stopPropagation();removeCustomTasbih(' + (i - defaultPhrases.length) + ')" class="ms-1 text-red-400 hover:text-red-300 cursor-pointer text-xs">✕</span>' : ''}</button>`).join('')}
            </div>
            <button onclick="showAddTasbihModal()" class="mb-6 bg-gold/10 border border-dashed border-gold/30 text-gold/70 px-4 py-1.5 rounded-full text-sm transition hover:bg-gold/20 hover:text-gold">
                <i class="fas fa-plus me-1"></i> إضافة ذكر خاص
            </button>
            <p class="text-2xl font-arabic text-gold mb-4" id="tasbih-current-phrase">${tasbihPhrases[0].text}</p>
            <div class="tasbih-counter-ring mx-auto mb-6" id="tasbih-ring" onclick="incrementTasbih()">
                <svg viewBox="0 0 120 120" class="tasbih-ring-svg">
                    <circle cx="60" cy="60" r="54" fill="none" stroke="rgba(200,170,78,0.15)" stroke-width="6"/>
                    <circle cx="60" cy="60" r="54" fill="none" stroke="var(--accent-gold)" stroke-width="6" stroke-linecap="round"
                        stroke-dasharray="${2 * Math.PI * 54}" stroke-dashoffset="${2 * Math.PI * 54}" id="tasbih-progress-ring"
                        transform="rotate(-90 60 60)" style="transition:stroke-dashoffset 0.3s ease"/>
                </svg>
                <div class="tasbih-counter-text">
                    <span class="text-5xl font-black text-gold" id="tasbih-count-display">0</span>
                    <span class="text-sm text-white/50 block" id="tasbih-target-display">/ ${tasbihTarget}</span>
                </div>
            </div>
            <div class="flex items-center justify-center gap-4 mb-4">
                <button onclick="resetTasbih()" class="bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-red-400 px-4 py-2 rounded-xl text-sm transition ripple-btn"><i class="fas fa-undo me-1"></i> إعادة</button>
                <div class="text-center">
                    <p class="text-xs text-white/50">المجموع الكلي</p>
                    <p class="text-lg font-bold text-gold" id="tasbih-total-display">${tasbihTotal}</p>
                </div>
                <button onclick="saveTasbihPoints()" class="bg-green-500/20 hover:bg-green-500/30 border border-green-500/30 text-green-400 px-4 py-2 rounded-xl text-sm transition ripple-btn"><i class="fas fa-save me-1"></i> حفظ</button>
            </div>
        </div>`;
}

window.showAddTasbihModal = function () {
    // Remove any existing modal first
    document.getElementById('add-tasbih-modal')?.remove();
    const div = document.createElement('div');
    div.id = 'add-tasbih-modal';
    div.className = 'modal-overlay active';
    div.setAttribute('data-closable', 'true');
    div.innerHTML = `
        <div class="modal-content">
            <h3 class="text-xl font-bold text-gold mb-4 text-center"><i class="fas fa-plus-circle me-2"></i>إضافة ذكر خاص</h3>
            <div class="space-y-4">
                <div>
                    <label class="block text-sm text-white/70 mb-1">نص الذكر</label>
                    <input type="text" id="custom-tasbih-text" placeholder="مثال: اللهم اغفر لي" class="w-full bg-white/5 border border-white/20 rounded-xl px-4 py-3 text-white text-right" dir="rtl" maxlength="100">
                </div>
                <div>
                    <label class="block text-sm text-white/70 mb-1">العدد المطلوب</label>
                    <input type="number" id="custom-tasbih-target" value="33" min="1" max="10000" class="w-full bg-white/5 border border-white/20 rounded-xl px-4 py-3 text-white text-center">
                </div>
                <button onclick="addCustomTasbih()" class="w-full bg-gold/20 border border-gold/40 text-gold font-bold py-3 rounded-xl transition hover:bg-gold/30 ripple-btn">
                    <i class="fas fa-check me-1"></i> إضافة
                </button>
                <button onclick="document.getElementById('add-tasbih-modal').remove()" class="w-full bg-white/10 text-white/60 py-2.5 rounded-xl transition hover:bg-white/15">
                    إلغاء
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(div);
};

window.addCustomTasbih = async function () {
    const text = document.getElementById('custom-tasbih-text')?.value?.trim();
    const target = parseInt(document.getElementById('custom-tasbih-target')?.value) || 33;
    if (!text) { showToast('أدخل نص الذكر', 'error'); return; }
    if (target < 1 || target > 10000) { showToast('العدد يجب أن يكون بين 1 و 10000', 'error'); return; }

    if (!appState.customTasbihPhrases) appState.customTasbihPhrases = [];
    if (appState.customTasbihPhrases.length >= 20) { showToast('الحد الأقصى 20 ذكر مخصص', 'error'); return; }

    appState.customTasbihPhrases.push({ text, target });
    await saveUserField('customTasbihPhrases', appState.customTasbihPhrases);
    document.getElementById('add-tasbih-modal')?.remove();
    renderTasbih();
    showToast('تمت إضافة الذكر ✅');
};

window.removeCustomTasbih = async function (index) {
    if (!appState.customTasbihPhrases) return;
    appState.customTasbihPhrases.splice(index, 1);
    await saveUserField('customTasbihPhrases', appState.customTasbihPhrases);
    renderTasbih();
    showToast('تم حذف الذكر');
};

window.setTasbihPhrase = function (text, target, btn) {
    tasbihCount = 0;
    tasbihTarget = target;
    document.getElementById('tasbih-current-phrase').innerText = text;
    document.getElementById('tasbih-count-display').innerText = '0';
    document.getElementById('tasbih-target-display').innerText = '/ ' + target;
    updateTasbihRing();
    document.querySelectorAll('.tasbih-phrase-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
};

window.incrementTasbih = function () {
    tasbihCount++;
    tasbihTotal++;
    document.getElementById('tasbih-count-display').innerText = tasbihCount;
    document.getElementById('tasbih-total-display').innerText = tasbihTotal;
    updateTasbihRing();
    // Haptic feedback
    if (navigator.vibrate) navigator.vibrate(30);
    // Pulse animation
    const ring = document.getElementById('tasbih-ring');
    if (ring) { ring.classList.add('tasbih-pulse'); setTimeout(() => ring.classList.remove('tasbih-pulse'), 200); }
    if (tasbihCount >= tasbihTarget) {
        showToast('🎉 أكملت الهدف! ما شاء الله', 'success');
        if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
        triggerConfetti();
    }
};

window.resetTasbih = function () {
    tasbihCount = 0;
    document.getElementById('tasbih-count-display').innerText = '0';
    updateTasbihRing();
};

window.saveTasbihPoints = async function () {
    if (tasbihTotal <= 0) return;
    appState.totalPoints = (appState.totalPoints || 0) + Math.floor(tasbihTotal / 10);
    appState.level = Math.floor(appState.totalPoints / 100) + 1;
    await saveUserField('totalPoints', appState.totalPoints);
    await saveUserField('level', appState.level);
    showToast(`تم حفظ ${Math.floor(tasbihTotal / 10)} نقطة من التسبيح`);
    tasbihTotal = 0;
    document.getElementById('tasbih-total-display').innerText = '0';
};

function updateTasbihRing() {
    const ring = document.getElementById('tasbih-progress-ring');
    if (!ring) return;
    const circumference = 2 * Math.PI * 54;
    const progress = Math.min(tasbihCount / tasbihTarget, 1);
    ring.setAttribute('stroke-dashoffset', circumference * (1 - progress));
}

// =========================================================================
//  Qibla Compass (القبلة) — Redesigned Live Compass
// =========================================================================

// Kaaba coordinates (WGS-84)
const KAABA_LAT = 21.4225;
const KAABA_LNG = 39.8262;

// --- Qibla state (module-level so cleanup is easy) ---
let _qibla = {
    bearing: null,           // Qibla bearing from user (degrees from true north)
    heading: 0,              // Current device heading (true north)
    rawHeading: 0,           // Unsmoothed heading
    userLat: null,
    userLng: null,
    accuracy: null,          // GPS accuracy in meters
    compassAccuracy: null,   // 'high' | 'medium' | 'low' | null
    locked: false,           // Orientation lock
    lockedHeading: 0,
    facingQibla: false,      // Within ±3° of Qibla
    view: 'compass',         // 'compass' | 'map'
    orientHandler: null,     // Ref for cleanup
    geoWatchId: null,        // Ref for cleanup
    rafId: null,             // requestAnimationFrame id
    lastUpdate: 0,
    calibrationWarning: false,
    lastHeadings: [],        // For drift detection
};

/**
 * Calculates Qibla bearing using the great-circle (forward azimuth) formula.
 *   Qibla = atan2(sin(Δλ)·cos(φ_k), cos(φ_u)·sin(φ_k) − sin(φ_u)·cos(φ_k)·cos(Δλ))
 * Returns degrees [0, 360) from true north.
 */
function calculateQiblaBearing(userLat, userLng) {
    const φ1 = userLat * Math.PI / 180;
    const φ2 = KAABA_LAT * Math.PI / 180;
    const Δλ = (KAABA_LNG - userLng) * Math.PI / 180;
    const x = Math.sin(Δλ) * Math.cos(φ2);
    const y = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    let bearing = Math.atan2(x, y) * 180 / Math.PI;
    return (bearing + 360) % 360;
}

/**
 * Haversine distance between two points in meters.
 */
function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Cardinal direction label from degrees.
 */
function cardinalDirection(deg) {
    const dirs = ['شمال', 'شمال شرق', 'شرق', 'جنوب شرق', 'جنوب', 'جنوب غرب', 'غرب', 'شمال غرب'];
    return dirs[Math.round(deg / 45) % 8];
}

/**
 * Smoothly interpolate heading to prevent jitter.
 * Uses shortest-path rotation to avoid 359° → 1° jumps.
 */
function smoothHeading(current, target, factor = 0.15) {
    let diff = target - current;
    // Normalize to [-180, 180]
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    return (current + diff * factor + 360) % 360;
}

/**
 * Clean up all Qibla listeners, watchers, animation frames.
 */
function destroyQibla() {
    if (_qibla.orientHandler) {
        window.removeEventListener('deviceorientation', _qibla.orientHandler);
        window.removeEventListener('deviceorientationabsolute', _qibla.orientHandler);
        _qibla.orientHandler = null;
    }
    if (_qibla.geoWatchId !== null) {
        navigator.geolocation.clearWatch(_qibla.geoWatchId);
        _qibla.geoWatchId = null;
    }
    if (_qibla.rafId) {
        cancelAnimationFrame(_qibla.rafId);
        _qibla.rafId = null;
    }
}

/**
 * Main render function.
 */
function renderQibla() {
    // Clean up any previous instance
    destroyQibla();
    _qibla = { ..._qibla, bearing: null, heading: 0, rawHeading: 0, userLat: null, userLng: null, accuracy: null, compassAccuracy: null, locked: false, facingQibla: false, view: 'compass', calibrationWarning: false, lastHeadings: [] };

    document.getElementById('screen-qibla').innerHTML = `
        <div class="qibla-container">
            <!-- ====== Header ====== -->
            <div class="qibla-header">
                <h2 class="qibla-title"><i class="fas fa-kaaba me-2"></i>اتجاه القبلة</h2>
                <div class="qibla-header-actions">
                    <button id="qibla-view-toggle" onclick="toggleQiblaView()" class="qibla-action-btn" aria-label="تبديل العرض">
                        <i class="fas fa-map"></i>
                    </button>
                    <button id="qibla-lock-btn" onclick="toggleQiblaLock()" class="qibla-action-btn" aria-label="قفل الاتجاه">
                        <i class="fas fa-lock-open"></i>
                    </button>
                </div>
            </div>

            <!-- ====== Compass View ====== -->
            <div id="qibla-compass-view" class="qibla-view-active">
                <!-- Heading Display -->
                <div class="qibla-heading-display">
                    <span id="qibla-heading-deg" class="qibla-heading-number">---</span>
                    <span class="qibla-heading-symbol">°</span>
                    <span id="qibla-heading-cardinal" class="qibla-heading-cardinal"></span>
                </div>

                <!-- SVG Compass -->
                <div class="qibla-compass-wrapper">
                    <svg id="qibla-compass-svg" viewBox="0 0 300 300" class="qibla-compass-svg">
                        <!-- Outer ring -->
                        <circle cx="150" cy="150" r="145" fill="none" stroke="rgba(212,175,55,0.15)" stroke-width="1"/>
                        <circle cx="150" cy="150" r="140" fill="none" stroke="rgba(212,175,55,0.08)" stroke-width="0.5"/>

                        <!-- Degree ticks (rotate with compass dial) -->
                        <g id="qibla-dial" style="transform-origin:150px 150px; transition: transform 0.08s linear;">
                            ${Array.from({ length: 72 }, (_, i) => {
        const angle = i * 5;
        const isMajor = angle % 90 === 0;
        const isMedium = angle % 45 === 0 && !isMajor;
        const isMinor10 = angle % 10 === 0 && !isMajor && !isMedium;
        const r1 = isMajor ? 110 : isMedium ? 118 : isMinor10 ? 122 : 128;
        const r2 = 132;
        const rad = angle * Math.PI / 180;
        const x1 = 150 + r1 * Math.sin(rad);
        const y1 = 150 - r1 * Math.cos(rad);
        const x2 = 150 + r2 * Math.sin(rad);
        const y2 = 150 - r2 * Math.cos(rad);
        const sw = isMajor ? 2.5 : isMedium ? 1.5 : isMinor10 ? 1 : 0.5;
        const color = isMajor ? 'rgba(212,175,55,0.9)' : isMedium ? 'rgba(212,175,55,0.5)' : 'rgba(255,255,255,0.15)';
        return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="${sw}" stroke-linecap="round"/>`;
    }).join('\n                            ')}

                            <!-- Cardinal labels (Arabic) -->
                            <text x="150" y="38" text-anchor="middle" class="qibla-cardinal-label qibla-north-label">ش</text>
                            <text x="150" y="272" text-anchor="middle" class="qibla-cardinal-label">ج</text>
                            <text x="264" y="155" text-anchor="middle" class="qibla-cardinal-label">شر</text>
                            <text x="36" y="155" text-anchor="middle" class="qibla-cardinal-label">غ</text>

                            <!-- Intercardinal labels -->
                            <text x="232" y="72" text-anchor="middle" class="qibla-intercardinal-label">ش.شر</text>
                            <text x="232" y="238" text-anchor="middle" class="qibla-intercardinal-label">ج.شر</text>
                            <text x="68" y="238" text-anchor="middle" class="qibla-intercardinal-label">ج.غ</text>
                            <text x="68" y="72" text-anchor="middle" class="qibla-intercardinal-label">ش.غ</text>

                            <!-- Qibla indicator (Kaaba icon) — positioned at Qibla angle -->
                            <g id="qibla-kaaba-indicator" style="transform-origin:150px 150px;">
                                <line id="qibla-line" x1="150" y1="150" x2="150" y2="28" stroke="rgba(212,175,55,0.3)" stroke-width="1.5" stroke-dasharray="4,4"/>
                                <g id="qibla-kaaba-icon" transform="translate(150,22)">
                                    <rect x="-10" y="-10" width="20" height="20" rx="3" fill="#1a1a2e" stroke="#d4af37" stroke-width="1.5"/>
                                    <rect x="-6" y="-6" width="12" height="12" rx="1" fill="none" stroke="#d4af37" stroke-width="0.8"/>
                                    <text x="0" y="5" text-anchor="middle" fill="#d4af37" font-size="12" font-weight="bold">🕋</text>
                                </g>
                            </g>
                        </g>

                        <!-- Fixed user direction arrow (always points up = user's facing direction) -->
                        <polygon points="150,35 143,60 157,60" fill="#ef4444" opacity="0.9"/>
                        <polygon points="150,265 143,240 157,240" fill="rgba(255,255,255,0.15)"/>

                        <!-- Center -->
                        <circle cx="150" cy="150" r="6" fill="#d4af37" opacity="0.8"/>
                        <circle cx="150" cy="150" r="3" fill="#1a1a2e"/>
                    </svg>

                    <!-- Facing Qibla glow overlay -->
                    <div id="qibla-glow" class="qibla-glow hidden"></div>
                </div>

                <!-- Qibla Info -->
                <div class="qibla-info-panel">
                    <div class="qibla-info-row">
                        <div class="qibla-info-item">
                            <i class="fas fa-kaaba text-gold"></i>
                            <div>
                                <span class="qibla-info-label">اتجاه القبلة</span>
                                <span id="qibla-bearing-text" class="qibla-info-value">---°</span>
                            </div>
                        </div>
                        <div class="qibla-info-item">
                            <i class="fas fa-bullseye text-gold"></i>
                            <div>
                                <span class="qibla-info-label">الدقة</span>
                                <span id="qibla-accuracy-text" class="qibla-info-value">---</span>
                            </div>
                        </div>
                        <div class="qibla-info-item">
                            <i class="fas fa-route text-gold"></i>
                            <div>
                                <span class="qibla-info-label">المسافة لمكة</span>
                                <span id="qibla-distance-text" class="qibla-info-value">---</span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Facing Qibla banner -->
                <div id="qibla-facing-banner" class="qibla-facing-banner hidden">
                    <span class="qibla-facing-icon">🕋</span>
                    <span class="qibla-facing-text">أنت تواجه القبلة الآن!</span>
                </div>

                <!-- Calibration Warning -->
                <div id="qibla-calibration-tip" class="qibla-calibration-tip hidden">
                    <i class="fas fa-exclamation-triangle text-amber-400 me-2"></i>
                    <span>حرّك هاتفك بشكل ∞ (رقم 8) لمعايرة البوصلة</span>
                </div>

                <!-- Action Buttons -->
                <div class="qibla-actions">
                    <button onclick="recalibrateQibla()" class="qibla-btn qibla-btn-secondary">
                        <i class="fas fa-sync-alt me-1"></i>إعادة المعايرة
                    </button>
                    <button onclick="initQiblaCompass()" class="qibla-btn qibla-btn-primary">
                        <i class="fas fa-location-dot me-1"></i>تحديد الموقع
                    </button>
                </div>
            </div>

            <!-- ====== Map View ====== -->
            <div id="qibla-map-view" class="qibla-view-hidden">
                <div id="qibla-map-container" class="qibla-map-container">
                    <div id="qibla-static-map" class="qibla-static-map">
                        <div class="qibla-map-placeholder">
                            <i class="fas fa-map-marked-alt text-4xl text-gold/50 mb-3"></i>
                            <p class="text-white/50 text-sm">اضغط "تحديد الموقع" لعرض الخريطة</p>
                        </div>
                    </div>
                </div>
                <div class="qibla-map-info">
                    <div class="qibla-map-info-item">
                        <span class="qibla-map-dot qibla-map-dot-user"></span>
                        <span>موقعك الحالي</span>
                    </div>
                    <div class="qibla-map-info-item">
                        <span class="qibla-map-dot qibla-map-dot-kaaba"></span>
                        <span>الكعبة المشرفة</span>
                    </div>
                </div>
                <button onclick="initQiblaCompass()" class="qibla-btn qibla-btn-primary w-full mt-4">
                    <i class="fas fa-location-dot me-1"></i>تحديد الموقع
                </button>
            </div>

            <!-- ====== Status bar ====== -->
            <div class="qibla-status-bar">
                <span id="qibla-status-text" class="qibla-status-text">
                    <i class="fas fa-circle text-white/30 me-1" style="font-size:6px;vertical-align:middle;"></i>
                    في انتظار تحديد الموقع...
                </span>
            </div>
        </div>`;

    // Auto-init
    initQiblaCompass();
}

/**
 * Initialize the compass: get location, start orientation tracking.
 */
window.initQiblaCompass = function () {
    const statusEl = document.getElementById('qibla-status-text');
    const setStatus = (icon, color, text) => {
        if (statusEl) statusEl.innerHTML = `<i class="fas fa-circle ${color} me-1" style="font-size:6px;vertical-align:middle;"></i>${text}`;
    };

    if (!navigator.geolocation) {
        setStatus('fa-circle', 'text-red-400', 'الموقع الجغرافي غير مدعوم في هذا المتصفح');
        return;
    }

    setStatus('fa-circle', 'text-amber-400', 'جاري تحديد الموقع...');

    // Get initial position
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            updateQiblaFromPosition(pos);
            setStatus('fa-circle', 'text-green-400', 'تم تحديد الموقع — البوصلة نشطة');
            startQiblaCompassTracking();
            startQiblaGeoWatch();
        },
        (err) => {
            console.warn('Qibla geo error:', err);
            if (err.code === 1) {
                setStatus('fa-circle', 'text-red-400', 'لم يتم السماح بالوصول للموقع');
                showQiblaPermissionHelp();
            } else {
                setStatus('fa-circle', 'text-red-400', 'فشل تحديد الموقع — حاول مرة أخرى');
            }
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
};

function updateQiblaFromPosition(pos) {
    _qibla.userLat = pos.coords.latitude;
    _qibla.userLng = pos.coords.longitude;
    _qibla.accuracy = pos.coords.accuracy;
    _qibla.bearing = calculateQiblaBearing(_qibla.userLat, _qibla.userLng);

    // Update bearing display
    const bearingEl = document.getElementById('qibla-bearing-text');
    if (bearingEl) bearingEl.textContent = Math.round(_qibla.bearing) + '°';

    // Update distance to Mecca
    const dist = haversineDistance(_qibla.userLat, _qibla.userLng, KAABA_LAT, KAABA_LNG);
    const distEl = document.getElementById('qibla-distance-text');
    if (distEl) distEl.textContent = dist > 1000 ? Math.round(dist / 1000).toLocaleString('ar-EG') + ' كم' : Math.round(dist) + ' م';

    // Update GPS accuracy
    const accEl = document.getElementById('qibla-accuracy-text');
    if (accEl) {
        if (_qibla.accuracy < 20) accEl.innerHTML = '<span class="text-green-400">عالية</span>';
        else if (_qibla.accuracy < 100) accEl.innerHTML = '<span class="text-amber-400">متوسطة</span>';
        else accEl.innerHTML = '<span class="text-red-400">منخفضة</span>';
    }

    // Position the Kaaba indicator on the dial at the correct angle
    positionQiblaKaaba();
}

function positionQiblaKaaba() {
    const indicator = document.getElementById('qibla-kaaba-indicator');
    if (!indicator || _qibla.bearing === null) return;
    indicator.style.transform = `rotate(${_qibla.bearing}deg)`;
}

/**
 * Start watching geolocation for significant changes (>500m).
 */
function startQiblaGeoWatch() {
    if (_qibla.geoWatchId !== null) navigator.geolocation.clearWatch(_qibla.geoWatchId);
    _qibla.geoWatchId = navigator.geolocation.watchPosition(
        (pos) => {
            if (_qibla.userLat !== null) {
                const moved = haversineDistance(_qibla.userLat, _qibla.userLng, pos.coords.latitude, pos.coords.longitude);
                if (moved < 500) return; // Don't recalculate for small movements
            }
            updateQiblaFromPosition(pos);
        },
        () => { }, // Silent fail on watch
        { enableHighAccuracy: true, maximumAge: 30000 }
    );
}

/**
 * Start device orientation tracking for live compass.
 */
function startQiblaCompassTracking() {
    // Remove previous listener
    if (_qibla.orientHandler) {
        window.removeEventListener('deviceorientation', _qibla.orientHandler);
        window.removeEventListener('deviceorientationabsolute', _qibla.orientHandler);
    }

    // Check support
    if (!window.DeviceOrientationEvent) {
        showQiblaStaticFallback();
        return;
    }

    // iOS 13+ requires permission
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().then(response => {
            if (response === 'granted') {
                attachOrientationListener();
            } else {
                showQiblaStaticFallback();
            }
        }).catch(() => showQiblaStaticFallback());
    } else {
        attachOrientationListener();
    }
}

function attachOrientationListener() {
    let useAbsolute = false;

    _qibla.orientHandler = function (e) {
        // Prefer webkitCompassHeading (iOS) or absolute alpha
        let heading = null;

        if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) {
            // iOS: webkitCompassHeading is degrees from magnetic north, already corrected
            heading = e.webkitCompassHeading;
        } else if (e.alpha !== null) {
            // Android: alpha is from arbitrary reference; if absolute event, it's from north
            // For absolute orientation, heading = 360 - alpha
            heading = (360 - e.alpha) % 360;
        }

        if (heading === null) return;

        _qibla.rawHeading = heading;

        // Drift detection: if heading changes > 30° per frame → calibration issue
        _qibla.lastHeadings.push(heading);
        if (_qibla.lastHeadings.length > 10) _qibla.lastHeadings.shift();
        if (_qibla.lastHeadings.length >= 5) {
            let maxDelta = 0;
            for (let i = 1; i < _qibla.lastHeadings.length; i++) {
                let d = Math.abs(_qibla.lastHeadings[i] - _qibla.lastHeadings[i - 1]);
                if (d > 180) d = 360 - d;
                maxDelta = Math.max(maxDelta, d);
            }
            const tipEl = document.getElementById('qibla-calibration-tip');
            if (maxDelta > 40 && tipEl) {
                tipEl.classList.remove('hidden');
                _qibla.calibrationWarning = true;
            } else if (maxDelta < 15 && _qibla.calibrationWarning && tipEl) {
                tipEl.classList.add('hidden');
                _qibla.calibrationWarning = false;
            }
        }

        // Compass accuracy from webkitCompassAccuracy or estimate
        if (e.webkitCompassAccuracy !== undefined) {
            _qibla.compassAccuracy = e.webkitCompassAccuracy < 15 ? 'high' : e.webkitCompassAccuracy < 30 ? 'medium' : 'low';
        }
    };

    // Try absolute first (more accurate on Android)
    const testAbsolute = (e) => {
        if (e.absolute === true || e.webkitCompassHeading !== undefined) {
            useAbsolute = true;
        }
        window.removeEventListener('deviceorientationabsolute', testAbsolute);
    };

    if ('ondeviceorientationabsolute' in window) {
        window.addEventListener('deviceorientationabsolute', _qibla.orientHandler);
    }
    window.addEventListener('deviceorientation', _qibla.orientHandler);

    // Start the render loop (throttled to ~15 FPS for battery)
    startQiblaRenderLoop();
}

/**
 * Render loop: updates compass rotation at ~15 FPS.
 * The dial rotates opposite to heading so the Kaaba stays at correct Qibla angle.
 */
function startQiblaRenderLoop() {
    if (_qibla.rafId) cancelAnimationFrame(_qibla.rafId);

    function loop(timestamp) {
        _qibla.rafId = requestAnimationFrame(loop);

        // Throttle to ~15 FPS (~66ms)
        if (timestamp - _qibla.lastUpdate < 66) return;
        _qibla.lastUpdate = timestamp;

        const targetHeading = _qibla.locked ? _qibla.lockedHeading : _qibla.rawHeading;
        _qibla.heading = smoothHeading(_qibla.heading, targetHeading, 0.2);

        // Rotate the entire dial so that the user's heading is at "up"
        // Dial rotates by -heading so north moves to the correct position
        const dial = document.getElementById('qibla-dial');
        if (dial) dial.style.transform = `rotate(${-_qibla.heading}deg)`;

        // Heading display
        const degEl = document.getElementById('qibla-heading-deg');
        const cardEl = document.getElementById('qibla-heading-cardinal');
        if (degEl) degEl.textContent = Math.round(_qibla.heading);
        if (cardEl) cardEl.textContent = cardinalDirection(_qibla.heading);

        // Check if facing Qibla (±3°)
        if (_qibla.bearing !== null) {
            let diff = Math.abs(_qibla.heading - _qibla.bearing);
            if (diff > 180) diff = 360 - diff;
            const wasFacing = _qibla.facingQibla;
            _qibla.facingQibla = diff <= 3;

            const glow = document.getElementById('qibla-glow');
            const banner = document.getElementById('qibla-facing-banner');
            if (_qibla.facingQibla) {
                if (glow) glow.classList.remove('hidden');
                if (banner) banner.classList.remove('hidden');
                // Vibrate on first facing
                if (!wasFacing && navigator.vibrate) navigator.vibrate([50, 30, 50]);
            } else {
                if (glow) glow.classList.add('hidden');
                if (banner) banner.classList.add('hidden');
            }
        }
    }

    _qibla.rafId = requestAnimationFrame(loop);
}

function showQiblaStaticFallback() {
    const statusEl = document.getElementById('qibla-status-text');
    if (statusEl) statusEl.innerHTML = '<i class="fas fa-circle text-amber-400 me-1" style="font-size:6px;vertical-align:middle;"></i>البوصلة غير مدعومة — يُعرض الاتجاه الثابت';
    // Position kaaba at correct angle, no live rotation
    positionQiblaKaaba();
    // Show heading as bearing itself
    const degEl = document.getElementById('qibla-heading-deg');
    if (degEl && _qibla.bearing !== null) degEl.textContent = Math.round(_qibla.bearing);
}

function showQiblaPermissionHelp() {
    const bearingEl = document.getElementById('qibla-bearing-text');
    if (bearingEl) bearingEl.textContent = '---°';
    // Show help text
    showToast('اذهب إلى إعدادات المتصفح > الأذونات > الموقع > اسمح', 'error');
}

// --- Interactive controls ---
window.toggleQiblaView = function () {
    const compassView = document.getElementById('qibla-compass-view');
    const mapView = document.getElementById('qibla-map-view');
    const toggleBtn = document.getElementById('qibla-view-toggle');
    if (!compassView || !mapView) return;

    if (_qibla.view === 'compass') {
        _qibla.view = 'map';
        compassView.className = 'qibla-view-hidden';
        mapView.className = 'qibla-view-active';
        if (toggleBtn) toggleBtn.innerHTML = '<i class="fas fa-compass"></i>';
        renderQiblaMap();
    } else {
        _qibla.view = 'compass';
        compassView.className = 'qibla-view-active';
        mapView.className = 'qibla-view-hidden';
        if (toggleBtn) toggleBtn.innerHTML = '<i class="fas fa-map"></i>';
    }
};

window.toggleQiblaLock = function () {
    _qibla.locked = !_qibla.locked;
    if (_qibla.locked) _qibla.lockedHeading = _qibla.heading;
    const btn = document.getElementById('qibla-lock-btn');
    if (btn) btn.innerHTML = `<i class="fas fa-${_qibla.locked ? 'lock' : 'lock-open'}"></i>`;
    showToast(_qibla.locked ? 'تم قفل البوصلة' : 'تم فك قفل البوصلة');
};

window.recalibrateQibla = function () {
    const tipEl = document.getElementById('qibla-calibration-tip');
    if (tipEl) tipEl.classList.remove('hidden');
    _qibla.lastHeadings = [];
    showToast('حرّك هاتفك بشكل ∞ (رقم 8) لمعايرة البوصلة');
};

/**
 * Render a simple map fallback using Canvas (no external library).
 * Shows user dot, Kaaba pin, and bearing line.
 */
function renderQiblaMap() {
    const container = document.getElementById('qibla-static-map');
    if (!container) return;

    if (_qibla.userLat === null || _qibla.bearing === null) {
        container.innerHTML = `
            <div class="qibla-map-placeholder">
                <i class="fas fa-map-marked-alt text-4xl text-gold/50 mb-3"></i>
                <p class="text-white/50 text-sm">اضغط "تحديد الموقع" أولاً</p>
            </div>`;
        return;
    }

    const w = container.clientWidth || 320;
    const h = 280;

    // Simple projected map: user at center, Kaaba on bearing line
    const distKm = haversineDistance(_qibla.userLat, _qibla.userLng, KAABA_LAT, KAABA_LNG) / 1000;
    const bearingRad = _qibla.bearing * Math.PI / 180;

    // Scale: place Kaaba at ~40% of radius from center
    const radius = Math.min(w, h) * 0.38;
    const cx = w / 2;
    const cy = h / 2;
    const kx = cx + radius * Math.sin(bearingRad);
    const ky = cy - radius * Math.cos(bearingRad);

    container.innerHTML = `
        <svg viewBox="0 0 ${w} ${h}" class="qibla-map-svg" style="width:100%;height:${h}px;">
            <!-- Bearing line (dashed) -->
            <line x1="${cx}" y1="${cy}" x2="${kx}" y2="${ky}" stroke="#d4af37" stroke-width="1.5" stroke-dasharray="6,4" opacity="0.6"/>

            <!-- Distance arc -->
            <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="rgba(212,175,55,0.1)" stroke-width="1" stroke-dasharray="4,4"/>

            <!-- User location -->
            <circle cx="${cx}" cy="${cy}" r="20" fill="rgba(59,130,246,0.1)" stroke="rgba(59,130,246,0.3)" stroke-width="1"/>
            <circle cx="${cx}" cy="${cy}" r="6" fill="#3b82f6"/>
            <circle cx="${cx}" cy="${cy}" r="3" fill="white" opacity="0.6"/>

            <!-- Kaaba -->
            <circle cx="${kx}" cy="${ky}" r="14" fill="rgba(212,175,55,0.15)" stroke="rgba(212,175,55,0.4)" stroke-width="1"/>
            <text x="${kx}" y="${ky + 5}" text-anchor="middle" font-size="16">🕋</text>

            <!-- Labels -->
            <text x="${cx}" y="${cy + 35}" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-size="11" font-family="Tajawal">أنت هنا</text>
            <text x="${kx}" y="${ky + 30}" text-anchor="middle" fill="#d4af37" font-size="11" font-family="Tajawal">مكة المكرمة</text>

            <!-- Distance -->
            <text x="${(cx + kx) / 2}" y="${(cy + ky) / 2 - 10}" text-anchor="middle" fill="rgba(255,255,255,0.35)" font-size="10" font-family="Tajawal">${Math.round(distKm).toLocaleString('ar-EG')} كم</text>

            <!-- North indicator -->
            <text x="${cx}" y="20" text-anchor="middle" fill="rgba(212,175,55,0.5)" font-size="11" font-family="Tajawal">↑ شمال</text>
        </svg>`;
}

// =========================================================================
//  99 Names of Allah (أسماء الله الحسنى)
// =========================================================================
function renderNames99() {
    document.getElementById('screen-names99').innerHTML = `
        <div class="card p-5">
            <div class="flex items-center justify-center gap-3 mb-3"><span class="text-3xl">✨</span><h2 class="text-2xl font-bold text-gold">أسماء الله الحسنى</h2></div>
            <p class="text-center text-white/50 text-sm mb-5">قال رسول الله ﷺ: "إن لله تسعة وتسعين اسمًا من أحصاها دخل الجنة"</p>
            <div class="mb-4">
                <input type="text" id="names99-search" placeholder="🔍 بحث في الأسماء..." class="w-full" oninput="filterNames99(this.value)">
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-3" id="names99-grid">
                ${NAMES_OF_ALLAH.map((n, i) => `
                    <div class="names99-card text-center p-3 rounded-xl border border-gold/20 hover:border-gold/50 transition cursor-pointer" onclick="showName99Detail(${i})">
                        <p class="text-2xl font-arabic text-gold mb-1">${escapeHtml(n.name)}</p>
                        <p class="text-xs text-white/50">${escapeHtml(n.meaning)}</p>
                    </div>`).join('')}
            </div>
        </div>`;
}

window.filterNames99 = function (q) {
    const cards = document.querySelectorAll('.names99-card');
    cards.forEach((card, i) => {
        const match = NAMES_OF_ALLAH[i].name.includes(q) || NAMES_OF_ALLAH[i].meaning.includes(q);
        card.style.display = match || !q.trim() ? '' : 'none';
    });
};

window.showName99Detail = function (i) {
    const n = NAMES_OF_ALLAH[i];
    if (!n) return;
    showToast(`${n.name} - ${n.meaning}`, 'info');
};

// =========================================================================
//  Hadith of the Day (حديث اليوم) + Hadith API Integration
// =========================================================================
let currentHadithCollection = 'bukhari';
const hadithApiCache = {};

async function fetchHadithFromAPI(edition, hadithNumber) {
    const cacheKey = `${edition}_${hadithNumber}`;
    if (hadithApiCache[cacheKey]) return hadithApiCache[cacheKey];
    if (!rateLimitOk('hadith_api', 2000)) return null;

    try {
        const resp = await fetch(`${HADITH_API_BASE}/editions/${edition}/${hadithNumber}.min.json`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (data.hadiths && data.hadiths.length > 0) {
            const result = {
                text: data.hadiths[0].text,
                number: data.hadiths[0].hadithnumber || hadithNumber,
                collection: data.metadata?.name || edition,
                grades: data.hadiths[0].grades || [],
                reference: data.hadiths[0].reference || {}
            };
            hadithApiCache[cacheKey] = result;
            return result;
        }
        throw new Error('No hadith data');
    } catch (err) {
        // Try fallback minified URL
        try {
            const resp2 = await fetch(`${HADITH_API_BASE}/editions/${edition}/${hadithNumber}.json`);
            if (!resp2.ok) throw new Error(`HTTP ${resp2.status}`);
            const data2 = await resp2.json();
            if (data2.hadiths && data2.hadiths.length > 0) {
                const result = {
                    text: data2.hadiths[0].text,
                    number: data2.hadiths[0].hadithnumber || hadithNumber,
                    collection: data2.metadata?.name || edition,
                    grades: data2.hadiths[0].grades || [],
                    reference: data2.hadiths[0].reference || {}
                };
                hadithApiCache[cacheKey] = result;
                return result;
            }
        } catch { }
        return null;
    }
}

// Truncate long hadith text (full sanad chains can be very long)
function truncateHadithText(text, maxLen = 500) {
    if (!text || text.length <= maxLen) return text;
    return text.substring(0, maxLen).replace(/\s+\S*$/, '') + '...';
}

function renderHadith() {
    const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
    const todayHadith = DAILY_HADITHS[dayOfYear % DAILY_HADITHS.length];

    document.getElementById('screen-hadith').innerHTML = `
        <div class="card p-6 text-center">
            <div class="flex items-center justify-center gap-3 mb-5"><span class="text-3xl">📜</span><h2 class="text-2xl font-bold text-gold">حديث اليوم</h2></div>
            <div class="bg-gradient-islamic border-2 border-gold/30 rounded-2xl p-6 mb-5">
                <p class="text-xl font-arabic text-[var(--text-primary)] leading-relaxed mb-3">"${escapeHtml(todayHadith.text)}"</p>
                <div class="flex items-center justify-center gap-3 text-sm">
                    <span class="text-gold">${escapeHtml(todayHadith.source)}</span>
                    <span class="bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full text-xs">${escapeHtml(todayHadith.grade)}</span>
                </div>
            </div>
            <button onclick="shareHadith()" class="bg-gold/10 border border-gold/30 text-gold px-6 py-2 rounded-xl transition hover:bg-gold/20 ripple-btn">
                <i class="fas fa-share-alt me-1"></i> مشاركة الحديث
            </button>
        </div>

        <!-- Collection Browser -->
        <div class="card p-5 mt-4">
            <h3 class="font-bold text-lg mb-4 text-gold"><i class="fas fa-book me-2"></i>تصفح كتب الحديث</h3>
            <div class="flex flex-wrap gap-2 mb-4" id="hadith-collection-tabs">
                ${HADITH_COLLECTIONS.map(c => `
                    <button onclick="selectHadithCollection('${c.id}')" 
                        class="hadith-tab px-3 py-1.5 rounded-lg text-xs border transition ${c.id === currentHadithCollection ? 'bg-gold/20 border-gold/50 text-gold' : 'bg-white/5 border-white/10 text-white/60 hover:border-gold/30'}"
                        data-collection="${c.id}">
                        ${c.icon} ${escapeHtml(c.name)}
                    </button>`).join('')}
            </div>
            <div class="flex gap-2 mb-4">
                <input type="number" id="hadith-number-input" placeholder="رقم الحديث" min="1" 
                    class="flex-1 text-center" style="direction:ltr"
                    onkeydown="if(event.key==='Enter')loadHadithByNumber()">
                <button onclick="loadHadithByNumber()" class="bg-gold/10 border border-gold/30 text-gold px-4 py-2 rounded-xl transition hover:bg-gold/20 ripple-btn text-sm">
                    <i class="fas fa-search"></i>
                </button>
                <button onclick="loadRandomHadith()" class="bg-gold/10 border border-gold/30 text-gold px-4 py-2 rounded-xl transition hover:bg-gold/20 ripple-btn text-sm">
                    <i class="fas fa-random"></i> عشوائي
                </button>
            </div>
            <div id="hadith-api-result" class="min-h-[100px]">
                <p class="text-center text-white/40 text-sm py-8">اختر كتاباً واضغط "عشوائي" أو أدخل رقم الحديث</p>
            </div>
        </div>

        <!-- Local Hadiths -->
        <div class="card p-5 mt-4">
            <h3 class="font-bold text-lg mb-4 text-gold"><i class="fas fa-book-open me-2"></i>أحاديث مختارة</h3>
            <div class="space-y-3">
                ${DAILY_HADITHS.slice(0, 10).map(h => `
                    <div class="bg-white/5 p-3 rounded-xl border border-white/10">
                        <p class="font-arabic text-[var(--text-primary)] leading-relaxed text-sm">"${escapeHtml(h.text)}"</p>
                        <div class="flex items-center gap-2 mt-1 text-xs">
                            <span class="text-gold/70">${escapeHtml(h.source)}</span>
                            <span class="bg-green-500/10 text-green-400 px-1.5 py-0.5 rounded text-xs">${escapeHtml(h.grade)}</span>
                        </div>
                    </div>`).join('')}
            </div>
        </div>`;

    // Auto-load a random hadith from current collection on render
    loadRandomHadith();
}

window.selectHadithCollection = function (collectionId) {
    currentHadithCollection = collectionId;
    // Update tabs styling
    document.querySelectorAll('.hadith-tab').forEach(tab => {
        if (tab.dataset.collection === collectionId) {
            tab.className = 'hadith-tab px-3 py-1.5 rounded-lg text-xs border transition bg-gold/20 border-gold/50 text-gold';
        } else {
            tab.className = 'hadith-tab px-3 py-1.5 rounded-lg text-xs border transition bg-white/5 border-white/10 text-white/60 hover:border-gold/30';
        }
    });
    // Update max for input
    const col = HADITH_COLLECTIONS.find(c => c.id === collectionId);
    const input = document.getElementById('hadith-number-input');
    if (input && col) input.max = col.maxHadith;
};

window.loadHadithByNumber = async function () {
    const input = document.getElementById('hadith-number-input');
    const num = parseInt(input?.value);
    if (!num || num < 1) {
        showToast('أدخل رقم حديث صحيح', 'warning');
        return;
    }
    const col = HADITH_COLLECTIONS.find(c => c.id === currentHadithCollection);
    if (!col) return;
    if (num > col.maxHadith) {
        showToast(`أقصى رقم في ${col.name}: ${col.maxHadith}`, 'warning');
        return;
    }
    await displayApiHadith(col, num);
};

window.loadRandomHadith = async function () {
    const col = HADITH_COLLECTIONS.find(c => c.id === currentHadithCollection);
    if (!col) return;
    const randomNum = Math.floor(Math.random() * col.maxHadith) + 1;
    await displayApiHadith(col, randomNum);
};

async function displayApiHadith(col, hadithNum) {
    const container = document.getElementById('hadith-api-result');
    if (!container) return;

    container.innerHTML = `
        <div class="flex items-center justify-center py-8">
            <div class="w-8 h-8 border-2 border-gold/30 border-t-gold rounded-full animate-spin"></div>
            <span class="ms-3 text-white/50 text-sm">جاري التحميل...</span>
        </div>`;

    const result = await fetchHadithFromAPI(col.edition, hadithNum);

    if (result) {
        const displayText = truncateHadithText(result.text, 600);
        const gradeText = result.grades.length > 0
            ? result.grades.map(g => `${g.name || ''}: ${g.grade || ''}`).filter(Boolean).join(' | ')
            : '';

        container.innerHTML = `
            <div class="bg-gradient-islamic border border-gold/20 rounded-2xl p-5">
                <div class="flex items-center justify-between mb-3">
                    <span class="text-gold text-sm font-bold">${col.icon} ${escapeHtml(col.name)}</span>
                    <span class="bg-gold/10 text-gold/80 px-2 py-0.5 rounded-full text-xs">حديث رقم ${result.number}</span>
                </div>
                <p class="font-arabic text-[var(--text-primary)] leading-loose text-base mb-3">${escapeHtml(displayText)}</p>
                ${gradeText ? `<p class="text-xs text-white/40 mb-3"><i class="fas fa-check-circle me-1 text-green-400"></i>${escapeHtml(gradeText)}</p>` : ''}
                <div class="flex items-center gap-2 mt-3 pt-3 border-t border-white/10">
                    <button onclick="shareApiHadith()" class="text-xs bg-gold/10 border border-gold/30 text-gold px-3 py-1.5 rounded-lg transition hover:bg-gold/20 ripple-btn">
                        <i class="fas fa-share-alt me-1"></i> مشاركة
                    </button>
                    <button onclick="loadRandomHadith()" class="text-xs bg-white/5 border border-white/10 text-white/60 px-3 py-1.5 rounded-lg transition hover:bg-white/10 ripple-btn">
                        <i class="fas fa-random me-1"></i> حديث آخر
                    </button>
                    ${result.text.length > 600 ? `
                    <button onclick="this.parentElement.parentElement.querySelector('.hadith-full-text').classList.toggle('hidden');this.textContent=this.textContent.includes('المزيد')?'إخفاء':'المزيد'" 
                        class="text-xs text-gold/70 hover:text-gold transition mr-auto">المزيد</button>
                    <div class="hadith-full-text hidden w-full mt-3">
                        <p class="font-arabic text-[var(--text-primary)] leading-loose text-sm">${escapeHtml(result.text)}</p>
                    </div>` : ''}
                </div>
            </div>`;

        // Store for sharing
        window._lastApiHadith = { text: result.text, collection: col.name, number: result.number };
    } else {
        container.innerHTML = `
            <div class="text-center py-6">
                <p class="text-white/40 text-sm mb-3"><i class="fas fa-exclamation-triangle me-1 text-yellow-400"></i>لم يتم العثور على الحديث</p>
                <button onclick="loadRandomHadith()" class="text-xs bg-gold/10 border border-gold/30 text-gold px-4 py-2 rounded-lg transition hover:bg-gold/20 ripple-btn">
                    <i class="fas fa-random me-1"></i> جرب حديث آخر
                </button>
            </div>`;
    }
}

window.shareApiHadith = async function () {
    const h = window._lastApiHadith;
    if (!h) return;
    const shortText = truncateHadithText(h.text, 300);
    const text = `📜 ${h.collection} - حديث رقم ${h.number}:\n"${shortText}"\n\nمن تطبيق Nafs Tracker`;
    if (navigator.share) {
        try { await navigator.share({ title: h.collection, text }); } catch { }
    } else {
        try { await navigator.clipboard.writeText(text); showToast('تم نسخ الحديث 📋'); } catch { }
    }
};

window.shareHadith = async function () {
    const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
    const h = DAILY_HADITHS[dayOfYear % DAILY_HADITHS.length];
    const text = `📜 حديث اليوم:\n"${h.text}"\n- ${h.source} (${h.grade})\n\nمن تطبيق Nafs Tracker`;
    if (navigator.share) {
        try { await navigator.share({ title: 'حديث اليوم', text }); } catch { }
    } else {
        try { await navigator.clipboard.writeText(text); showToast('تم نسخ الحديث 📋'); } catch { }
    }
};


function renderDua() {
    let activeCat = 0;
    document.getElementById('screen-dua').innerHTML = `
        <div class="card p-5">
            <div class="flex items-center justify-center gap-3 mb-5"><span class="text-3xl">🤲</span><h2 class="text-2xl font-bold text-gold">أدعية مصنفة</h2></div>
            <div class="flex flex-wrap gap-2 mb-5" id="dua-categories">
                ${DUA_CATEGORIES.map((cat, i) => `<button onclick="showDuaCategory(${i})" class="dua-cat-btn ${i === 0 ? 'active' : ''} px-3 py-1.5 rounded-full text-sm border border-gold/30 transition hover:bg-gold/20">${cat.icon} ${escapeHtml(cat.name)}</button>`).join('')}
            </div>
            <div id="dua-content" class="space-y-4"></div>
        </div>`;
    showDuaCategory(0);
}

window.showDuaCategory = function (idx) {
    document.querySelectorAll('.dua-cat-btn').forEach((b, i) => b.classList.toggle('active', i === idx));
    const cat = DUA_CATEGORIES[idx];
    const container = document.getElementById('dua-content');
    if (!container || !cat) return;
    container.innerHTML = cat.duas.map((d, i) => `
        <div class="bg-white/5 border border-white/10 rounded-xl p-4 hover:bg-white/10 transition">
            <p class="font-arabic text-lg leading-relaxed text-[var(--text-primary)] mb-2">${escapeHtml(d.text)}</p>
            <div class="flex items-center justify-between">
                <span class="text-xs text-gold/70">💡 ${escapeHtml(d.virtue)}</span>
                <button onclick="shareDua(${idx},${i})" class="text-xs text-gold hover:text-gold/80 transition"><i class="fas fa-share-alt"></i></button>
            </div>
        </div>`).join('');
};

window.shareDua = async function (catIdx, duaIdx) {
    const d = DUA_CATEGORIES[catIdx]?.duas[duaIdx];
    if (!d) return;
    const text = `🤲 ${d.text}\n\n💡 ${d.virtue}\n\nمن تطبيق Nafs Tracker`;
    if (navigator.share) {
        try { await navigator.share({ title: 'دعاء', text }); } catch { }
    } else {
        try { await navigator.clipboard.writeText(text); showToast('تم نسخ الدعاء 📋'); } catch { }
    }
};

// =========================================================================
//  Surah Reading Modal
// =========================================================================
function initSurahReadingModal() {
    if (document.getElementById('surah-reading-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'surah-reading-modal';
    modal.className = 'modal-overlay';
    modal.setAttribute('data-closable', 'true');
    modal.style.display = 'none';
    document.body.appendChild(modal);
}

// =========================================================================
//  Service Worker Registration & Update Handling
// =========================================================================

// =========================================================================
//  Share Progress as Image (Canvas API)
// =========================================================================
window.shareProgressAsImage = async function () {
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 600;
        canvas.height = 400;
        const ctx = canvas.getContext('2d');

        // Background
        const gradient = ctx.createLinearGradient(0, 0, 600, 400);
        gradient.addColorStop(0, '#081f16');
        gradient.addColorStop(1, '#0a2f1f');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 600, 400);

        // Decorative border
        ctx.strokeStyle = 'rgba(201,168,76,0.3)';
        ctx.lineWidth = 2;
        ctx.strokeRect(15, 15, 570, 370);

        // Title
        ctx.fillStyle = '#c9a84c';
        ctx.font = 'bold 28px Tajawal, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('🌙 Nafs Tracker', 300, 55);

        // Stats
        ctx.fillStyle = '#f2ead8';
        ctx.font = 'bold 20px Tajawal, sans-serif';
        ctx.fillText(`🔥 سلسلة ${appState?.streak || 0} يوم`, 300, 120);
        ctx.fillText(`⭐ ${appState?.totalPoints || 0} نقطة`, 300, 160);
        ctx.fillText(`📖 المستوى ${appState?.level || 1}`, 300, 200);

        // Today's pages
        const todayPages = appState?.quranProgress?.dailyPages?.[getLocalDateString()] || 0;
        ctx.fillText(`📖 قراءة اليوم: ${todayPages} صفحة`, 300, 240);

        // Fasting count this month
        const fastingCount = countMonthlyFasting();
        if (fastingCount > 0) ctx.fillText(`🌙 صيام هذا الشهر: ${fastingCount} يوم`, 300, 280);

        // Footer
        ctx.fillStyle = 'rgba(201,168,76,0.5)';
        ctx.font = '14px Tajawal, sans-serif';
        ctx.fillText('nafs-tracker-live.vercel.app', 300, 360);

        // Convert to blob and share
        canvas.toBlob(async (blob) => {
            if (!blob) { showToast('تعذر إنشاء الصورة', 'error'); return; }
            const file = new File([blob], 'nafs-progress.png', { type: 'image/png' });

            if (navigator.share && navigator.canShare?.({ files: [file] })) {
                try {
                    await navigator.share({ files: [file], title: 'إنجازاتي في Nafs Tracker' });
                } catch (e) { if (e.name !== 'AbortError') downloadCanvasImage(blob); }
            } else {
                downloadCanvasImage(blob);
            }
        }, 'image/png');
    } catch (e) {
        console.error('[Nafs] Share image error:', e);
        showToast('تعذر إنشاء الصورة', 'error');
    }
};

function downloadCanvasImage(blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nafs-progress-${getLocalDateString()}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('تم تحميل الصورة 🖼️');
}

// =========================================================================
//  Night Reading Mode (Mushaf)
// =========================================================================
let _mushafNightMode = false;

window.toggleMushafNightMode = function () {
    _mushafNightMode = !_mushafNightMode;
    const mushafScreen = document.getElementById('screen-mushaf');
    if (mushafScreen) mushafScreen.classList.toggle('mushaf-night-mode', _mushafNightMode);
    safeLocalStorageSet('nafs_mushaf_night', _mushafNightMode ? '1' : '0');
    showToast(_mushafNightMode ? '🌙 وضع القراءة الليلية' : '☀️ الوضع العادي');
    // Update the toggle button icon
    const btn = mushafScreen?.querySelector('.mushaf-top-bar .mushaf-fullscreen-btn');
    if (btn) btn.innerHTML = `<i class="fas ${_mushafNightMode ? 'fa-sun' : 'fa-moon'}"></i>`;
};

function loadMushafNightMode() {
    _mushafNightMode = safeLocalStorageGet('nafs_mushaf_night') === '1';
    const mushafScreen = document.getElementById('screen-mushaf');
    if (mushafScreen && _mushafNightMode) mushafScreen.classList.add('mushaf-night-mode');
}

// =========================================================================
//  Fasting Tracker (تتبع الصيام)
// =========================================================================
function renderFasting() {
    if (!appState.fastingLogs) appState.fastingLogs = {};
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const monthName = today.toLocaleDateString('ar-EG', { month: 'long', year: 'numeric' });

    // Sunnah fasting days this month
    const sunnahDays = getSunnahFastingDays(year, month);
    const fastingCount = countMonthlyFasting();

    let daysHtml = '';
    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const isFasted = appState.fastingLogs[dateStr];
        const isToday = d === today.getDate();
        const isSunnah = sunnahDays.includes(d);
        const classes = `fasting-day-btn ${isFasted ? 'fasted' : ''} ${isToday ? 'today' : ''}`;
        const title = isSunnah ? 'يوم سنة' : '';
        daysHtml += `<button class="${classes}" onclick="toggleFasting('${dateStr}')" title="${title}">
            ${d}${isSunnah ? '<span style="position:absolute;top:-2px;right:-2px;font-size:6px;color:#c9a84c">●</span>' : ''}
        </button>`;
    }

    document.getElementById('screen-fasting').innerHTML = `
        <div class="card p-5 space-y-4">
            <div class="flex items-center gap-3"><span class="text-3xl">🌙</span><h2 class="text-2xl font-bold text-gold">تتبع الصيام</h2></div>

            <div class="grid grid-cols-3 gap-3 text-center">
                <div class="card p-3 glass-card">
                    <p class="text-2xl font-black text-gold">${fastingCount}</p>
                    <p class="text-xs text-[var(--text-muted)]">يوم هذا الشهر</p>
                </div>
                <div class="card p-3 glass-card">
                    <p class="text-2xl font-black text-gold">${Object.keys(appState.fastingLogs).length}</p>
                    <p class="text-xs text-[var(--text-muted)]">إجمالي الأيام</p>
                </div>
                <div class="card p-3 glass-card">
                    <p class="text-2xl font-black text-gold">${getFastingStreak()}</p>
                    <p class="text-xs text-[var(--text-muted)]">أطول سلسلة</p>
                </div>
            </div>

            <div>
                <h3 class="text-lg font-bold text-gold mb-3">${monthName}</h3>
                <p class="text-xs text-[var(--text-muted)] mb-2">● أيام السنة (الإثنين، الخميس، الأيام البيض)</p>
                <div class="grid grid-cols-7 gap-2 justify-items-center" style="position:relative">
                    ${daysHtml}
                </div>
            </div>

            <div class="card p-4" style="background:rgba(201,168,76,0.05);border:1px solid rgba(201,168,76,0.15)">
                <h4 class="text-sm font-bold text-gold mb-2">🕌 أيام السنة القادمة</h4>
                <p class="text-sm text-[var(--text-secondary)]">${getUpcomingSunnahDaysText()}</p>
            </div>
        </div>`;
}

window.toggleFasting = async function (dateStr) {
    if (!appState.fastingLogs) appState.fastingLogs = {};
    if (appState.fastingLogs[dateStr]) {
        delete appState.fastingLogs[dateStr];
    } else {
        appState.fastingLogs[dateStr] = true;
        // Award points for fasting
        appState.totalPoints = (appState.totalPoints || 0) + 15;
        appState.level = Math.floor(appState.totalPoints / 100) + 1;
        await saveUserField('totalPoints', appState.totalPoints);
        await saveUserField('level', appState.level);
        showToast('🌙 بارك الله في صيامك! +15 نقطة');
    }
    await saveUserField('fastingLogs', appState.fastingLogs);
    renderFasting();
};

function countMonthlyFasting() {
    if (!appState?.fastingLogs) return 0;
    const now = new Date();
    const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    return Object.keys(appState.fastingLogs).filter(k => k.startsWith(prefix)).length;
}

function getFastingStreak() {
    if (!appState?.fastingLogs) return 0;
    const dates = Object.keys(appState.fastingLogs).sort().reverse();
    if (dates.length === 0) return 0;
    let streak = 1;
    for (let i = 1; i < dates.length; i++) {
        const prev = new Date(dates[i - 1]);
        const curr = new Date(dates[i]);
        const diff = (prev - curr) / (1000 * 60 * 60 * 24);
        if (Math.abs(diff - 1) < 0.5) streak++;
        else break;
    }
    return streak;
}

function getSunnahFastingDays(year, month) {
    const days = [];
    for (let d = 1; d <= 31; d++) {
        const date = new Date(year, month, d);
        if (date.getMonth() !== month) break;
        const dow = date.getDay(); // 0=Sun, 1=Mon, 4=Thu
        if (dow === 1 || dow === 4) days.push(d); // Monday & Thursday
    }
    // Ayyam al-Beed (13, 14, 15 of each Hijri month — approximate with Gregorian 13-15)
    [13, 14, 15].forEach(d => { if (d <= new Date(year, month + 1, 0).getDate() && !days.includes(d)) days.push(d); });
    return days.sort((a, b) => a - b);
}

function getUpcomingSunnahDaysText() {
    const now = new Date();
    const sunnahDays = getSunnahFastingDays(now.getFullYear(), now.getMonth());
    const upcoming = sunnahDays.filter(d => d > now.getDate()).slice(0, 3);
    if (upcoming.length === 0) return 'لا توجد أيام متبقية هذا الشهر';
    const dayNames = upcoming.map(d => {
        const date = new Date(now.getFullYear(), now.getMonth(), d);
        const name = date.toLocaleDateString('ar-EG', { weekday: 'long' });
        return `${name} ${d}`;
    });
    return dayNames.join(' — ');
}

/**
 * Show a styled floating banner when a SW update is available.
 * Clicking the banner tells the waiting worker to activate, which triggers
 * the 'controllerchange' listener → automatic page reload.
 * @param {ServiceWorker} waitingWorker - the installed-but-waiting SW
 */
function showUpdateBanner(waitingWorker) {
    // Remove any existing banner first
    const existing = document.getElementById('sw-update-banner');
    if (existing) existing.remove();

    // --- Container ---
    const banner = document.createElement('div');
    banner.id = 'sw-update-banner';
    Object.assign(banner.style, {
        position: 'fixed',
        bottom: '96px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: '200',
        maxWidth: '92%',
        width: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '14px 20px',
        borderRadius: '16px',
        background: 'rgba(10, 47, 31, 0.97)',
        border: '1px solid rgba(200, 170, 78, 0.5)',
        color: '#f2ead8',
        fontFamily: 'Tajawal, sans-serif',
        boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        animation: 'swBannerSlideUp 0.35s ease-out',
        cursor: 'default'
    });

    // --- Icon ---
    const icon = document.createElement('span');
    icon.textContent = '🔄';
    icon.style.fontSize = '20px';
    icon.style.flexShrink = '0';
    banner.appendChild(icon);

    // --- Message ---
    const msg = document.createElement('span');
    msg.style.fontSize = '14px';
    msg.style.lineHeight = '1.5';
    msg.textContent = 'يتوفر إصدار جديد. اضغط "تحديث" للتحديث.';
    banner.appendChild(msg);

    // --- Update button ---
    const updateBtn = document.createElement('button');
    updateBtn.textContent = 'تحديث';
    Object.assign(updateBtn.style, {
        background: 'rgba(200, 170, 78, 0.2)',
        border: '1px solid rgba(200, 170, 78, 0.5)',
        color: '#c9a84c',
        padding: '6px 16px',
        borderRadius: '10px',
        cursor: 'pointer',
        fontWeight: '700',
        fontSize: '13px',
        fontFamily: 'Tajawal, sans-serif',
        whiteSpace: 'nowrap',
        transition: 'background 0.2s'
    });
    updateBtn.addEventListener('mouseenter', () => { updateBtn.style.background = 'rgba(200, 170, 78, 0.35)'; });
    updateBtn.addEventListener('mouseleave', () => { updateBtn.style.background = 'rgba(200, 170, 78, 0.2)'; });
    updateBtn.addEventListener('click', () => {
        waitingWorker.postMessage({ type: 'SKIP_WAITING' });
        banner.remove();
    });
    banner.appendChild(updateBtn);

    // --- Close button ---
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '&times;';
    Object.assign(closeBtn.style, {
        background: 'none',
        border: 'none',
        color: 'rgba(255,255,255,0.4)',
        cursor: 'pointer',
        fontSize: '18px',
        padding: '0 2px',
        lineHeight: '1',
        transition: 'color 0.2s'
    });
    closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = 'rgba(255,255,255,0.7)'; });
    closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = 'rgba(255,255,255,0.4)'; });
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); banner.remove(); });
    banner.appendChild(closeBtn);

    // --- Inject slide-up animation (once) ---
    if (!document.getElementById('sw-banner-keyframes')) {
        const style = document.createElement('style');
        style.id = 'sw-banner-keyframes';
        style.textContent = `@keyframes swBannerSlideUp { from { opacity: 0; transform: translateX(-50%) translateY(20px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }`;
        document.head.appendChild(style);
    }

    document.body.appendChild(banner);
}

/**
 * Register the service worker and wire up coordinated update flow.
 * Safe to call at module load — guards against missing API.
 */
function initServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('/sw.js').then(reg => {
        // A waiting worker already exists → activate it immediately
        if (reg.waiting) {
            reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }

        // Detect newly installed workers
        reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            if (!newWorker) return;
            newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    // Auto-activate without prompting
                    newWorker.postMessage({ type: 'SKIP_WAITING' });
                }
            });
        });

        // When the new SW activates and takes control → reload
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (refreshing) return;
            refreshing = true;
            window.location.reload();
        });

        // Periodically check for updates (every 60 min)
        setInterval(() => { reg.update().catch(() => { }); }, 60 * 60 * 1000);

    }).catch(err => console.warn('[SW] Registration failed:', err));
}

// Start SW registration immediately (module scripts are deferred)
initServiceWorker();

// =========================================================================
//  Auth Observer
// =========================================================================
initSurahReadingModal();

if (authUnsubscribe) authUnsubscribe();

// FIX: Improved auth observer with proper loading screen handling
authUnsubscribe = auth.onAuthStateChanged(async (user) => {
    // Always start with loading screen visible
    const loadingScreen = document.getElementById('loading-screen');
    const appDiv = document.getElementById('app');

    if (user) {
        // FIX: prevent double initialization
        if (currentUser?.uid === user.uid && appInitialized) {
            loadingScreen.style.display = 'none';
            appDiv.style.display = 'block';
            return;
        }
        currentUser = user;
        userId = user.uid;
        appInitialized = false;
        try {
            appState = await loadUserData(userId);
            const cachedPrayer = safeLocalStorageGet('nafs_prayer_cache');
            if (cachedPrayer) {
                const p = safeJsonParse(cachedPrayer);
                if (p && p.Fajr) prayerTimesCache = p;
            }
            await recalculateTotalPoints();
            // Prune data older than 90 days (runs once per session, non-blocking)
            pruneOldData().catch(() => { });
            loadAppFontSize();
            startDailyResetChecker();
            startReminderChecker();
            initBackToTop();
            restoreOfflineQueue();
            renderMainApp();
            loadMushafNightMode();
            // Show onboarding for first-time users
            if (!safeLocalStorageGet('nafs_onboarding_v2_done')) {
                showOnboarding();
            } else {
                // Show what's new for returning users (once per version)
                showWhatsNew();
            }
            loadingScreen.style.display = 'none';
            appDiv.style.display = 'block';
        } catch (error) {
            console.error('App init error:', error);
            loadingScreen.style.display = 'none';
            appDiv.style.display = 'block';
            showToast('خطأ في تحميل التطبيق: ' + error.message, 'error');
        }
    } else {
        appInitialized = false;
        currentUser = null; userId = null; appState = null;
        if (reminderIntervalId) { clearInterval(reminderIntervalId); reminderIntervalId = null; }
        loadingScreen.style.display = 'none';
        appDiv.style.display = 'block';
        renderLoginScreen();
    }
});
