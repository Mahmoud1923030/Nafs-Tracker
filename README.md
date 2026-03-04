# 🌙 Nafs Tracker — متتبع العبادات اليومية

تطبيق إسلامي شامل لمتابعة العبادات اليومية، مبني كـ Progressive Web App (PWA) مجاني وبدون إعلانات.

## ✨ المميزات

- 📿 **أذكار** — صباح ومساء وبعد الصلاة، مع مصادر موثقة
- 🕌 **الصلاة** — مواقيت دقيقة، تسجيل مفصل، وإشعارات الأذان
- 📖 **القرآن** — مصحف كامل، استماع لأشهر القراء، وتتبع الختمة
- 🧿 **السبحة الإلكترونية** — مع اهتزاز وصوت
- 🧭 **القبلة** — بوصلة ذكية
- ✨ **أسماء الله الحسنى** — الـ 99 اسم مع المعاني
- 📜 **حديث اليوم** — موثق بالمصدر
- 🤲 **أدعية** — مصنفة لكل مناسبة
- 📊 **تحليلات** — إحصاءات أسبوعية وشهرية
- 📔 **يوميات** — مع تتبع الحالة المزاجية
- 🏆 **نقاط وشارات** — نظام gamification كامل
- 🌙 **Emergency Mode** — لحظة تهدئة روحية

## 🛠️ التقنيات

- Vanilla JavaScript (ES Modules)
- Firebase (Auth + Firestore)
- Tailwind CSS
- Service Worker (PWA + Offline)
- Web Audio API

## ⚙️ Setup

1. Copy `js/firebase-config.example.js` → `js/firebase-config.js`
2. Fill in your Firebase project credentials
3. **Never** commit `firebase-config.js` — it's in `.gitignore`

## 🚀 التشغيل المحلي

```bash
npm install
npm run dev
```

## 🏗️ البناء للإنتاج

```bash
npm run build
```

## 🌐 الرابط المباشر

[nafs-tracker-live.vercel.app](https://nafs-tracker-live.vercel.app)
