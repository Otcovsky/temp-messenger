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
"""


@dataclass
class StoredMessage:
    mailbox_id: str
    id: str
    payload: str
    created_at: int


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

    # --- сообщения -------------------------------------------------------

    def enqueue(
        self, mailbox_id: str, msg_id: str, payload: str, ttl: int, max_queue: int, now: int | None = None
    ) -> str:
        """Возвращает 'stored', 'duplicate', 'no_mailbox' или 'queue_full'."""
        now = now or int(time.time())
        if not self.mailbox_exists(mailbox_id):
            return "no_mailbox"
        (count,) = self.db.execute(
            "SELECT COUNT(*) FROM messages WHERE mailbox_id=?", (mailbox_id,)
        ).fetchone()
        if count >= max_queue:
            return "queue_full"
        cur = self.db.execute(
            "INSERT OR IGNORE INTO messages(mailbox_id, id, payload, created_at, expires_at) "
            "VALUES (?,?,?,?,?)",
            (mailbox_id, msg_id, payload, now, now + ttl),
        )
        return "stored" if cur.rowcount else "duplicate"

    def pending(self, mailbox_id: str, limit: int = 500) -> list[StoredMessage]:
        rows = self.db.execute(
            "SELECT mailbox_id, id, payload, created_at FROM messages "
            "WHERE mailbox_id=? ORDER BY created_at, rowid LIMIT ?",
            (mailbox_id, limit),
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

    # --- уборка ----------------------------------------------------------

    def cleanup(self, mailbox_idle_ttl: int, now: int | None = None) -> tuple[int, int]:
        now = now or int(time.time())
        msgs = self.db.execute("DELETE FROM messages WHERE expires_at<=?", (now,)).rowcount
        boxes = self.db.execute(
            "DELETE FROM mailboxes WHERE last_seen<=?", (now - mailbox_idle_ttl,)
        ).rowcount
        return msgs, boxes
