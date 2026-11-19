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
/** Тексты уведомлений по языкам: { ru: { message, call, callBody, missed }, en: … } — из словарей приложения */
const TEXTS = __TEXTS__

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

/* Пуш о сообщении пустой: он лишь сообщает, что в каком-то ящике ждёт сообщение. Что и от кого —
 * знает только само приложение, поэтому текст уведомления всегда один и тот же.
 * Пуш о звонке несёт зашифрованную пометку {"k": "call"} или {"k": "end"} — без имени и номера:
 * по ней телефон «звонит» (уведомление повторяется со звуком и вибрацией) или показывает пропущенный.
 * Показывать уведомление нужно на каждый пуш: иначе Safari и Chrome отзывают подписку.
 * Если приложение уже на экране, уведомление беззвучное и сразу убирается. */
const PUSH_TAG = 'tm-msg'
const CALL_TAG = 'tm-call'
const MISSED_TAG = 'tm-missed'
/** Сколько раз и как часто «звонит» уведомление о звонке (вызов у звонящего длится 45 с) */
const RING_TIMES = 8
const RING_EVERY_MS = 3000
/** Номер текущего «звонка»: сменился — прежний цикл повторов останавливается */
let ringId = 0
/**
 * Обработчик события не должен висеть: пока у worker'а есть незавершённое событие, новая версия
 * не может его сменить. Поэтому ждём работу не дольше нескольких секунд.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const bounded = (work, ms = 5000) => Promise.race([work.catch(() => {}), sleep(ms)])
/** До этого момента идёт проверка уведомлений из настроек: пуш показываем, даже если приложение открыто */
let testUntil = 0

/**
 * Язык уведомлений — выбранный в приложении: страница кладёт его в Cache Storage (src/i18n/sync.ts),
 * localStorage service worker'у недоступен. Не нашли — язык устройства, иначе английский.
 */
async function texts() {
  let lang = ''
  try {
    const r = await caches.match('/__prefs/lang', { cacheName: 'prefs' })
    if (r) lang = (await r.text()).trim()
  } catch {
    /* кеш недоступен — возьмём язык устройства */
  }
  if (!TEXTS[lang]) lang = String(self.navigator.language || '').toLowerCase().split('-')[0]
  return TEXTS[lang] || TEXTS.en
}

async function appVisible() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  return windows.some((c) => c.visibilityState === 'visible')
}

async function closeTag(tag) {
  for (const n of await self.registration.getNotifications({ tag })) n.close()
}

/** Приложение на экране и само покажет что нужно: уведомление беззвучное и сразу убирается. */
async function showQuietly(tag) {
  await self.registration.showNotification('Temp Messenger', { icon: '/icon-192.png', tag, silent: true })
  await closeTag(tag)
}

async function ring(testing) {
  const id = ++ringId
  const times = testing ? 3 : RING_TIMES
  const tx = await texts()
  for (let i = 0; i < times && ringId === id; i++) {
    if (!testing && (await appVisible())) return closeTag(CALL_TAG) // человек открыл приложение
    await self.registration.showNotification(tx.call, {
      body: tx.callBody,
      icon: '/icon-192.png',
      tag: CALL_TAG,
      renotify: true, // каждый повтор — снова звук и вибрация
      requireInteraction: true,
      vibrate: [600, 200, 600, 200, 600],
    })
    await sleep(RING_EVERY_MS)
  }
  if (testing && ringId === id) await closeTag(CALL_TAG)
}

async function onPush(kind) {
  const testing = Date.now() <= testUntil
  const visible = !testing && (await appVisible())
  if (kind === 'call') return visible ? showQuietly(CALL_TAG) : ring(testing)
  if (kind === 'end') {
    ringId++
    await closeTag(CALL_TAG)
    if (visible) return showQuietly(MISSED_TAG)
    return self.registration.showNotification((await texts()).missed, {
      icon: '/icon-192.png',
      tag: MISSED_TAG,
      renotify: true,
    })
  }
  if (visible) return showQuietly(PUSH_TAG)
  return self.registration.showNotification('Temp Messenger', {
    body: (await texts()).message,
    icon: '/icon-192.png',
    tag: PUSH_TAG,
    renotify: true,
  })
}

self.addEventListener('push', (event) => {
  let kind = 'msg'
  try {
    const data = event.data ? event.data.json() : null
    if (data && typeof data.k === 'string') kind = data.k
  } catch {
    /* тело не разобрано — считаем обычным сообщением */
  }
  // «Звонку» нужно время на повторы; остальное должно закончиться быстро
  event.waitUntil(bounded(onPush(kind), kind === 'call' ? RING_TIMES * RING_EVERY_MS + 4000 : 5000))
})

self.addEventListener('notificationclick', (event) => {
  ringId++ // на уведомление нажали — «звонить» больше не нужно
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
