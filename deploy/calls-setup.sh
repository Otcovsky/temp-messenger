#!/usr/bin/env bash
# Разовая настройка сервера для звонков (нужен sudo):
#   sudo bash ~/temp-messenger/deploy/calls-setup.sh
#
# Что делает:
#   1. В живом конфиге nginx разрешает сайту микрофон (Permissions-Policy: microphone=(self)).
#   2. Ставит и настраивает coturn — TURN-сервер, через который идёт звук звонка, когда
#      телефоны не могут соединиться напрямую или не должны видеть адреса друг друга.
#   3. Кладёт адреса TURN и общий с ним секрет в ~/temp-messenger/data/relay.env
#      и перезапускает ретранслятор, чтобы он начал выдавать клиентам временные логины.
#
# Повторный запуск безопасен: секрет сохраняется, конфиги переписываются теми же значениями.
# После этого порт 3478 (UDP и TCP) должен быть открыт снаружи: проброс на роутере или правило файрвола облака.
# Диапазон RELAY_MIN–RELAY_MAX (UDP) пробрасывать не обязательно: см. deploy/README.md.
set -euo pipefail

DOMAIN="${DOMAIN:-chat.tempmessenger.tech}"
NGINX_CONF="${NGINX_CONF:-/etc/nginx/sites-available/$DOMAIN}"
RUN_USER="${SUDO_USER:?Запустите через sudo от пользователя, под которым работает ретранслятор}"
APP_DIR="$(getent passwd "$RUN_USER" | cut -d: -f6)/temp-messenger"
ENV_FILE="$APP_DIR/data/relay.env"
RELAY_MIN="${RELAY_MIN:-49160}"
RELAY_MAX="${RELAY_MAX:-49200}"   # один звонок через сервер занимает два порта

[ "$(id -u)" -eq 0 ] || { echo "Запустите через sudo." >&2; exit 1; }

# --- 1. nginx: разрешить микрофон -----------------------------------------------
if grep -q "microphone=()" "$NGINX_CONF"; then
  BACKUP="/root/$(basename "$NGINX_CONF").bak-$(date +%Y%m%d-%H%M%S)"
  cp "$NGINX_CONF" "$BACKUP"
  sed -i 's/microphone=()/microphone=(self)/' "$NGINX_CONF"
  if nginx -t; then
    systemctl reload nginx
    echo "nginx: микрофон разрешён (копия прежнего конфига: $BACKUP)."
  else
    cp "$BACKUP" "$NGINX_CONF"
    echo "nginx -t не прошёл — конфиг возвращён из копии." >&2
    exit 1
  fi
elif grep -q "microphone=(self)" "$NGINX_CONF"; then
  echo "nginx: микрофон уже разрешён."
else
  echo "В $NGINX_CONF нет Permissions-Policy с microphone — проверьте вручную." >&2
fi

# --- 2. coturn ------------------------------------------------------------------
PUBLIC_IP="${PUBLIC_IP:-$(getent ahostsv4 "$DOMAIN" | awk 'NR==1 {print $1}')}"
LAN_IP="${LAN_IP:-$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i <= NF; i++) if ($i == "src") print $(i + 1)}')}"
[ -n "$PUBLIC_IP" ] && [ -n "$LAN_IP" ] || { echo "Не удалось определить адреса сервера (PUBLIC_IP, LAN_IP)." >&2; exit 1; }

SECRET="$(sed -n 's/^TM_TURN_SECRET=//p' "$ENV_FILE" 2>/dev/null || true)"
[ -n "$SECRET" ] || SECRET="$(openssl rand -hex 32)"

command -v turnserver >/dev/null || { apt-get update -qq; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq coturn; }

[ -f /etc/turnserver.conf ] && [ ! -f /etc/turnserver.conf.orig ] && cp /etc/turnserver.conf /etc/turnserver.conf.orig
cat > /etc/turnserver.conf <<EOF
# Создан deploy/calls-setup.sh из Temp Messenger. Правки перезапишутся при повторном запуске.
listening-port=3478
realm=$DOMAIN
fingerprint

# Сервер за NAT (роутер, облако): наружу виден PUBLIC, сам он знает себя как LAN
external-ip=$PUBLIC_IP/$LAN_IP
min-port=$RELAY_MIN
max-port=$RELAY_MAX

# Логины временные: их выдаёт ретранслятор мессенджера, зная этот секрет
use-auth-secret
static-auth-secret=$SECRET

# TLS пока не используем: звук и так зашифрован между устройствами
no-tls
no-dtls
no-cli
no-multicast-peers

# Через ретранслятор нельзя ходить во внутреннюю сеть и на сам сервер...
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
# ...кроме его собственного адреса: когда оба собеседника идут через TURN,
# их потоки встречаются здесь же
allowed-peer-ip=$LAN_IP

# Ограничения, чтобы сервер нельзя было занять чужим трафиком
user-quota=12
total-quota=60
max-bps=60000
EOF
chmod 640 /etc/turnserver.conf
chown root:turnserver /etc/turnserver.conf 2>/dev/null || true

# В старых пакетах сервис выключен флагом в /etc/default/coturn
[ -f /etc/default/coturn ] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
systemctl enable -q coturn
systemctl restart coturn
sleep 1
systemctl is-active -q coturn || { echo "coturn не запустился: journalctl -u coturn -n 30" >&2; exit 1; }
echo "coturn: работает ($PUBLIC_IP/$LAN_IP, порты 3478 и $RELAY_MIN–$RELAY_MAX)."

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 3478 >/dev/null
  ufw allow "$RELAY_MIN:$RELAY_MAX/udp" >/dev/null
  echo "ufw: порты открыты."
fi

# --- 3. ретранслятор мессенджера ---------------------------------------------------
mkdir -p "$(dirname "$ENV_FILE")"
cat > "$ENV_FILE" <<EOF
TM_ICE_URLS=stun:$DOMAIN:3478,turn:$DOMAIN:3478?transport=udp,turn:$DOMAIN:3478?transport=tcp
TM_TURN_SECRET=$SECRET
EOF
chown "$RUN_USER": "$ENV_FILE"
chmod 600 "$ENV_FILE"

RUN_UID="$(id -u "$RUN_USER")"
if sudo -u "$RUN_USER" XDG_RUNTIME_DIR="/run/user/$RUN_UID" systemctl --user restart temp-messenger; then
  echo "Ретранслятор перезапущен и выдаёт адреса TURN."
else
  echo "Перезапустите ретранслятор сами: systemctl --user restart temp-messenger" >&2
fi

cat <<EOF

Готово. Осталось открыть снаружи порт 3478, UDP и TCP (проброс на $LAN_IP на роутере или правило файрвола облака).
Диапазон $RELAY_MIN–$RELAY_MAX (UDP) — по желанию: без него звонки идут через сервер с обеих сторон.
EOF
