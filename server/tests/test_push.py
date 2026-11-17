import base64
import contextlib
import json
import os
import time

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import AUTH_CONTEXT, b64url_decode, create_app
from app.push import Vapid, encrypt_payload, endpoint_allowed, keys_valid
from app.store import Store
from test_relay import b64, mailbox

ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123"
HOSTS = Settings().push_hosts


def unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class FakePush:
    def __init__(self):
        self.calls: list[tuple[str, str, int]] = []
        self.bodies: list[bytes | None] = []
        self.status = 201

    def __call__(self, endpoint: str, authorization: str, ttl: int, body: bytes | None = None) -> int:
        self.calls.append((endpoint, authorization, ttl))
        self.bodies.append(body)
        return self.status

    def wait(self, n: int, timeout: float = 2.0) -> None:
        end = time.monotonic() + timeout
        while len(self.calls) < n and time.monotonic() < end:
            time.sleep(0.01)
        assert len(self.calls) == n


@pytest.fixture
def push():
    return FakePush()


@pytest.fixture
def client(tmp_path, push):
    cfg = Settings(
        db_path=str(tmp_path / "t.sqlite3"),
        blob_dir=str(tmp_path / "blobs"),
        push_subject="https://chat.example",
        push_delay_sec=0.15,
        push_offline_delay_sec=0.02,
    )
    with TestClient(create_app(cfg, push_send=push)) as c, contextlib.ExitStack() as stack:
        c.stack = stack
        yield c


def connect(client, with_push=True):
    """Как в test_relay, но сервер с пушами присылает в ready свой ключ VAPID."""
    key = Ed25519PrivateKey.generate()
    ws = client.stack.enter_context(client.websocket_connect("/ws"))
    ch = ws.receive_json()
    sig = key.sign(AUTH_CONTEXT + b64url_decode(ch["nonce"]))
    pub = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    ws.send_json({"t": "auth", "pub": b64(pub), "sig": b64(sig)})
    ready = ws.receive_json()
    if with_push:
        assert ready["t"] == "ready" and len(unb64(ready["push"])) == 65
    else:
        assert ready == {"t": "ready"}
    return ws, key


class Browser:
    """Ключи подписки, как их создаёт браузер, и расшифровка пуша по RFC 8291."""

    def __init__(self):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.auth = os.urandom(16)
        self.public = self.key.public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)

    @property
    def keys(self) -> dict:
        return {"p256dh": b64(self.public), "auth": b64(self.auth)}

    def decrypt(self, body: bytes) -> bytes:
        salt, idlen = body[:16], body[20]
        as_public = body[21 : 21 + idlen]
        shared = self.key.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_public))
        ikm = HKDF(hashes.SHA256(), 32, self.auth, b"WebPush: info\x00" + self.public + as_public).derive(shared)
        cek = HKDF(hashes.SHA256(), 16, salt, b"Content-Encoding: aes128gcm\x00").derive(ikm)
        nonce = HKDF(hashes.SHA256(), 12, salt, b"Content-Encoding: nonce\x00").derive(ikm)
        record = AESGCM(cek).decrypt(nonce, body[21 + idlen :], None)
        assert record.endswith(b"\x02")
        return record[:-1]


def subscribed(client, endpoint=ENDPOINT, browser: Browser | None = None):
    """Получатель с ящиком и пуш-подпиской (с ключами браузера или, как старый клиент, без них)."""
    ws, key = connect(client)
    mb = mailbox()
    ws.send_json({"t": "register", "mailbox": mb})
    assert ws.receive_json()["t"] == "registered"
    ws.send_json({"t": "push-sub", "endpoint": endpoint, **(browser.keys if browser else {})})
    assert ws.receive_json() == {"t": "push-sub", "ok": True}
    return ws, key, mb


def send(ws, mb, msg_id, notify=True):
    frame = {"t": "send", "id": msg_id, "to": [mb], "payload": "ct"}
    if notify:
        frame["notify"] = notify
    ws.send_json(frame)
    assert ws.receive_json() == {"t": "sent", "id": msg_id, "failed": []}


def test_ready_without_push_subject_has_no_key(tmp_path):
    cfg = Settings(db_path=str(tmp_path / "t.sqlite3"), blob_dir=str(tmp_path / "blobs"))
    with TestClient(create_app(cfg)) as c, contextlib.ExitStack() as stack:
        c.stack = stack
        ws, _ = connect(c, with_push=False)
        ws.send_json({"t": "push-sub", "endpoint": ENDPOINT})
        assert ws.receive_json()["code"] == "push_disabled"


def test_push_when_recipient_offline(client, push):
    bob, _, mb = subscribed(client)
    bob.close()
    alice, _ = connect(client)
    send(alice, mb, "msg-00000001")
    push.wait(1)
    endpoint, authorization, ttl = push.calls[0]
    assert endpoint == ENDPOINT and ttl == 24 * 3600
    assert authorization.startswith("vapid t=")


