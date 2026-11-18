#!/usr/bin/env bash
# Сборка сайта tempmessenger.tech в site/dist.
# Подставляет в страницу версию, размер и отпечаток подписи APK, в sitemap — дату.
# Запуск из любой папки: bash site/build.sh
# APK по умолчанию — свежая сборка `npm --prefix client run apk`; другой файл: TM_APK=путь.
set -euo pipefail
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
  VERSION="$("$AAPT2" dump badging "$APK" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")"
else
  VERSION="$(sed -n 's/^ *versionName "\(.*\)"/\1/p' client/android/app/build.gradle)"
  echo "Нет aapt2, версия взята из build.gradle: $VERSION" >&2
fi
BYTES="$(wc -c < "$APK" | tr -d ' ')"
SIZE="$(awk -v b="$BYTES" 'BEGIN { s = sprintf("%.1f", b / 1048576); sub(/\./, ",", s); print s " МБ" }')"
CERT=""
if [ -n "$APKSIGNER" ]; then
  SHA="$("$APKSIGNER" verify --print-certs "$APK" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | tr -d '\r')"
  [ -n "$SHA" ] && CERT="<br>SHA-256 подписи: <code>$SHA</code>"
else
  echo "Нет apksigner — отпечаток подписи на страницу не попадёт" >&2
fi

rm -rf "$OUT"
mkdir -p "$OUT/download"
sed -e "s|__APK_VERSION__|$VERSION|g" -e "s|__APK_SIZE__|$SIZE|g" -e "s|__APK_CERT__|$CERT|g" site/index.html > "$OUT/index.html"
sed -e "s|__LASTMOD__|$(date -u +%F)|" site/sitemap.xml > "$OUT/sitemap.xml"
cp site/404.html site/robots.txt site/og.png "$OUT/"
cp client/public/favicon-32.png client/public/apple-touch-icon.png client/public/icon-192.png "$OUT/"
cp "$APK" "$OUT/download/temp-messenger.apk"

if grep -q '__APK_\|__LASTMOD__' "$OUT/index.html" "$OUT/sitemap.xml"; then
  echo "Остались незаполненные метки" >&2; exit 1
fi
echo "==> site/dist готов: APK $VERSION, $SIZE${SHA:+, подпись ${SHA:0:8}…}"
