#!/usr/bin/env bash
# Сборка и выкладка сайта-визитки tempmessenger.tech (папка site/).
# Запуск из корня репозитория: bash deploy/deploy-site.sh
# APK — свежая сборка клиента или TM_APK=путь (см. site/build.sh). sudo не нужен.
set -euo pipefail

HOST="${DEPLOY_HOST:-oracle-comments}"
REMOTE="${DEPLOY_SITE_DIR:-temp-messenger-site}"   # относительно домашнего каталога

cd "$(dirname "$0")/.."
bash site/build.sh

echo "==> Выкладка на $HOST:~/$REMOTE"
tar -C site/dist -czf - . | ssh "$HOST" "
  set -e
  rm -rf $REMOTE.new && mkdir -p $REMOTE.new
  tar -C $REMOTE.new -xzf -
  chmod -R go+rX $REMOTE.new
  rm -rf $REMOTE.old
  [ -d $REMOTE ] && mv $REMOTE $REMOTE.old || true
  mv $REMOTE.new $REMOTE
"
echo "==> Готово"
