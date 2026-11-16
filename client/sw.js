/* Service worker Temp Messenger — шаблон.
 * При сборке плагин из vite.config.ts подставляет VERSION (хеш всех файлов сборки) и PRECACHE
 * (их список) и кладёт результат в dist/sw.js. Любое изменение сборки меняет байты sw.js,
 * и браузер видит новую версию.
 *
 * Модель: оболочка приложения целиком лежит в кеше и отдаётся оттуда, даже без сети.
 * Новая версия скачивается в фоне и ждёт (waiting), пока пользователь не нажмёт
 * «Обновить» — код мессенджера не подменяется посреди сессии без спроса.
 */
const VERSION = '__VERSION__'
const PRECACHE = __PRECACHE__
const CACHE = `tm-${VERSION}`

self.addEventListener('install', (event) => {
  // cache: 'reload' — мимо HTTP-кеша, чтобы не закешировать устаревший index.html
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })))),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('tm-') && key !== CACHE) await caches.delete(key)
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting()
  if (event.data === 'pushTest') testUntil = Date.now() + 30_000
})

/* Пуш от сервера пустой: он лишь сообщает, что в каком-то ящике ждёт сообщение. Что и от кого —
 * знает только само приложение, поэтому текст уведомления всегда один и тот же.
 * Показывать уведомление нужно на каждый пуш: иначе Safari и Chrome отзывают подписку.
 * Если приложение уже на экране, уведомление беззвучное и сразу убирается. */
const PUSH_TAG = 'tm-msg'
/**
 * Обработчик события не должен висеть: пока у worker'а есть незавершённое событие, новая версия
 * не может его сменить. Поэтому ждём работу не дольше нескольких секунд.
 */
const bounded = (work) => Promise.race([work.catch(() => {}), new Promise((r) => setTimeout(r, 5000))])
/** До этого момента идёт проверка уведомлений из настроек: пуш показываем, даже если приложение открыто */
let testUntil = 0

self.addEventListener('push', (event) => {
  event.waitUntil(
    bounded((async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const visible = Date.now() > testUntil && windows.some((c) => c.visibilityState === 'visible')
      await self.registration.showNotification('Temp Messenger', {
        body: 'Новое сообщение',
        icon: '/icon-192.png',
        tag: PUSH_TAG,
        renotify: !visible,
        silent: visible,
      })
      if (visible) for (const n of await self.registration.getNotifications({ tag: PUSH_TAG })) n.close()
    })()),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    bounded((async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      if (windows.length) await windows[0].focus()
      else await self.clients.openWindow('/')
    })()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname === '/ws' || url.pathname === '/health' || url.pathname.startsWith('/blob/')) return

  if (req.mode === 'navigate') {
    // Любая страница приложения — это index.html; приглашение передаётся в #фрагменте
    event.respondWith(caches.match('/index.html', { cacheName: CACHE }).then((r) => r || fetch(req)))
    return
  }
  event.respondWith(caches.match(url.pathname, { cacheName: CACHE }).then((r) => r || fetch(req)))
})
