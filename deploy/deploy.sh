#!/usr/bin/env bash
# Сборка клиента и выкладка клиента и сервера на тестовый сервер.
# Запуск из корня репозитория: bash deploy/deploy.sh
# Нужен SSH-доступ по ключу. sudo не требуется (после первичной настройки, см. deploy/README.md).
set -euo pipefail

HOST="${DEPLOY_HOST:-otche@192.168.0.107}"
REMOTE="${DEPLOY_DIR:-temp-messenger}"   # относительно домашнего каталога

cd "$(dirname "$0")/.."

# Версия = короткий хеш коммита; "-dirty", если выкладываются незакоммиченные правки.
# Relay читает её из server/VERSION при старте и отдаёт в /health.
VERSION="$(git rev-parse --short HEAD)"
[ -z "$(git status --porcelain -- client server deploy)" ] || VERSION="$VERSION-dirty"
echo "==> Версия $VERSION"

echo "==> Сборка клиента"
npm --prefix client run build

echo "==> Выкладка клиента"
ssh "$HOST" "mkdir -p $REMOTE/client.new $REMOTE/server $REMOTE/data"
tar -C client/dist -czf - . | ssh "$HOST" "tar -C $REMOTE/client.new -xzf - && rm -rf $REMOTE/client.old && { [ -d $REMOTE/client ] && mv $REMOTE/client $REMOTE/client.old || true; } && mv $REMOTE/client.new $REMOTE/client"

echo "==> Выкладка сервера"
tar --exclude=__pycache__ -czf - server/app server/requirements.txt deploy/temp-messenger.service deploy/nginx-site.conf deploy/nginx-add-blobs.sh deploy/calls-setup.sh | ssh "$HOST" "
  set -e
  cd $REMOTE
  rm -rf server/app
  tar -xzf -
  echo '$VERSION' > server/VERSION
  [ -x server/.venv/bin/python ] || python3 -m venv server/.venv
  server/.venv/bin/pip install -q --upgrade pip
  server/.venv/bin/pip install -q -r server/requirements.txt
  mkdir -p ~/.config/systemd/user
  cp deploy/temp-messenger.service ~/.config/systemd/user/
  systemctl --user daemon-reload
  systemctl --user enable -q temp-messenger
  systemctl --user restart temp-messenger
  # relay стартует несколько секунд — ждём /health до 30 с, а не фиксированную паузу
  for i in \$(seq 30); do
    curl -sf http://127.0.0.1:8100/health && break
    [ \$i -eq 30 ] && { echo 'relay не ответил за 30 с'; journalctl --user -u temp-messenger -n 20 --no-pager; exit 1; }
    sleep 1
  done
  systemctl --user is-active temp-messenger
"
echo
echo "==> Готово, на сервере $VERSION"
