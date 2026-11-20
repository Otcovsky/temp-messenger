#!/usr/bin/env bash
# Сборка сайта tempmessenger.tech в site/dist: русская страница (/), английская (/en) и украинская (/uk).
# Подставляет в страницы версию, размер и отпечаток подписи APK, в sitemap — дату.
# Тексты страниц правятся вручную в site/index.html, site/en/index.html и site/uk/index.html; разметка и стили у них одинаковые.
# Запуск из любой папки: bash site/build.sh
# APK по умолчанию — свежая сборка `npm --prefix client run apk`; другой файл: TM_APK=путь.
# Аналитика Google — только на этом сайте. ID контейнера (GTM-...) или потока GA4 (G-...) —
# в TM_GA_ID, по умолчанию поток GA4 сайта; TM_GA_ID= (пусто) — собрать без аналитики.
set -euo pipefail

GA_ID="${TM_GA_ID-G-MEF7YTPJ5K}"
cd "$(dirname "$0")/.."

OUT=site/dist
APK="${TM_APK:-client/android/app/build/outputs/apk/release/app-release.apk}"
[ -f "$APK" ] || { echo "Нет APK: $APK — соберите (npm --prefix client run apk) или укажите TM_APK=путь" >&2; exit 1; }

# Утилиты Android SDK (Windows: .exe/.bat, Linux/macOS: без расширения) — берём самую новую версию
SDK="${ANDROID_HOME:-${LOCALAPPDATA:-}/Android/Sdk}"
BT="$(ls -d "$SDK"/build-tools/*/ 2>/dev/null | sort -V | tail -1)"
tool() { for f in "$BT$1" "$BT$1.exe" "$BT$1.bat"; do [ -f "$f" ] && { echo "$f"; return; }; done; }
AAPT2="$(tool aapt2)"
APKSIGNER="$(tool apksigner)"

if [ -n "$AAPT2" ]; then
  BADGING="$("$AAPT2" dump badging "$APK")"
  VERSION="$(echo "$BADGING" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")"
  CODE="$(echo "$BADGING" | sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p")"
else
  VERSION="$(sed -n 's/^ *versionName "\(.*\)"/\1/p' client/android/app/build.gradle)"
  CODE="$(sed -n 's/^ *versionCode \([0-9]*\).*/\1/p' client/android/app/build.gradle)"
  echo "Нет aapt2, версия взята из build.gradle: $VERSION ($CODE)" >&2
fi
[[ "$CODE" =~ ^[0-9]+$ ]] || { echo "Не удалось узнать versionCode APK" >&2; exit 1; }
# Старше этой версии приложение просит обновиться без кнопки «Позже» — когда сервер
# изменился несовместимо. По умолчанию 1: обновление предлагается, но не требуется.
MIN_CODE="${TM_APK_MIN_CODE:-1}"
[[ "$MIN_CODE" =~ ^[0-9]+$ && "$MIN_CODE" -le "$CODE" ]] || { echo "TM_APK_MIN_CODE должен быть числом не больше $CODE" >&2; exit 1; }
BYTES="$(wc -c < "$APK" | tr -d ' ')"
SIZE_EN="$(awk -v b="$BYTES" 'BEGIN { printf "%.1f MB", b / 1048576 }')"
SIZE="$(echo "$SIZE_EN" | sed 's/\./,/; s/MB/МБ/')"
SIZE_UK="$SIZE"
CERT=""
CERT_EN=""
CERT_UK=""
if [ -n "$APKSIGNER" ]; then
  SHA="$("$APKSIGNER" verify --print-certs "$APK" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | tr -d '\r')"
  if [ -n "$SHA" ]; then
    CERT="<br>SHA-256 подписи: <code>$SHA</code>"
    CERT_EN="<br>Signing certificate SHA-256: <code>$SHA</code>"
    CERT_UK="<br>SHA-256 підпису: <code>$SHA</code>"
  fi
else
  echo "Нет apksigner — отпечаток подписи на страницу не попадёт" >&2
fi

rm -rf "$OUT"
mkdir -p "$OUT/download" "$OUT/en" "$OUT/uk"
ANALYTICS=""
if [ -n "$GA_ID" ]; then
  case "$GA_ID" in
    GTM-*) LOADER=gtm.js ;;
    G-*) LOADER=gtag/js ;;
    *) LOADER= ;;
  esac
  [[ -n "$LOADER" && "$GA_ID" =~ ^(G|GTM)-[A-Z0-9]+$ ]] || { echo "TM_GA_ID должен выглядеть как GTM-XXXX или G-XXXX: $GA_ID" >&2; exit 1; }
  # Сначала /ga.js (dataLayer и gtag), потом загрузчик Google — как в коде, который выдаёт Google
  ANALYTICS="<script src=\"/ga.js\"></script><script async src=\"https://www.googletagmanager.com/$LOADER?id=$GA_ID\"></script>"
  sed -e "s|__GA_ID__|$GA_ID|g" site/ga.js > "$OUT/ga.js"
fi
# page файл размер подпись — страница с подставленными метками
page() { sed -e "s|__APK_VERSION__|$VERSION|g" -e "s|__APK_SIZE__|$2|g" -e "s|__APK_CERT__|$3|g" -e "s|<!--__ANALYTICS__-->|$ANALYTICS|" "$1"; }
page site/index.html "$SIZE" "$CERT" > "$OUT/index.html"
page site/en/index.html "$SIZE_EN" "$CERT_EN" > "$OUT/en/index.html"
page site/uk/index.html "$SIZE_UK" "$CERT_UK" > "$OUT/uk/index.html"
sed -e "s|__LASTMOD__|$(date -u +%F)|" site/sitemap.xml > "$OUT/sitemap.xml"
cp site/404.html site/robots.txt site/og.png "$OUT/"
cp client/public/favicon-32.png client/public/apple-touch-icon.png client/public/icon-192.png "$OUT/"
cp "$APK" "$OUT/download/temp-messenger.apk"
# Приложение сверяет с этим файлом свою версию (client/src/appUpdate.ts). Ссылки здесь нет
# намеренно: адрес скачивания зашит в приложении, подменённый файл не уведёт на чужой APK.
printf '{"versionCode":%s,"versionName":"%s","minVersionCode":%s}\n' "$CODE" "$VERSION" "$MIN_CODE" > "$OUT/download/version.json"

if grep -qE '__(APK_[A-Z]+|LASTMOD|ANALYTICS|GA_ID)__' "$OUT"/index.html "$OUT"/en/index.html "$OUT"/uk/index.html "$OUT"/sitemap.xml "$OUT"/*.js 2>/dev/null; then
  echo "Остались незаполненные метки" >&2; exit 1
fi
echo "==> site/dist готов: APK $VERSION (versionCode $CODE, минимум $MIN_CODE), $SIZE${SHA:+, подпись ${SHA:0:8}…}, аналитика: ${GA_ID:-нет}"
