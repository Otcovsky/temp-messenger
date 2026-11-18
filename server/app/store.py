"""Хранилище ретранслятора: почтовые ящики и очередь недоставленных сообщений.

Сервер хранит только непрозрачный шифротекст (payload) и не знает,
кто его отправил. Сообщение удаляется после ack получателя или по TTL.
Интерфейс намеренно узкий, чтобы SQLite можно было заменить на Redis/Postgres.
"""

import sqlite3
import time
from dataclasses import dataclass

SCHEMA = """
CREATE TABLE IF NOT EXISTS mailboxes (
    id          TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,          -- публичный Ed25519-ключ доступа (base64url)
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL,
    invite      INTEGER                 -- 1: ждёт ответа на приглашение, 0: обычный, NULL: неизвестно
);
CREATE INDEX IF NOT EXISTS mailboxes_owner ON mailboxes(owner);

CREATE TABLE IF NOT EXISTS messages (
    mailbox_id  TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    id          TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    PRIMARY KEY (mailbox_id, id)
);
CREATE INDEX IF NOT EXISTS messages_expires ON messages(expires_at);

-- Сколько байт шифротекста лежит в очереди всего. Счётчик ведут триггеры, поэтому он верен при
-- любом удалении: ack, уборка по сроку, удаление ящика (каскадом). Строка одна, id = 1.
CREATE TABLE IF NOT EXISTS queue_stats (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    bytes       INTEGER NOT NULL
);

-- Зашифрованные файлы. Сами байты лежат на диске, здесь — учёт.
CREATE TABLE IF NOT EXISTS blobs (
    id          TEXT PRIMARY KEY,
    owner       TEXT NOT NULL,          -- ключ доступа загрузившего (для квоты)
    size        INTEGER NOT NULL,
    remaining   INTEGER NOT NULL,       -- сколько получателей ещё не скачали
    complete    INTEGER NOT NULL,       -- 0: загрузка идёт, 1: файл целиком на диске
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS blobs_expires ON blobs(expires_at);
CREATE INDEX IF NOT EXISTS blobs_owner ON blobs(owner);

-- Подписки на пуш-уведомления: одна на ключ доступа (то есть на браузер).
CREATE TABLE IF NOT EXISTS push_subs (
    owner       TEXT PRIMARY KEY,
    endpoint    TEXT NOT NULL,          -- адрес у пуш-сервиса браузера
    created_at  INTEGER NOT NULL,
    p256dh      TEXT,                   -- ключи подписки (base64url): ими шифруется пометка в пуше;
    auth        TEXT                    -- NULL — подписка от прежней версии клиента, пуши ей пустые
);

-- Настройки самого сервера (например, ключ VAPID).
CREATE TABLE IF NOT EXISTS meta (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL
);
"""


@dataclass
class StoredMessage:
    mailbox_id: str
    id: str
    payload: str
    created_at: int


@dataclass
class PushSub:
    endpoint: str
    p256dh: str | None
    auth: str | None


class RegisterResult:
    CREATED = "created"
    OK = "ok"
    FORBIDDEN = "forbidden"


