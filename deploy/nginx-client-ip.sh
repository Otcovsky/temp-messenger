#!/usr/bin/env bash
# Разовая правка живого конфига nginx (нужен sudo): передавать ретранслятору адрес клиента,
# по которому считаются квоты (server/app/quota.py). Без неё все приходят как 127.0.0.1
# и квоты на IP не действуют.
#   sudo bash ~/temp-messenger/deploy/nginx-client-ip.sh /etc/nginx/sites-available/<сайт>
# Заголовок ставится заново ($remote_addr), а не дописывается: подделать адрес клиент не может.
# Повторный запуск ничего не меняет. Перед правкой — копия; если nginx -t не проходит, она возвращается.
set -euo pipefail

F="${1:-/etc/nginx/sites-available/chat.tempmessenger.tech}"
LINE='        proxy_set_header X-Forwarded-For $remote_addr;  # адрес клиента для квот (quota.py)'

if grep -q 'X-Forwarded-For \$remote_addr' "$F"; then
  echo "Уже настроено: $F"
  exit 0
fi
BACKUP="/root/$(basename "$F").bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$F" "$BACKUP"
echo "Копия: $BACKUP"

# После каждого proxy_pass на ретранслятор (/ws, /health, /blob/)
awk -v line="$LINE" '{ print } /^ +proxy_pass http:\/\/127\.0\.0\.1:8100;/ { print line }' "$BACKUP" > "$F"

if nginx -t; then
  systemctl reload nginx
  echo "Готово: nginx перезагружен."
else
  cp -p "$BACKUP" "$F"
  echo "nginx -t не прошёл — конфиг возвращён из копии." >&2
  exit 1
fi