def test_no_push_for_service_messages(client, push):
    bob, _, mb = subscribed(client)
    bob.close()
    alice, _ = connect(client)
    send(alice, mb, "msg-00000001", notify=False)
    time.sleep(0.3)
    assert push.calls == []


def test_no_push_when_recipient_acks(client, push):
    bob, _, mb = subscribed(client)
    alice, _ = connect(client)
    send(alice, mb, "msg-00000001")
    assert bob.receive_json()["t"] == "msg"
    bob.send_json({"t": "ack", "mailbox": mb, "ids": ["msg-00000001"]})
    time.sleep(0.4)
    assert push.calls == []


def test_push_when_connection_is_silent(client, push):
    """Соединение открыто, но ack не приходит (телефон уснул) — пуш уходит после паузы."""
    bob, _, mb = subscribed(client)
    alice, _ = connect(client)
    send(alice, mb, "msg-00000001")
    push.wait(1)


def test_burst_gives_one_push(client, push):
    bob, _, mb = subscribed(client)
    bob.close()
    alice, _ = connect(client)
    for i in range(5):
        send(alice, mb, f"msg-0000000{i}")
    push.wait(1)
    time.sleep(0.2)
    assert len(push.calls) == 1


def test_gone_subscription_is_removed(client, push):
    bob, _, mb = subscribed(client)
    bob.close()
    push.status = 410
    alice, _ = connect(client)
    send(alice, mb, "msg-00000001")
    push.wait(1)
    time.sleep(0.1)
    send(alice, mb, "msg-00000002")
    time.sleep(0.3)
    assert len(push.calls) == 1


def test_unsubscribe(client, push):
    bob, _, mb = subscribed(client)
    bob.send_json({"t": "push-unsub"})
    assert bob.receive_json() == {"t": "push-unsub", "ok": True}
    bob.close()
    alice, _ = connect(client)
    send(alice, mb, "msg-00000001")
    time.sleep(0.3)
    assert push.calls == []


def test_encryption_matches_rfc8291_example():
    """Пример из раздела 5 стандарта: те же ключи и соль дают то же тело запроса."""
    sender = ec.derive_private_key(
        int.from_bytes(unb64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), "big"), ec.SECP256R1()
    )
    body = encrypt_payload(
        b"When I grow up, I want to be a watermelon",
        unb64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
        unb64("BTBZMqHH6r4Tts7J_aSIgg"),
        as_private=sender,
        salt=unb64("DGv6ra1nlYgDCS1FRnbzlw"),
    )
    assert b64(body) == (
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml"
        "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT"
        "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
    )


def test_call_push_carries_encrypted_mark(client, push):
    browser = Browser()
    bob, _, mb = subscribed(client, browser=browser)
    bob.close()
    alice, _ = connect(client)
    send(alice, mb, "msg-00000001", notify="call")
    push.wait(1)
    assert browser.decrypt(push.bodies[0]) == b'{"k":"call"}'
    assert push.calls[0][2] == 45  # опоздавший звонок не нужен: пуш-сервис держит его недолго

    time.sleep(0.1)
    send(alice, mb, "msg-00000002", notify="call-end")
    push.wait(2)
    assert browser.decrypt(push.bodies[1]) == b'{"k":"end"}'
    assert push.calls[1][2] == 24 * 3600


def test_message_push_stays_empty(client, push):
    bob, _, mb = subscribed(client, browser=Browser())
    bob.close()
    alice, _ = connect(client)
    send(alice, mb, "msg-00000001")
    push.wait(1)
    assert push.bodies == [None]


def test_call_to_old_subscription_gets_plain_push(client, push):
    bob, _, mb = subscribed(client)  # подписка без ключей: шифровать нечем
    bob.close()
    alice, _ = connect(client)
    send(alice, mb, "msg-00000001", notify="call")
    push.wait(1)
    assert push.bodies == [None]


def test_latest_unread_decides_push_kind(client, push):
    browser = Browser()
    bob, _, mb = subscribed(client, browser=browser)
    bob.close()
    alice, _ = connect(client)
    send(alice, mb, "msg-00000001")
    send(alice, mb, "msg-00000002", notify="call")
    push.wait(1)
    assert browser.decrypt(push.bodies[0]) == b'{"k":"call"}'


def test_unknown_notify_value_is_ignored(client, push):
    bob, _, mb = subscribed(client, browser=Browser())
    bob.close()
    alice, _ = connect(client)
    send(alice, mb, "msg-00000001", notify="video")
    time.sleep(0.3)
    assert push.calls == []


