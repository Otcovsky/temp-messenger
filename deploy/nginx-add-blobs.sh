#!/usr/bin/env bash
# Разовая правка живого конфига nginx для файлов (нужен sudo):
#   sudo bash ~/temp-messenger/deploy/nginx-add-blobs.sh
# Добавляет blob: в img-src и блок location /blob/. Повторный запуск ничего не меняет.
# Перед правкой делает копию; если nginx -t не проходит, возвращает её.
set -euo pipefail

F="${1:-/etc/nginx/sites-available/chat.smartenergypro.tech}"
BACKUP="/root/$(basename "$F").bak-$(date +%Y%m%d-%H%M%S)"
cp "$F" "$BACKUP"
echo "Копия: $BACKUP"

grep -q "img-src 'self' data: blob:;" "$F" || sed -i "s/img-src 'self' data:;/img-src 'self' data: blob:;/" "$F"

if ! grep -q "location /blob/" "$F"; then
  python3 - "$F" <<'EOF'
import sys
path = sys.argv[1]
s = open(path, encoding="utf-8").read()
anchor = """    location = /health {
        proxy_pass http://127.0.0.1:8100;
    }
"""
block = """
    # Зашифрованные файлы. Предел чуть больше TM_MAX_BLOB_BYTES (26 МиБ);
    # тело передаётся ретранслятору потоком, без промежуточной записи на диск nginx.
    location /blob/ {
        proxy_pass http://127.0.0.1:8100;
        client_max_body_size 27m;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
"""
if s.count(anchor) != 1:
    sys.exit("Не найден блок location = /health — вставьте location /blob/ вручную")
open(path, "w", encoding="utf-8").write(s.replace(anchor, anchor + block))
EOF
fi

if nginx -t; then
  systemctl reload nginx
  echo "Готово: nginx перезагружен."
else
  cp "$BACKUP" "$F"
  echo "nginx -t не прошёл — конфиг возвращён из копии." >&2
  exit 1
fi
