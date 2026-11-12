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
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname === '/ws' || url.pathname === '/health') return

  if (req.mode === 'navigate') {
    // Любая страница приложения — это index.html; приглашение передаётся в #фрагменте
    event.respondWith(caches.match('/index.html', { cacheName: CACHE }).then((r) => r || fetch(req)))
    return
  }
  event.respondWith(caches.match(url.pathname, { cacheName: CACHE }).then((r) => r || fetch(req)))
})
