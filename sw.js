const CACHE_NAME = 'mystore-shell-v15';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-maskable-192.png',
  './assets/icon-maskable-512.png',
  './stamp.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('mystore-shell-') && k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch { payload = { body: event.data?.text() || '' }; }
  event.waitUntil(self.registration.showNotification(String(payload.title || 'سجل الديون').slice(0, 80), {
    body: String(payload.body || 'لديك تحديث جديد في المتجر.').slice(0, 180),
    icon: './assets/icon-192.png',   // لا badge: الأيقونة الملوّنة تظهر مربعاً أبيض على أندرويد؛ أضف badge أحادي اللون عند توفره
    dir: 'rtl', lang: 'ar',
    tag: String(payload.tag || 'mystore-update').slice(0, 64),
    renotify: false,
    data: { url: payload.url || './' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const scope = new URL(self.registration.scope);
  let target = scope;
  try {
    const requested = new URL(event.notification.data?.url || './', scope);
    if (requested.origin === scope.origin) target = requested;
  } catch { /* الصفحة الرئيسية */ }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(c => new URL(c.url).origin === scope.origin);
    if (!existing) return self.clients.openWindow(target.href);
    try { await existing.focus(); } catch { /* تجاهل */ }
    // لا نعيد تحميل التطبيق إن كان الهدف الصفحة الرئيسية
    if (target.href !== scope.href && existing.url !== target.href) { try { await existing.navigate(target.href); } catch { /* تجاهل */ } }
  })());
});

// المتصفح بدّل اشتراك الدفع: نُنبّه الصفحة لتعيد المزامنة
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(ws => ws.forEach(c => c.postMessage({ type: 'push-resync' }))));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  // لا نخزن طلبات Supabase أو أي بيانات مالية
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  const store = response => {
    if (response.ok && response.status === 200 && response.type === 'basic') {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(c => c.put(request, copy)).catch(() => {});
    }
    return response;
  };

  // الصفحة: الشبكة أولاً (تصل التحديثات فوراً) والكاش احتياطاً دون اتصال
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(store).catch(() => caches.match(request).then(c => c || caches.match('./index.html'))));
    return;
  }
  // بقية الملفات الثابتة: الكاش أولاً، ولا تُخزَّن الردود الفاشلة
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(store)));
});