def test_subscription_keys_are_validated(client):
    ws, _ = connect(client)
    good = Browser().keys
    for bad in (
        {"p256dh": good["p256dh"]},
        {"p256dh": good["p256dh"], "auth": b64(b"short")},
        {"p256dh": b64(os.urandom(65)), "auth": good["auth"]},
        {"p256dh": 5, "auth": good["auth"]},
    ):
        ws.send_json({"t": "push-sub", "endpoint": ENDPOINT, **bad})
        assert ws.receive_json()["code"] == "bad_keys"
    assert keys_valid(**good)


def test_push_test_can_ring(client, push):
    browser = Browser()
    bob, _, mb = subscribed(client, browser=browser)
    bob.send_json({"t": "push-test", "kind": "call"})
    assert bob.receive_json() == {"t": "push-test", "status": 201}
    assert browser.decrypt(push.bodies[0]) == b'{"k":"call"}'
    bob.send_json({"t": "push-test", "kind": "video"})
    assert bob.receive_json()["code"] == "bad_kind"


def test_store_migrates_subscriptions_without_keys(tmp_path):
    import sqlite3

    path = str(tmp_path / "old.sqlite3")
    db = sqlite3.connect(path)
    db.executescript(
        "CREATE TABLE push_subs (owner TEXT PRIMARY KEY, endpoint TEXT NOT NULL, created_at INTEGER NOT NULL);"
        "INSERT INTO push_subs VALUES ('o', 'https://fcm.googleapis.com/x', 1);"
    )
    db.close()
    store = Store(path)
    sub = store.push_get("o")
    assert sub.endpoint == "https://fcm.googleapis.com/x" and sub.p256dh is None
    store.close()


def test_push_test_reports_service_status(client, push):
    bob, _, mb = subscribed(client)
    bob.send_json({"t": "push-test"})
    assert bob.receive_json() == {"t": "push-test", "status": 201}
    assert len(push.calls) == 1

    push.status = 410  # пуш-сервис говорит, что подписки нет — сервер её забывает
    bob.send_json({"t": "push-test"})
    assert bob.receive_json() == {"t": "push-test", "status": 410}
    bob.send_json({"t": "push-test"})
    assert bob.receive_json()["code"] == "no_subscription"


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://fcm.googleapis.com/fcm/send/x",
        "https://127.0.0.1/x",
        "https://evil.example/fcm.googleapis.com",
        "https://fcm.googleapis.com.evil.example/x",
        "https://fcm.googleapis.com:8443/x",
        "https://user@fcm.googleapis.com/x",
        "https://fcm.googleapis.com/" + "x" * 2000,
        "",
        None,
        42,
    ],
)
def test_foreign_endpoints_rejected(endpoint):
    assert not endpoint_allowed(endpoint, HOSTS)


@pytest.mark.parametrize(
    "endpoint",
    [
        ENDPOINT,
        "https://web.push.apple.com/QGk",
        "https://updates.push.services.mozilla.com/wpush/v2/x",
        "https://wns2-par02p.notify.windows.com/w/?token=x",
    ],
)
def test_known_push_services_allowed(endpoint):
    assert endpoint_allowed(endpoint, HOSTS)


def test_bad_endpoint_refused_by_server(client):
    ws, _ = connect(client)
    ws.send_json({"t": "push-sub", "endpoint": "https://127.0.0.1/x"})
    assert ws.receive_json()["code"] == "bad_endpoint"


def test_vapid_token_is_valid_and_key_persists(tmp_path):
    path = str(tmp_path / "v.sqlite3")
    store = Store(path)
    vapid = Vapid(store, "https://chat.example")
    scheme, t, k = vapid.authorization(ENDPOINT, now=1_000_000).replace(",", "").split(" ")
    assert scheme == "vapid" and k == f"k={vapid.public}"
    head, body, sig = t.removeprefix("t=").split(".")
    assert json.loads(unb64(head)) == {"typ": "JWT", "alg": "ES256"}
    assert json.loads(unb64(body)) == {
        "aud": "https://fcm.googleapis.com",
        "exp": 1_000_000 + 12 * 3600,
        "sub": "https://chat.example",
    }
    raw = unb64(sig)
    der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), unb64(vapid.public))
    pub.verify(der, f"{head}.{body}".encode(), ec.ECDSA(hashes.SHA256()))
    store.close()

    store = Store(path)  # после перезапуска ключ тот же — подписки клиентов остаются годными
    assert Vapid(store, "https://chat.example").public == vapid.public
    store.close()


def test_cleanup_drops_orphan_subscriptions(tmp_path):
    s = Store(str(tmp_path / "c.sqlite3"))
    s.register("a" * 22, "gone", now=1000)
    s.register("b" * 22, "alive", now=1090)
    s.push_set("gone", ENDPOINT)
    s.push_set("alive", ENDPOINT)
    s.cleanup(mailbox_idle_ttl=100, now=1101)
    assert s.push_get("gone") is None and s.push_get("alive").endpoint == ENDPOINT
