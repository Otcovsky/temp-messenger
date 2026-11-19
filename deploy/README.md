# Выкладка на тестовый сервер

Адрес: `https://chat.smartenergypro.tech`. Ретранслятор слушает `127.0.0.1:8100`, nginx отдаёт статику клиента и проксирует `/ws`.

## Разовая настройка (нужен sudo)

1. **DNS:** A-запись `chat.smartenergypro.tech` → `79.135.198.116`.
2. **Сервис без входа в систему** (пользовательский systemd должен работать постоянно):
   ```bash
   sudo loginctl enable-linger otche
   ```
3. **nginx и сертификат** (после того как DNS-запись заработала):
   ```bash
   sudo cp ~/temp-messenger/deploy/nginx-site.conf /etc/nginx/sites-available/chat.smartenergypro.tech
   sudo ln -s /etc/nginx/sites-available/chat.smartenergypro.tech /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d chat.smartenergypro.tech
   ```

## Обычная выкладка (без sudo)

Из корня репозитория на машине разработчика:

```bash
bash deploy/deploy.sh
```

Скрипт собирает клиент, копирует его и сервер по SSH в `~/temp-messenger`, обновляет зависимости и
перезапускает `systemctl --user restart temp-messenger`.

Полезное на сервере:

```bash
systemctl --user status temp-messenger
journalctl --user -u temp-messenger -f
```

Данные ретранслятора: `~/temp-messenger/data/relay.sqlite3` (только зашифрованная очередь) и
`~/temp-messenger/data/blobs/` (зашифрованные файлы, стираются после скачивания или через 7 дней).

## Файлы: разовая правка nginx (нужен sudo)

`deploy.sh` не трогает живой конфиг nginx (его правил certbot). Для файлов в нём нужно две правки,
обе уже есть в `deploy/nginx-site.conf`:

1. В `Content-Security-Policy` к `img-src` добавить `blob:` — иначе картинки в чате не покажутся.
2. Добавить `location /blob/` рядом с `location = /health` — иначе сервер отвечает на загрузку 405,
   а на файл больше 1 МБ — 413.

Обе делает скрипт (копия конфига — в `/root`, при ошибке `nginx -t` конфиг возвращается):

```bash
sudo bash ~/temp-messenger/deploy/nginx-add-blobs.sh
```

## Ограничения на один IP: `/etc/nginx/conf.d/tm-limits.conf` (нужен sudo)

Этого файла нет в репозитории: зоны создаются на сервере, а в сайте (`limit_conn`, `limit_req`)
на них ссылаются. На chat.tempmessenger.tech сейчас:

| что | где | порог |
|---|---|---|
| одновременных соединений с IP | весь сайт, `limit_conn tm_conn` | **20** |
| запросов страниц | весь сайт, зона `tm_page` | 20/с, всплеск 100 |
| новых WebSocket | `location = /ws`, зона `tm_ws` | 2/с, всплеск 30 |
| запросов файлов | `location /blob/`, зона `tm_blob` | 5/с, всплеск 50 |

Сверх порога — 429. Человеку нужно 1–3 WebSocket (вкладки, телефон) и пара загрузок, так что 20
соединений хватает с запасом даже за мобильным NAT. До 2026-11-18 было 100 — тогда, чтобы занять
все места на сервере, хватало ~40 адресов, теперь нужно ~1000.

Квоты на место (очередь сообщений, файлы) считает сам ретранслятор (`server/app/quota.py`),
и ему нужен адрес клиента. Разовая правка — nginx передаёт его в `X-Forwarded-For`
(uvicorn верит этому заголовку только от 127.0.0.1):

```bash
sudo bash ~/temp-messenger/deploy/nginx-client-ip.sh /etc/nginx/sites-available/chat.tempmessenger.tech
```

Без неё все приходят как 127.0.0.1, и квоты на IP молча не действуют (делить одну на всех нельзя).

## Больше 760 человек онлайн: разовая правка nginx.conf (нужен sudo)

По умолчанию в `/etc/nginx/nginx.conf` стоит `worker_connections 768`. Каждое WebSocket-соединение
занимает в nginx два (клиент + ретранслятор), поэтому на двух ядрах сервер держит только ~760 человек
онлайн, остальные получают 500 (проверено нагрузочным тестом, `loadtest/README.md`). Поднять:

```bash
sudo cp -p /etc/nginx/nginx.conf /root/nginx.conf.bak-$(date +%Y%m%d)
sudo sed -i -e 's/^\tworker_connections 768;/\tworker_connections 4096;/' \
  -e 's|^pid /run/nginx.pid;|pid /run/nginx.pid;\nworker_rlimit_nofile 8192;|' /etc/nginx/nginx.conf
sudo nginx -t && sudo systemctl reload nginx
```

