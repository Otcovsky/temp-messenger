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
    max_recipients: int = _int("TM_MAX_RECIPIENTS", 256)
    max_mailboxes_per_conn: int = _int("TM_MAX_MAILBOXES_PER_CONN", 2000)
    # Токен-бакет на соединение: сколько команд в секунду и запас
    rate_per_sec: float = float(os.environ.get("TM_RATE_PER_SEC", 20))
    rate_burst: int = _int("TM_RATE_BURST", 200)
    cleanup_interval_sec: int = _int("TM_CLEANUP_INTERVAL_SEC", 600)
    auth_timeout_sec: int = _int("TM_AUTH_TIMEOUT_SEC", 15)
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
    # Сколько пуш-сервис держит уведомление для выключенного телефона
    push_ttl_sec: int = _int("TM_PUSH_TTL_SEC", 24 * 3600)
    # Сколько ждать ack от получателя, прежде чем слать пуш: если он в сети и если нет
    # Живой клиент подтверждает за доли секунды, так что 2 с хватает, чтобы отличить его от уснувшего.
    push_delay_sec: float = float(os.environ.get("TM_PUSH_DELAY_SEC", 2))
    push_offline_delay_sec: float = float(os.environ.get("TM_PUSH_OFFLINE_DELAY_SEC", 0.3))


settings = Settings()
