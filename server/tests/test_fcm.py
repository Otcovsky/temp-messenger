"""Пуши в Android-приложение через FCM: подписка, зашифрованная пометка, сроки, отписка."""

import base64
import contextlib
import json
import os
import time

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi.testclient import TestClient

from app import fcm as fcm_module
from app.config import Settings
from app.fcm import Fcm, key_valid, token_valid
from app.main import AUTH_CONTEXT, b64url_decode, create_app
from test_relay import b64, mailbox

TOKEN = "dGVzdC10b2tlbg:APA91b" + "x" * 140


def unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class FakeFcm:
    def __init__(self):
        self.calls: list[tuple[str, dict, int]] = []
        self.status = 200

    def __call__(self, token: str, data: dict, ttl: int) -> int:
        self.calls.append((token, data, ttl))
        return self.status

    def wait(self, n: int, timeout: float = 2.0) -> None:
        end = time.monotonic() + timeout
        while len(self.calls) < n and time.monotonic() < end:
            time.sleep(0.01)
        assert len(self.calls) == n


class App:
    """Ключ, который приложение создаёт для расшифровки пометки."""

    def __init__(self):
        self.key = os.urandom(32)

    def sub(self, token=TOKEN) -> dict:
        return {"t": "push-sub", "fcm": token, "key": b64(self.key)}

    def open(self, data: dict) -> dict:
        raw = unb64(data["p"])
        return json.loads(AESGCM(self.key).decrypt(raw[:12], raw[12:], None))


@pytest.fixture
def fake():
    return FakeFcm()


def make_client(tmp_path, fcm_send, push_subject=""):
    cfg = Settings(
        db_path=str(tmp_path / "t.sqlite3"),
        blob_dir=str(tmp_path / "blobs"),
        push_subject=push_subject,
        push_delay_sec=0.15,
        push_offline_delay_sec=0.02,
    )
    return TestClient(create_app(cfg, fcm_send=fcm_send))


@pytest.fixture
def client(tmp_path, fake):
    with make_client(tmp_path, fake) as c, contextlib.ExitStack() as stack:
        c.stack = stack
        yield c


def connect(client):
    key = Ed25519PrivateKey.generate()
    ws = client.stack.enter_context(client.websocket_connect("/ws"))
    ch = ws.receive_json()
    sig = key.sign(AUTH_CONTEXT + b64url_decode(ch["nonce"]))
    pub = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    ws.send_json({"t": "auth", "pub": b64(pub), "sig": b64(sig)})
    return ws, ws.receive_json()


def subscribed(client, app: App):
    ws, _ = connect(client)
    mb = mailbox()
    ws.send_json({"t": "register", "mailbox": mb})
    assert ws.receive_json()["t"] == "registered"
    ws.send_json(app.sub())
    assert ws.receive_json() == {"t": "push-sub", "ok": True}
    return ws, mb


def send(ws, mb, msg_id, notify=True):
    ws.send_json({"t": "send", "id": msg_id, "to": [mb], "payload": "ct", "notify": notify})
    assert ws.receive_json() == {"t": "sent", "id": msg_id, "failed": []}


def test_ready_announces_fcm_without_web_push(client):
    _, ready = connect(client)
    assert ready == {"t": "ready", "fcm": True}


def test_ready_has_both_when_both_configured(tmp_path, fake):
    with make_client(tmp_path, fake, push_subject="https://chat.example") as c, contextlib.ExitStack() as stack:
        c.stack = stack
        _, ready = connect(c)
        assert ready["fcm"] is True and len(unb64(ready["push"])) == 65


def test_server_without_fcm_refuses_app_subscription(tmp_path):
    with make_client(tmp_path, None, push_subject="https://chat.example") as c, contextlib.ExitStack() as stack:
        c.stack = stack
        ws, ready = connect(c)
        assert "fcm" not in ready
        ws.send_json(App().sub())
        assert ws.receive_json()["code"] == "push_disabled"


def test_message_push_carries_encrypted_mark(client, fake):
    app = App()
    bob, mb = subscribed(client, app)
    bob.close()
    alice, _ = connect(client)
    send(alice, mb, "msg-00000001")
    fake.wait(1)
    token, data, ttl = fake.calls[0]
    assert token == TOKEN and ttl == 24 * 3600
    assert set(data) == {"p"}
    assert app.open(data) == {"k": "msg"}
    # Пометка не читается без ключа приложения
    assert b"msg" not in unb64(data["p"])