Так потолок ~4000 человек. На chat.tempmessenger.tech с 2026-11-18 стоит `worker_connections 20480`
и `worker_rlimit_nofile 65536` — потолок ~20 000: занять все места с 20 соединений на IP можно
только с ~1000 адресов. Память это позволяет (~85 КБ на человека в ретрансляторе, ~1,7 ГБ на 20 000).
Выше 20 000 упрётся в локальные порты: nginx ходит к ретранслятору на 127.0.0.1, а
`ip_local_port_range` по умолчанию даёт ~28 000 портов.

Ретранслятору лимит открытых файлов поднимает сам юнит (`LimitNOFILE=65536` в `temp-messenger.service`).

## Звонки: разовая настройка (нужен sudo)

Звонку нужны две вещи, которых `deploy.sh` сделать не может:

1. **Микрофон.** В живом конфиге nginx стоит `Permissions-Policy: microphone=()` — браузер не даст
   сайту микрофон, и звонок закончится словами «Нет доступа к микрофону».
2. **TURN-сервер (coturn).** Через него идёт звук, когда телефоны не могут соединиться напрямую
   (мобильный интернет) или не должны видеть IP-адреса друг друга. Без него звонки работают
   только между устройствами в одной локальной сети.

Обе делает скрипт (повторный запуск безопасен):

```bash
sudo bash ~/temp-messenger/deploy/calls-setup.sh
```

Он правит nginx, ставит coturn с конфигом `/etc/turnserver.conf`, записывает адреса и общий секрет
в `~/temp-messenger/data/relay.env` и перезапускает ретранслятор.

После этого **на роутере** нужно пробросить на сервер порт **3478, UDP и TCP** — вход на
TURN-сервер. Этого достаточно: каждый телефон общается с сервером только через 3478, а потоки двух
собеседников встречаются уже внутри него.

Диапазон 49160–49200 UDP (порты, на которых coturn держит потоки) пробрасывать не обязательно. Он
нужен лишь для короткого пути, когда один собеседник соединяется напрямую, а второй — через сервер;
без проброса такой звонок просто пойдёт через сервер с обеих сторон. Если роутер умеет
пробрасывать только по одному порту, диапазон можно не трогать.

Проверка: `systemctl status coturn`, журнал — `journalctl -u coturn -f` (в нём видны IP-адреса
звонящих; когда всё заработает, журнал coturn стоит выключить строкой `no-stdout-log` и `log-file=/dev/null`).

Внешний IP записан в `/etc/turnserver.conf` (`external-ip`). Если провайдер его сменит, запустите
скрипт ещё раз.

## Сайт-визитка на tempmessenger.tech

Статическая страница на двух языках (папка `site/`): русская — `/` (`site/index.html`), английская —
`/en/` (`site/en/index.html`). Разметка и стили у них одинаковые, тексты правятся в обоих файлах.
Страницы ссылаются друг на друга (`hreflang`, переключатель RU/EN), обе есть в `sitemap.xml`.
Раньше корневой домен просто перенаправлял на `chat.`.

Обычная выкладка (без sudo) — собирает `site/dist` и копирует в `~/temp-messenger-site`:

```bash
TM_APK=путь/к/app-release.apk bash deploy/deploy-site.sh   # без TM_APK — свежая сборка клиента
```

`site/build.sh` сам подставляет на страницу версию, размер и SHA-256 сертификата подписи APK
(через `aapt2` и `apksigner` из Android SDK) и дату в `sitemap.xml`. APK на сервере всегда лежит
как `/download/temp-messenger.apk`. Картинка для соцсетей `site/og.png` рисуется из `site/og-card.html`
(команда — в самом файле).

Аналитика Google есть только на этом сайте (в чате её нет): контейнер Tag Manager `GTM-WCWTGS9G`,
он задан в `site/build.sh` по умолчанию. Другой ID — `TM_GA_ID=GTM-...` или `G-...`, без аналитики —
`TM_GA_ID=` (пусто). В страницу добавляются `/ga.js` (dataLayer, событие `file_download` при скачивании
APK) и загрузчик Google. Что именно собирается, настраивается в самом контейнере в tagmanager.google.com.
CSP в `nginx-landing.conf` разрешает адреса Google; на живом сервере эту строку правят вручную
(certbot дописал в файл свои строки, копировать конфиг целиком нельзя).

Разовая настройка (нужен sudo), после того как A-записи `@` и `www` указывают на сервер:

```bash
sudo cp /etc/nginx/sites-available/tempmessenger.tech /root/tempmessenger.tech.bak-$(date +%Y%m%d)
sudo cp ~/temp-messenger/deploy/nginx-landing.conf /etc/nginx/sites-available/tempmessenger.tech
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d tempmessenger.tech -d www.tempmessenger.tech
```

Английской версии нужны блоки `location = /en` и `location = /en/` из `nginx-landing.conf`: без них
nginx отдаёт на `/en/` ошибку 404. На живом сервере их вписывают в
`/etc/nginx/sites-available/tempmessenger.tech` вручную (рядом с `location = /download/...`), затем
`sudo nginx -t && sudo systemctl reload nginx`.

Когда приложение появится в магазинах, кнопку APK в `site/index.html` и `site/en/index.html`
(блок `#download` и подвал) заменить ссылками на магазины.
