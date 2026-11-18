# Temp Messenger

Одноразовый мессенджер со сквозным шифрованием, который целиком живёт в браузере.

- **Нет аккаунтов.** Личность — пара ключей, созданная в браузере. Очистили данные сайта — личность и переписка исчезли навсегда.
- **Сервер ничего не знает.** Он только передаёт зашифрованные сообщения и хранит недоставленные (до 7 дней, удаляет сразу после получения). Отправителя он не видит: тот указан внутри шифротекста.
- **Файлы до 25 МБ** шифруются в браузере одноразовым ключом. Сервер хранит только шифротекст и стирает его, как только файл скачан.
- **Шифрование как в Signal:** обмен ключами по ссылке-приглашению (упрощённый X3DH) + Double Ratchet. Всё на Web Crypto (X25519, Ed25519, HKDF, AES-256-GCM). Если браузер не умеет X25519/Ed25519, они берутся из проверенной аудитом `@noble/curves`.

## Структура

```
client/   Vite + React + TypeScript
  src/crypto/     ключи, приглашения, Double Ratchet
  src/protocol/   форматы сообщений
  src/storage/    IndexedDB
  src/transport/  WebSocket
  src/core/       логика мессенджера
  src/ui/         интерфейс
server/   Python, FastAPI — ретранслятор
deploy/   nginx, systemd, скрипт выкладки
docs/     описание протокола
```

## Запуск для разработки

Сервер (Python 3.11+):

```bash
cd server
python -m venv .venv
.venv/Scripts/pip install -r requirements-dev.txt   # Linux/macOS: .venv/bin/pip
.venv/Scripts/python -m uvicorn app.main:app --port 8100
```

Клиент (Node 20+), в другом терминале:

```bash
cd client
npm install
npm run dev
```

Откройте http://127.0.0.1:5173. Чтобы проверить переписку с самим собой, откройте второго пользователя на
http://localhost:5173: это другой origin, поэтому у него будет отдельное хранилище. Ссылку-приглашение вставьте
в поле «Есть ссылка от собеседника?».

Тесты:

```bash
cd server && .venv/Scripts/python -m pytest
cd client && npm test
```

## Android-приложение (APK)

Тот же клиент, упакованный Capacitor в `client/android`. Код лежит внутри APK, сервер зашит при сборке:
`VITE_SERVER_ORIGIN` (по умолчанию `https://chat.tempmessenger.tech`). Сервер должен разрешать адрес
приложения `https://localhost` для `/blob` — это `TM_APP_ORIGINS`, по умолчанию так и есть.

Нужны JDK 21, Android SDK (платформа 36) и переменные `JAVA_HOME`, `ANDROID_HOME`. Ключ подписи — вне
репозитория: `~/.temp-messenger-keys/keystore.properties` (или путь в `TM_SIGNING_PROPS`). Без ключа
обновление поверх установленного приложения невозможно — храните его копию.

```
cd client
npm run apk        # → android/app/build/outputs/apk/release/app-release.apk
```

Перед каждой новой версией увеличьте `versionCode` в `client/android/app/build.gradle`.
Значки: `node client/scripts/make-icons.mjs`. Пока без уведомлений (FCM — следующий этап).

## Выкладка

См. [deploy/README.md](deploy/README.md).

## Что дальше

Протокол заложен с расчётом на расширение (см. [docs/protocol.md](docs/protocol.md)): групповые
звонки, правка и удаление сообщений — это новые типы сообщений, без смены формата. Уже есть групповые чаты
(до 50 человек; каждое сообщение шифруется отдельно для каждого участника), пуш-уведомления (о сообщении —
пустые, без текста и отправителя) и звонки один на один со звуком и видео: сигналы идут шифрованными
сообщениями, звук и видео — через TURN-сервер, чтобы собеседник не видел IP-адрес.