class Store:
    def __init__(self, path: str):
        self.db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.executescript(SCHEMA)
        cols = {r[1] for r in self.db.execute("PRAGMA table_info(mailboxes)")}
        if "invite" not in cols:  # база от прежней версии
            self.db.execute("ALTER TABLE mailboxes ADD COLUMN invite INTEGER")
        cols = {r[1] for r in self.db.execute("PRAGMA table_info(push_subs)")}
        if "p256dh" not in cols:  # база от версии с пустыми пушами
            self.db.execute("ALTER TABLE push_subs ADD COLUMN p256dh TEXT")
            self.db.execute("ALTER TABLE push_subs ADD COLUMN auth TEXT")
        self._init_queue_stats()

    def _init_queue_stats(self) -> None:
        # Счётчик и триггеры создаются одной транзакцией: в базе прежней версии сообщения уже есть,
        # и между подсчётом и появлением триггеров ничего не должно проскочить мимо счёта.
        self.db.execute("BEGIN IMMEDIATE")
        try:
            if self.db.execute("SELECT 1 FROM queue_stats WHERE id=1").fetchone() is None:
                self.db.execute(
                    "INSERT INTO queue_stats(id, bytes) "
                    "SELECT 1, COALESCE(SUM(length(CAST(payload AS BLOB))), 0) FROM messages"
                )
            self.db.execute(
                "CREATE TRIGGER IF NOT EXISTS messages_bytes_ins AFTER INSERT ON messages BEGIN "
                "UPDATE queue_stats SET bytes = bytes + length(CAST(new.payload AS BLOB)) WHERE id=1; END"
            )
            self.db.execute(
                "CREATE TRIGGER IF NOT EXISTS messages_bytes_del AFTER DELETE ON messages BEGIN "
                "UPDATE queue_stats SET bytes = bytes - length(CAST(old.payload AS BLOB)) WHERE id=1; END"
            )
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def close(self) -> None:
        self.db.close()

    # --- ящики -----------------------------------------------------------

    def register(
        self, mailbox_id: str, owner: str, now: int | None = None, invite: bool | None = None
    ) -> str:
        """invite: True — ящик ждёт ответа на приглашение, False — обычный, None — не менять."""
        now = now or int(time.time())
        flag = None if invite is None else int(invite)
        row = self.db.execute("SELECT owner FROM mailboxes WHERE id=?", (mailbox_id,)).fetchone()
        if row is None:
            self.db.execute(
                "INSERT INTO mailboxes(id, owner, created_at, last_seen, invite) VALUES (?,?,?,?,?)",
                (mailbox_id, owner, now, now, flag),
            )
            return RegisterResult.CREATED
        if row[0] != owner:
            return RegisterResult.FORBIDDEN
        if flag is None:
            self.touch(mailbox_id, now)
        else:
            self.db.execute("UPDATE mailboxes SET last_seen=?, invite=? WHERE id=?", (now, flag, mailbox_id))
        return RegisterResult.OK

    def touch(self, mailbox_id: str, now: int | None = None) -> None:
        self.db.execute(
            "UPDATE mailboxes SET last_seen=? WHERE id=?", (now or int(time.time()), mailbox_id)
        )

    def unregister(self, mailbox_id: str, owner: str) -> bool:
        cur = self.db.execute("DELETE FROM mailboxes WHERE id=? AND owner=?", (mailbox_id, owner))
        return cur.rowcount > 0

    def invite_state(self, mailbox_id: str) -> str:
        """'open' — приглашение ждёт ответа, 'used' — уже принято, 'none' — ящика нет."""
        row = self.db.execute("SELECT invite FROM mailboxes WHERE id=?", (mailbox_id,)).fetchone()
        if row is None:
            return "none"
        return "used" if row[0] == 0 else "open"  # NULL (старые клиенты) считаем открытым

    def mailbox_exists(self, mailbox_id: str) -> bool:
        return self.db.execute("SELECT 1 FROM mailboxes WHERE id=?", (mailbox_id,)).fetchone() is not None

    def mailbox_owner(self, mailbox_id: str) -> str | None:
        row = self.db.execute("SELECT owner FROM mailboxes WHERE id=?", (mailbox_id,)).fetchone()
        return row[0] if row else None

    # --- сообщения -------------------------------------------------------

    def enqueue(
        self,
        mailbox_id: str,
        msg_id: str,
        payload: str,
        ttl: int,
        max_queue: int,
        now: int | None = None,
        max_total_bytes: int | None = None,
    ) -> str:
        """Возвращает 'stored', 'duplicate', 'no_mailbox', 'queue_full' (полон ящик)
        или 'server_full' (вся очередь сервера заняла max_total_bytes)."""
        now = now or int(time.time())
        if not self.mailbox_exists(mailbox_id):
            return "no_mailbox"
        (count,) = self.db.execute(
            "SELECT COUNT(*) FROM messages WHERE mailbox_id=?", (mailbox_id,)
        ).fetchone()
        if count >= max_queue:
            return "queue_full"
        if max_total_bytes is not None and self.queue_bytes() + len(payload.encode()) > max_total_bytes:
            return "server_full"
        cur = self.db.execute(
            "INSERT OR IGNORE INTO messages(mailbox_id, id, payload, created_at, expires_at) "
            "VALUES (?,?,?,?,?)",
            (mailbox_id, msg_id, payload, now, now + ttl),
        )
        return "stored" if cur.rowcount else "duplicate"

    def queue_bytes(self) -> int:
        """Сколько байт шифротекста сейчас в очереди (вместе с истёкшими, которых не убрала уборка)."""
        return self.db.execute("SELECT bytes FROM queue_stats WHERE id=1").fetchone()[0]

    def pending(self, mailbox_id: str, limit: int = 500, now: int | None = None) -> list[StoredMessage]:
        # Истёкшие не отдаём, даже если уборка до них ещё не дошла: у сигналов звонка срок —
        # секунды, и опоздавшее приглашение к звонку никому не нужно.
        rows = self.db.execute(
            "SELECT mailbox_id, id, payload, created_at FROM messages "
            "WHERE mailbox_id=? AND expires_at>? ORDER BY created_at, rowid LIMIT ?",
            (mailbox_id, now or int(time.time()), limit),
        ).fetchall()
        return [StoredMessage(*r) for r in rows]

    def ack(self, mailbox_id: str, owner: str, ids: list[str]) -> int:
        row = self.db.execute("SELECT owner FROM mailboxes WHERE id=?", (mailbox_id,)).fetchone()
        if row is None or row[0] != owner or not ids:
            return 0
        marks = ",".join("?" * len(ids))
        cur = self.db.execute(
            f"DELETE FROM messages WHERE mailbox_id=? AND id IN ({marks})", (mailbox_id, *ids)
        )
        return cur.rowcount

    def has_mailboxes(self, owner: str) -> bool:
        return self.db.execute("SELECT 1 FROM mailboxes WHERE owner=? LIMIT 1", (owner,)).fetchone() is not None

    def has_message(self, mailbox_id: str, msg_id: str) -> bool:
        """Сообщение ещё в очереди, то есть получатель его не подтвердил."""
        return (
            self.db.execute(
                "SELECT 1 FROM messages WHERE mailbox_id=? AND id=?", (mailbox_id, msg_id)
            ).fetchone()
            is not None
        )

    # --- пуш-подписки и настройки ---------------------------------------

    def push_set(
        self, owner: str, endpoint: str, p256dh: str | None = None, auth: str | None = None, now: int | None = None
    ) -> None:
        self.db.execute(
            "INSERT INTO push_subs(owner, endpoint, created_at, p256dh, auth) VALUES (?,?,?,?,?) "
            "ON CONFLICT(owner) DO UPDATE SET endpoint=excluded.endpoint, created_at=excluded.created_at, "
            "p256dh=excluded.p256dh, auth=excluded.auth",
            (owner, endpoint, now or int(time.time()), p256dh, auth),
        )

    def push_get(self, owner: str) -> PushSub | None:
        row = self.db.execute("SELECT endpoint, p256dh, auth FROM push_subs WHERE owner=?", (owner,)).fetchone()
        return PushSub(*row) if row else None

    def push_delete(self, owner: str, endpoint: str | None = None) -> None:
        """endpoint задан — удалить, только если подписка всё ещё эта (её могли успеть заменить)."""
        if endpoint is None:
            self.db.execute("DELETE FROM push_subs WHERE owner=?", (owner,))
        else:
            self.db.execute("DELETE FROM push_subs WHERE owner=? AND endpoint=?", (owner, endpoint))

    def meta_get(self, key: str) -> str | None:
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row[0] if row else None

    def meta_set(self, key: str, value: str) -> None:
        self.db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?,?)", (key, value))

    # --- файлы ----------------------------------------------------------
    # Порядок работы: blob_reserve → (запись на диск) → blob_complete или blob_abort.
    # Место резервируется до записи, поэтому квота учитывает и идущие загрузки.

    def blob_reserve(
        self,
        blob_id: str,
        owner: str,
        size: int,
        recipients: int,
        upload_timeout: int,
        quota_owner: int,
        quota_total: int,
        now: int | None = None,
    ) -> str:
        """Возвращает 'ok' (можно писать), 'exists' (этот же файл уже загружен),
        'busy' (загрузка уже идёт), 'conflict' (id занят другим) или 'quota'."""
        now = now or int(time.time())
        row = self.db.execute(
            "SELECT owner, size, complete, expires_at FROM blobs WHERE id=?", (blob_id,)
        ).fetchone()
        if row is not None and row[3] > now:
            if row[0] != owner or row[1] != size:
                return "conflict"
            return "exists" if row[2] else "busy"
        if row is not None:  # истёк, но уборка ещё не дошла
            self.db.execute("DELETE FROM blobs WHERE id=?", (blob_id,))
        (used_owner,) = self.db.execute(
            "SELECT COALESCE(SUM(size), 0) FROM blobs WHERE owner=? AND expires_at>?", (owner, now)
        ).fetchone()
        (used_total,) = self.db.execute(
            "SELECT COALESCE(SUM(size), 0) FROM blobs WHERE expires_at>?", (now,)
        ).fetchone()
        if used_owner + size > quota_owner or used_total + size > quota_total:
            return "quota"
        self.db.execute(
            "INSERT INTO blobs(id, owner, size, remaining, complete, created_at, expires_at) "
            "VALUES (?,?,?,?,0,?,?)",
            (blob_id, owner, size, recipients, now, now + upload_timeout),
        )
        return "ok"

    def blob_complete(self, blob_id: str, ttl: int, now: int | None = None) -> None:
        now = now or int(time.time())
        self.db.execute(
            "UPDATE blobs SET complete=1, created_at=?, expires_at=? WHERE id=?", (now, now + ttl, blob_id)
        )

    def blob_abort(self, blob_id: str) -> None:
        self.db.execute("DELETE FROM blobs WHERE id=? AND complete=0", (blob_id,))

    def blob_available(self, blob_id: str, now: int | None = None) -> bool:
        now = now or int(time.time())
        return (
            self.db.execute(
                "SELECT 1 FROM blobs WHERE id=? AND complete=1 AND expires_at>?", (blob_id, now)
            ).fetchone()
            is not None
        )

    def blob_done(self, blob_id: str) -> bool:
        """Получатель скачал файл. True — скачали все, запись удалена и файл пора стереть."""
        cur = self.db.execute(
            "UPDATE blobs SET remaining=remaining-1 WHERE id=? AND complete=1 AND remaining>0", (blob_id,)
        )
        if not cur.rowcount:
            return False
        return self.db.execute("DELETE FROM blobs WHERE id=? AND remaining<=0", (blob_id,)).rowcount > 0

    def blob_expired(self, now: int | None = None) -> list[str]:
        """Удалить истёкшие записи (и брошенные загрузки). Возвращает их id, чтобы стереть файлы."""
        now = now or int(time.time())
        ids = [r[0] for r in self.db.execute("SELECT id FROM blobs WHERE expires_at<=?", (now,))]
        if ids:
            self.db.execute("DELETE FROM blobs WHERE expires_at<=?", (now,))
        return ids

    def blob_ids(self) -> set[str]:
        return {r[0] for r in self.db.execute("SELECT id FROM blobs")}

    # --- уборка ----------------------------------------------------------

    def cleanup(self, mailbox_idle_ttl: int, now: int | None = None) -> tuple[int, int]:
        now = now or int(time.time())
        msgs = self.db.execute("DELETE FROM messages WHERE expires_at<=?", (now,)).rowcount
        boxes = self.db.execute(
            "DELETE FROM mailboxes WHERE last_seen<=?", (now - mailbox_idle_ttl,)
        ).rowcount
        if boxes:  # подписка без единого ящика никому не нужна; живой клиент пришлёт её заново
            self.db.execute("DELETE FROM push_subs WHERE owner NOT IN (SELECT owner FROM mailboxes)")
        return msgs, boxes
