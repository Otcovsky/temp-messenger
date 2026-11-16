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

После этого **на роутере** нужно пробросить на сервер:

| Порт | Протокол | Зачем |
|---|---|---|
| 3478 | UDP и TCP | вход на TURN-сервер |
| 49160–49200 | UDP | сам звук (один звонок через сервер занимает два порта) |

Проверка: `systemctl status coturn`, журнал — `journalctl -u coturn -f` (в нём видны IP-адреса
звонящих; когда всё заработает, журнал coturn стоит выключить строкой `no-stdout-log` и `log-file=/dev/null`).

Внешний IP записан в `/etc/turnserver.conf` (`external-ip`). Если провайдер его сменит, запустите
скрипт ещё раз.