def test_call_and_call_end(client, fake):
    app = App()
    bob, mb = subscribed(client, app)
    bob.close()
    alice, _ = connect(client)
    send(alice, mb, "call-0000001", notify="call")
    fake.wait(1)
    assert app.open(fake.calls[0][1]) == {"k": "call"} and fake.calls[0][2] == 45
    send(alice, mb, "end-00000001", notify="call-end")
    fake.wait(2)
    assert app.open(fake.calls[1][1]) == {"k": "end"}


def test_no_push_when_app_acks(client, fake):
    bob, mb = subscribed(client, App())
    alice, _ = connect(client)
    send(alice, mb, "msg-00000001")
    frame = bob.receive_json()
    bob.send_json({"t": "ack", "mailbox": mb, "ids": [frame["id"]]})
    time.sleep(0.4)
    assert fake.calls == []


def test_unregistered_token_is_removed(client, fake):
    bob, _ = subscribed(client, App())
    fake.status = 404
    bob.send_json({"t": "push-test"})
    assert bob.receive_json() == {"t": "push-test", "status": 404}
    bob.send_json({"t": "push-test"})
    assert bob.receive_json()["code"] == "no_subscription"


def test_bad_token_and_key_refused(client):
    ws, _ = connect(client)
    ws.send_json({"t": "push-sub", "fcm": "short", "key": b64(os.urandom(32))})
    assert ws.receive_json()["code"] == "bad_endpoint"
    ws.send_json({"t": "push-sub", "fcm": TOKEN, "key": b64(os.urandom(16))})
    assert ws.receive_json()["code"] == "bad_keys"


def test_validators():
    assert token_valid(TOKEN)
    assert not token_valid("x" * 19) and not token_valid("bad token with spaces " * 3) and not token_valid(None)
    assert key_valid(b64(os.urandom(32)))
    assert not key_valid(b64(os.urandom(31))) and not key_valid("!!!") and not key_valid(None)


def test_fcm_client_signs_oauth_assertion_and_sends(tmp_path, monkeypatch):
    """Без сети: проверяем JWT для Google OAuth и запрос к FCM."""
    rsa_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = rsa_key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    creds = tmp_path / "sa.json"
    creds.write_text(
        json.dumps(
            {
                "type": "service_account",
                "project_id": "tm-test",
                "client_email": "push@tm-test.iam.gserviceaccount.com",
                "private_key": pem,
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        )
    )
    requests = []

    def fake_post(url, body, headers):
        requests.append((url, body, headers))
        if url.endswith("/token"):
            return 200, json.dumps({"access_token": "ya29.test", "expires_in": 3600}).encode()
        return 200, b"{}"

    monkeypatch.setattr(fcm_module, "_post", fake_post)
    f = Fcm(str(creds))
    assert f.send(TOKEN, {"p": "abc"}, 60) == 200
    assert f.send(TOKEN, {"p": "def"}, 60) == 200
    # OAuth-токен взят один раз и переиспользован
    assert [u for u, _, _ in requests] == [
        "https://oauth2.googleapis.com/token",
        "https://fcm.googleapis.com/v1/projects/tm-test/messages:send",
        "https://fcm.googleapis.com/v1/projects/tm-test/messages:send",
    ]
    form = dict(p.split("=", 1) for p in requests[0][1].decode().split("&"))
    head, claims, sig = form["assertion"].split(".")
    rsa_key.public_key().verify(unb64(sig), f"{head}.{claims}".encode(), padding.PKCS1v15(), hashes.SHA256())
    c = json.loads(unb64(claims))
    assert c["iss"] == "push@tm-test.iam.gserviceaccount.com"
    assert c["scope"] == "https://www.googleapis.com/auth/firebase.messaging"
    assert c["exp"] - c["iat"] == 3600
    msg = json.loads(requests[1][1])["message"]
    assert requests[1][2]["Authorization"] == "Bearer ya29.test"
    assert msg == {
        "token": TOKEN,
        "data": {"p": "abc"},
        "android": {"priority": "HIGH", "ttl": "60s", "collapse_key": "tm"},
    }
