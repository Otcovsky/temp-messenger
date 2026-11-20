// Меню языка в шапке сайта (<details class="lang-menu">): закрывается кликом мимо меню и клавишей Esc.
// Без этого файла меню тоже работает, только закрывается повторным нажатием на кнопку.
// Отдельным файлом, а не встроенным <script>: CSP сайта не разрешает встроенные скрипты.
function openLangMenus() { return document.querySelectorAll('details.lang-menu[open]') }

document.addEventListener('click', function (e) {
  openLangMenus().forEach(function (d) { if (!d.contains(e.target)) d.open = false })
})

document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return
  openLangMenus().forEach(function (d) {
    d.open = false
    d.querySelector('summary').focus()
  })
})
