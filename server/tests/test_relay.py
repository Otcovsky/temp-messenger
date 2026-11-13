import base64
import contextlib
import os

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import AUTH_CONTEXT, b64url_decode, create_app
from app.store import Store


def b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def mailbox() -> str:
    return b64(os.urandom(16))


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(db_path=str(tmp_path / "t.sqlite3"), blob_dir=str(tmp_path / "blobs")))
    with TestClient(app) as c, contextlib.ExitStack() as stack:
        c.stack = stack  # все открытые в тесте сокеты закроются до остановки приложения
        yield c


def connect(client, key=None):
    key = key or Ed25519PrivateKey.generate()
    ws = client.stack.enter_context(client.websocket_connect("/ws"))
    ch = ws.receive_json()
    assert ch["t"] == "challenge"
    sig = key.sign(AUTH_CONTEXT + b64url_decode(ch["nonce"]))
    pub = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    ws.send_json({"t": "auth", "pub": b64(pub), "sig": b64(sig)})
    assert ws.receive_json() == {"t": "ready"}
    return ws, key


def test_bad_signature_rejected(client):
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        key = Ed25519PrivateKey.generate()
        pub = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        ws.send_json({"t": "auth", "pub": b64(pub), "sig": b64(key.sign(b"wrong"))})
        assert ws.receive_json() == {"t": "error", "code": "auth_failed"}


def test_online_delivery_and_ack(client):
    alice, _ = connect(client)
    bob, _ = connect(client)
    mb = mailbox()
    bob.send_json({"t": "register", "mailbox": mb})
    assert bob.receive_json()["t"] == "registered"

    alice.send_json({"t": "send", "id": "msg-00000001", "to": [mb], "payload": "ct"})
    msg = bob.receive_json()
    assert msg["t"] == "msg" and msg["payload"] == "ct" and msg["mailbox"] == mb
    assert alice.receive_json() == {"t": "sent", "id": "msg-00000001", "failed": []}

    bob.send_json({"t": "ack", "mailbox": mb, "ids": ["msg-00000001"]})
    bob.send_json({"t": "ping"})
    assert bob.receive_json() == {"t": "pong"}

    # После ack при переподключении очередь пуста
    bob.send_json({"t": "register", "mailbox": mb})
    assert bob.receive_json()["t"] == "registered"
    bob.send_json({"t": "ping"})
    assert bob.receive_json() == {"t": "pong"}


def test_offline_queue_and_dedup(client):
    bob, bob_key = connect(client)
    mb = mailbox()
    bob.send_json({"t": "register", "mailbox": mb})
    bob.receive_json()
    bob.close()

    alice, _ = connect(client)
    for _ in range(2):  # повторная отправка того же id не дублирует
        alice.send_json({"t": "send", "id": "msg-00000002", "to": [mb], "payload": "x"})
        assert alice.receive_json()["failed"] == []

    bob2, _ = connect(client, bob_key)
    bob2.send_json({"t": "register", "mailbox": mb})
    assert bob2.receive_json()["created"] is False
    assert bob2.receive_json()["id"] == "msg-00000002"
    bob2.send_json({"t": "ping"})
    assert bob2.receive_json() == {"t": "pong"}


def test_foreign_mailbox_forbidden_and_unknown_fails(client):
    bob, _ = connect(client)
    mb = mailbox()
    bob.send_json({"t": "register", "mailbox": mb})
    bob.receive_json()

    eve, _ = connect(client)
    eve.send_json({"t": "register", "mailbox": mb})
    assert eve.receive_json() == {"t": "error", "code": "forbidden", "ref": mb}

    unknown = mailbox()
    eve.send_json({"t": "send", "id": "msg-00000003", "to": [mb, unknown], "payload": "p"})
    bob.receive_json()  # bob получил
    assert eve.receive_json()["failed"] == [{"to": unknown, "reason": "no_mailbox"}]


def test_store_cleanup(tmp_path):
    s = Store(str(tmp_path / "c.sqlite3"))
    s.register("a" * 22, "owner", now=1000)
    assert s.enqueue("a" * 22, "m1", "p", ttl=10, max_queue=5, now=1000) == "stored"
    assert s.cleanup(mailbox_idle_ttl=100, now=1011) == (1, 0)
    assert s.cleanup(mailbox_idle_ttl=100, now=1100) == (0, 1)


def test_probe_invite_state(client):
    alice, _ = connect(client)
    bob, _ = connect(client)
    mb = mailbox()
    bob.send_json({"t": "probe", "mailbox": mb})
    assert bob.receive_json() == {"t": "probe", "mailbox": mb, "state": "none"}

    alice.send_json({"t": "register", "mailbox": mb, "invite": True})
    assert alice.receive_json()["t"] == "registered"
    bob.send_json({"t": "probe", "mailbox": mb})
    assert bob.receive_json()["state"] == "open"

    # Приглашение принято — ящик стал обычным
    alice.send_json({"t": "register", "mailbox": mb, "invite": False})
    alice.receive_json()
    bob.send_json({"t": "probe", "mailbox": mb})
    assert bob.receive_json()["state"] == "used"

    # Регистрация без флага его не меняет
    alice.send_json({"t": "register", "mailbox": mb})
    alice.receive_json()
    bob.send_json({"t": "probe", "mailbox": mb})
    assert bob.receive_json()["state"] == "used"

    alice.send_json({"t": "unregister", "mailbox": mb})
    alice.receive_json()
    bob.send_json({"t": "probe", "mailbox": mb})
    assert bob.receive_json()["state"] == "none"


def test_store_migrates_old_schema(tmp_path):
    import sqlite3

    path = str(tmp_path / "old.sqlite3")
    db = sqlite3.connect(path)
    db.executescript(
        "CREATE TABLE mailboxes (id TEXT PRIMARY KEY, owner TEXT NOT NULL,"
        " created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);"
        "INSERT INTO mailboxes VALUES ('legacy', 'o', 1, 1);"
    )
    db.close()
    store = Store(path)
    assert store.invite_state("legacy") == "open"
    store.close()


def test_health_reports_version(tmp_path):
    vf = tmp_path / "VERSION"
    vf.write_text("abc1234\n")
    cfg = Settings(db_path=str(tmp_path / "t.sqlite3"), blob_dir=str(tmp_path / "blobs"), version_file=str(vf))
    with TestClient(create_app(cfg)) as c:
        assert c.get("/health").json() == {"ok": True, "version": "abc1234"}
    cfg = Settings(db_path=str(tmp_path / "t.sqlite3"), blob_dir=str(tmp_path / "blobs"), version_file=str(tmp_path / "nope"))
    with TestClient(create_app(cfg)) as c:
        assert c.get("/health").json() == {"ok": True, "version": "dev"}
