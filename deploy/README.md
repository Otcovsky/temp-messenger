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

Данные ретранслятора: `~/temp-messenger/data/relay.sqlite3` (только зашифрованная очередь).
