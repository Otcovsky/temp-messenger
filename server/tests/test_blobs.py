import base64
import contextlib
import os

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi.testclient import TestClient

from app.blobs import BLOB_CONTEXT, BlobFiles, cleanup_blobs
from app.config import Settings
from app.main import create_app
from app.store import Store


def b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def blob_id() -> str:
    return b64(os.urandom(16))


def auth(key: Ed25519PrivateKey, bid: str, size: int, n: int = 1) -> dict:
    pub = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    sig = key.sign(BLOB_CONTEXT + f"{bid}:{size}:{n}".encode())
    return {"X-TM-Auth": f"{b64(pub)}.{b64(sig)}"}


@pytest.fixture
def cfg(tmp_path):
    return Settings(
        db_path=str(tmp_path / "t.sqlite3"),
        blob_dir=str(tmp_path / "blobs"),
        max_blob_bytes=1000,
        blob_quota_per_owner=1500,
        blob_quota_total=2500,
    )


@pytest.fixture
def client(cfg):
    with TestClient(create_app(cfg)) as c:
        yield c


def put(client, key, bid, data: bytes, n=1, headers=None):
    return client.put(f"/blob/{bid}?n={n}", content=data, headers=auth(key, bid, len(data), n) if headers is None else headers)


def test_upload_download_and_delete_after_all_recipients(client, cfg):
    key = Ed25519PrivateKey.generate()
    bid = blob_id()
    assert put(client, key, bid, b"x" * 100, n=2).status_code == 201
    # Повтор (ответ потерялся) — успех, файл тот же
    assert put(client, key, bid, b"x" * 100, n=2).status_code == 200

    r = client.get(f"/blob/{bid}")
    assert r.status_code == 200 and r.content == b"x" * 100
    assert r.headers["cache-control"] == "no-store"

    assert client.post(f"/blob/{bid}/done").status_code == 204
    assert client.get(f"/blob/{bid}").status_code == 200  # второй получатель ещё не скачал
    client.post(f"/blob/{bid}/done")
    assert client.get(f"/blob/{bid}").status_code == 404
    assert not os.listdir(cfg.blob_dir)


def test_upload_requires_valid_signature(client):
    key = Ed25519PrivateKey.generate()
    bid = blob_id()
    # Подпись на другой размер
    assert put(client, key, bid, b"abc", headers=auth(key, bid, 4)).status_code == 403
    assert put(client, key, bid, b"abc", headers={}).status_code == 403
    assert client.get(f"/blob/{bid}").status_code == 404


def test_limits(client):
    key = Ed25519PrivateKey.generate()
    assert put(client, key, blob_id(), b"x" * 1001).status_code == 413
    assert put(client, key, blob_id(), b"x" * 10, n=0).status_code == 400
    assert client.put("/blob/bad", content=b"x").status_code == 404

    # Квота одного ключа: 1500 байт
    assert put(client, key, blob_id(), b"x" * 900).status_code == 201
    assert put(client, key, blob_id(), b"x" * 700).status_code == 507
    # Другой ключ ещё может, пока не кончится общая квота (2500)
    other = Ed25519PrivateKey.generate()
    assert put(client, other, blob_id(), b"x" * 1000).status_code == 201
    assert put(client, other, blob_id(), b"x" * 700).status_code == 507


def test_foreign_id_conflict(client):
    a, b = Ed25519PrivateKey.generate(), Ed25519PrivateKey.generate()
    bid = blob_id()
    assert put(client, a, bid, b"a" * 10).status_code == 201
    assert put(client, b, bid, b"b" * 10).status_code == 409
    assert client.get(f"/blob/{bid}").content == b"a" * 10


def test_expiry_and_orphans(tmp_path):
    store = Store(str(tmp_path / "s.sqlite3"))
    files = BlobFiles(str(tmp_path / "blobs"))
    assert store.blob_reserve("a" * 22, "o", 5, 1, upload_timeout=10, quota_owner=100, quota_total=100, now=1000) == "ok"
    # Загрузка идёт — повтор того же id ждёт
    assert store.blob_reserve("a" * 22, "o", 5, 1, 10, 100, 100, now=1001) == "busy"
    files.path("a" * 22).write_bytes(b"12345")
    store.blob_complete("a" * 22, ttl=100, now=1005)
    assert store.blob_available("a" * 22, now=1100)
    assert not store.blob_available("a" * 22, now=1105)

    # Брошенная загрузка истекает по таймауту
    store.blob_reserve("b" * 22, "o", 5, 1, upload_timeout=10, quota_owner=100, quota_total=100, now=1000)
    files.part("b" * 22).write_bytes(b"12")
    files.path("c" * 22).write_bytes(b"orphan")
    assert sorted(store.blob_expired(now=1050)) == ["b" * 22]
    files.remove("b" * 22)
    assert files.sweep(store.blob_ids()) == 1  # "c" — без записи в базе
    assert sorted(os.listdir(files.root)) == ["a" * 22]

    with contextlib.suppress(Exception):
        store.close()


def test_cleanup_blobs(tmp_path):
    store = Store(str(tmp_path / "s.sqlite3"))
    files = BlobFiles(str(tmp_path / "blobs"))
    store.blob_reserve("a" * 22, "o", 1, 1, upload_timeout=-1, quota_owner=10, quota_total=10)
    files.part("a" * 22).write_bytes(b"1")
    assert cleanup_blobs(store, files) == 1
    assert not os.listdir(files.root)
    store.close()


def test_cors_allows_only_app_origin(client):
    """Android-приложение (https://localhost) качает файлы с другого адреса — сервер это разрешает."""
    bid = blob_id()
    pre = client.options(
        f"/blob/{bid}",
        headers={
            "Origin": "https://localhost",
            "Access-Control-Request-Method": "PUT",
            "Access-Control-Request-Headers": "x-tm-auth,content-type",
        },
    )
    assert pre.status_code == 200
    assert pre.headers["access-control-allow-origin"] == "https://localhost"
    assert "PUT" in pre.headers["access-control-allow-methods"]
    assert "access-control-allow-credentials" not in pre.headers

    key = Ed25519PrivateKey.generate()
    h = auth(key, bid, 3) | {"Origin": "https://localhost"}
    assert put(client, key, bid, b"abc", headers=h).status_code == 201
    got = client.get(f"/blob/{bid}", headers={"Origin": "https://localhost"})
    assert got.content == b"abc"
    assert got.headers["access-control-allow-origin"] == "https://localhost"

    # Чужие сайты разрешения не получают
    other = client.get(f"/blob/{bid}", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in other.headers
    bad = client.options(
        f"/blob/{bid}", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "PUT"}
    )
    assert "access-control-allow-origin" not in bad.headers
