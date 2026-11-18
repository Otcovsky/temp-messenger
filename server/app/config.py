"""Настройки сервера. Всё переопределяется переменными окружения TM_*."""

import os
from dataclasses import dataclass


def _int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


@dataclass(frozen=True)
class Settings:
    db_path: str = os.environ.get("TM_DB_PATH", "temp_messenger.sqlite3")
    # Сколько хранится недоставленное сообщение
    message_ttl_sec: int = _int("TM_MESSAGE_TTL_SEC", 7 * 24 * 3600)
    # Через сколько удаляется ящик, к которому никто не подключался
    mailbox_idle_ttl_sec: int = _int("TM_MAILBOX_IDLE_TTL_SEC", 30 * 24 * 3600)
    max_payload_bytes: int = _int("TM_MAX_PAYLOAD_BYTES", 64 * 1024)
    max_queue_per_mailbox: int = _int("TM_MAX_QUEUE_PER_MAILBOX", 1000)
    # Потолок всей очереди недоставленных сообщений, в байтах шифротекста. Ящик заводит кто угодно,
    # и без потолка можно слать себе сообщения, пока не кончится диск, — тогда ляжет весь сервер.
    # Упёрлись — новые сообщения получают отказ server_full, а сервер живёт дальше.
    max_queue_bytes_total: int = _int("TM_MAX_QUEUE_BYTES_TOTAL", 4 * 1024 * 1024 * 1024)
    max_recipients: int = _int("TM_MAX_RECIPIENTS", 256)
    max_mailboxes_per_conn: int = _int("TM_MAX_MAILBOXES_PER_CONN", 2000)
    # Токен-бакет на соединение: сколько команд в секунду и запас
    rate_per_sec: float = float(os.environ.get("TM_RATE_PER_SEC", 20))
    rate_burst: int = _int("TM_RATE_BURST", 200)
    cleanup_interval_sec: int = _int("TM_CLEANUP_INTERVAL_SEC", 600)
    # Сколько ждать подписи после challenge. Клиенту хватает одного круга по сети (ключ уже в памяти),
    # а соединение без входа занимает место в nginx — чем короче, тем дороже держать их пачкой.
    auth_timeout_sec: int = _int("TM_AUTH_TIMEOUT_SEC", 5)
    # Файлы: зашифрованные клиентом, лежат на диске до скачивания всеми получателями или до TTL
    blob_dir: str = os.environ.get("TM_BLOB_DIR", "blobs")
    # Шифротекст файла: клиент пускает файлы до 25 МиБ, дополнение и тег добавляют меньше 1 МиБ
    max_blob_bytes: int = _int("TM_MAX_BLOB_BYTES", 26 * 1024 * 1024)
    blob_ttl_sec: int = _int("TM_BLOB_TTL_SEC", 7 * 24 * 3600)
    # Сколько места могут занять файлы одного ключа доступа и все вместе
    blob_quota_per_owner: int = _int("TM_BLOB_QUOTA_PER_OWNER", 256 * 1024 * 1024)
    blob_quota_total: int = _int("TM_BLOB_QUOTA_TOTAL", 2 * 1024 * 1024 * 1024)
    # Сколько ждать окончания начатой загрузки, прежде чем считать её брошенной
    blob_upload_timeout_sec: int = _int("TM_BLOB_UPLOAD_TIMEOUT_SEC", 3600)
    # Файл с версией (хешем коммита), его пишет deploy/deploy.sh; путь относительно рабочего каталога
    version_file: str = os.environ.get("TM_VERSION_FILE", "VERSION")
    # Пуш-уведомления. Включаются, когда задан TM_PUSH_SUBJECT — контакт владельца сервера
    # для пуш-сервисов (адрес сайта https://... или mailto:...); без него Apple пуши не принимает.
    push_subject: str = os.environ.get("TM_PUSH_SUBJECT", "")
    # Пуш-сервисы, на адреса которых сервер согласен слать запросы (домен и его поддомены)
    push_hosts: tuple[str, ...] = tuple(
        h.strip().lower()
        for h in os.environ.get(
            "TM_PUSH_HOSTS",
            "fcm.googleapis.com,push.apple.com,push.services.mozilla.com,notify.windows.com",
        ).split(",")
        if h.strip()
    )
    # Пуши в Android-приложение через Firebase: путь к JSON-ключу сервисного аккаунта (секрет,
    # хранится только на сервере). Пусто — приложению пуши не шлются. См. fcm.py.
    fcm_credentials: str = os.environ.get("TM_FCM_CREDENTIALS", "")
    # Сколько пуш-сервис держит уведомление для выключенного телефона
    push_ttl_sec: int = _int("TM_PUSH_TTL_SEC", 24 * 3600)
    # Сколько ждать ack от получателя, прежде чем слать пуш: если он в сети и если нет
    # Живой клиент подтверждает за доли секунды, так что 2 с хватает, чтобы отличить его от уснувшего.
    push_delay_sec: float = float(os.environ.get("TM_PUSH_DELAY_SEC", 2))
    push_offline_delay_sec: float = float(os.environ.get("TM_PUSH_OFFLINE_DELAY_SEC", 0.3))
    # Адреса страниц, которым разрешено обращаться к /blob с другого адреса (CORS), через запятую.
    # Android-приложение открывает клиент с https://localhost (Capacitor). Пусто — только свой сайт.
    app_origins: tuple[str, ...] = tuple(
        o.strip().rstrip("/")
        for o in os.environ.get("TM_APP_ORIGINS", "https://localhost").split(",")
        if o.strip()
    )
    # Звонки. Адреса STUN/TURN-серверов через запятую, например
    # "stun:chat.example:3478,turn:chat.example:3478?transport=udp,turn:chat.example:3478?transport=tcp".
    # Пусто — клиенты соединяются только напрямую (сработает в одной локальной сети).
    ice_urls: tuple[str, ...] = tuple(
        u.strip() for u in os.environ.get("TM_ICE_URLS", "").split(",") if u.strip()
    )
    # Общий секрет с coturn (static-auth-secret): по нему выдаются временные логины для TURN
    turn_secret: str = os.environ.get("TM_TURN_SECRET", "")
    # Сколько действует выданный логин. Должен пережить самый длинный звонок.
    turn_ttl_sec: int = _int("TM_TURN_TTL_SEC", 6 * 3600)


settings = Settings()
