// Аналитика Google — только на сайте-визитке, в самом чате её нет.
// build.sh кладёт этот файл в dist и подставляет ID, только если аналитика включена.
// Встроенный <script> из кода Google вынесен сюда: CSP сайта не разрешает встроенные скрипты.
window.dataLayer = window.dataLayer || []
function gtag() { dataLayer.push(arguments) }
gtag('js', new Date())
// Поток GA4 (G-...) настраивается здесь; контейнер (GTM-...) несёт настройки в себе
if (/^G-/.test('__GA_ID__')) gtag('config', '__GA_ID__')

// Скачивание APK: GA4 сам не считает .apk файлом, отправляем событие вручную.
document.addEventListener('click', function (e) {
  var a = e.target.closest && e.target.closest('a[href$=".apk"]')
  if (a) gtag('event', 'file_download', { file_extension: 'apk', file_name: 'temp-messenger.apk', link_url: a.href })
})
