import base64
import contextlib
import json
import time

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import AUTH_CONTEXT, b64url_decode, create_app
from app.push import Vapid, endpoint_allowed
from app.store import Store
from test_relay import b64, mailbox

ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123"
HOSTS = Settings().push_hosts


def unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class FakePush:
    def __init__(self):
        self.calls: list[tuple[str, str, int]] = []
        self.status = 201

    def __call__(self, endpoint: str, authorization: str, ttl: int) -> int:
        self.calls.append((endpoint, authorization, ttl))
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


def subscribed(client, endpoint=ENDPOINT):
    """Получатель с ящиком и пуш-подпиской."""
    ws, key = connect(client)
    mb = mailbox()
    ws.send_json({"t": "register", "mailbox": mb})
    assert ws.receive_json()["t"] == "registered"
    ws.send_json({"t": "push-sub", "endpoint": endpoint})
    assert ws.receive_json() == {"t": "push-sub", "ok": True}
    return ws, key, mb


def send(ws, mb, msg_id, notify=True):
    frame = {"t": "send", "id": msg_id, "to": [mb], "payload": "ct"}
    if notify:
        frame["notify"] = True
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
    assert s.push_get("gone") is None and s.push_get("alive") == ENDPOINT
