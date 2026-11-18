"""Защита диска от того, кто заводит ключи пачками: потолок очереди и квоты на адрес клиента."""

import contextlib

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.quota import BlobLedger, SendBudget, ip_key
from app.store import Store, message_cost
from test_blobs import auth, blob_id
from test_relay import connect, mailbox

A, B = "a" * 22, "b" * 22


# --- счётчик очереди ------------------------------------------------------


def test_message_cost_counts_row_and_minimum():
    assert message_cost(1) == message_cost(768) == 1024  # мелочь стоит как 1 КиБ
    assert message_cost(10_000) == 10_256  # шифротекст плюс строка


def test_queue_bytes_counter(tmp_path):
    s = Store(str(tmp_path / "q.sqlite3"))
    s.register(A, "owner", now=1000)
    s.register(B, "owner", now=1000)
    assert s.queue_bytes() == 0
    s.enqueue(A, "m1", "x" * 2000, ttl=10, max_queue=5, now=1000)
    s.enqueue(A, "m1", "x" * 2000, ttl=10, max_queue=5, now=1000)  # дубликат не считается
    s.enqueue(A, "m2", "я" * 1000, ttl=100, max_queue=5, now=1000)  # байты UTF-8, не символы
    s.enqueue(B, "m3", "x", ttl=100, max_queue=5, now=1000)
    assert s.queue_bytes() == message_cost(2000) + message_cost(2000) + message_cost(1)
    s.ack(A, "owner", ["m2"])
    assert s.queue_bytes() == message_cost(2000) + message_cost(1)
    s.cleanup(mailbox_idle_ttl=10_000, now=1011)  # истёк m1
    assert s.queue_bytes() == message_cost(1)
    s.unregister(B, "owner")  # сообщения ящика уходят каскадом
    assert s.queue_bytes() == 0


def test_queue_bytes_survive_restart_and_upgrade(tmp_path):
    path = str(tmp_path / "u.sqlite3")
    s = Store(path)
    s.register(A, "owner", now=1000)
    s.enqueue(A, "m1", "x" * 5000, ttl=10, max_queue=5, now=1000)
    s.close()
    assert Store(path).queue_bytes() == message_cost(5000)  # счётчик хранится в базе

    # База версии 1: триггеры считали только шифротекст — при запуске пересчёт по новым правилам
    s = Store(path)
    s.db.executescript(
        "DROP TRIGGER messages_bytes_ins; DROP TRIGGER messages_bytes_del;"
        "CREATE TRIGGER messages_bytes_ins AFTER INSERT ON messages BEGIN "
        "UPDATE queue_stats SET bytes = bytes + length(CAST(new.payload AS BLOB)) WHERE id=1; END;"
        "CREATE TRIGGER messages_bytes_del AFTER DELETE ON messages BEGIN "
        "UPDATE queue_stats SET bytes = bytes - length(CAST(old.payload AS BLOB)) WHERE id=1; END;"
        "UPDATE queue_stats SET bytes = 5000; DELETE FROM meta WHERE key='queue_stats_v';"
    )
    s.close()
    s = Store(path)
    assert s.queue_bytes() == message_cost(5000)
    s.enqueue(A, "m2", "x", ttl=10, max_queue=5, now=1000)
    assert s.queue_bytes() == message_cost(5000) + message_cost(1)
    s.ack(A, "owner", ["m1", "m2"])
    assert s.queue_bytes() == 0

    # База без счётчика вовсе (до потолка очереди)
    s.enqueue(A, "m3", "x" * 3000, ttl=10, max_queue=5, now=1000)
    s.db.executescript(
        "DROP TRIGGER messages_bytes_ins; DROP TRIGGER messages_bytes_del; DROP TABLE queue_stats;"
        "DELETE FROM meta WHERE key='queue_stats_v';"
    )
    s.close()
    assert Store(path).queue_bytes() == message_cost(3000)


def test_store_server_full(tmp_path):
    s = Store(str(tmp_path / "f.sqlite3"))
    s.register(A, "owner", now=1000)
    cap = 3 * 1024
    assert s.enqueue(A, "m1", "x" * 1500, ttl=10, max_queue=5, now=1000, max_total_bytes=cap) == "stored"
    assert s.enqueue(A, "m2", "x" * 1500, ttl=10, max_queue=5, now=1000, max_total_bytes=cap) == "server_full"
    assert s.enqueue(A, "m3", "x", ttl=10, max_queue=5, now=1000, max_total_bytes=cap) == "stored"
    s.ack(A, "owner", ["m1"])  # место освободилось
    assert s.enqueue(A, "m2", "x" * 1500, ttl=10, max_queue=5, now=1000, max_total_bytes=cap) == "stored"


def test_send_refused_when_queue_full(tmp_path, caplog):
    cfg = Settings(
        db_path=str(tmp_path / "t.sqlite3"), blob_dir=str(tmp_path / "blobs"), max_queue_bytes_total=2048
    )
    with TestClient(create_app(cfg)) as client, contextlib.ExitStack() as stack:
        client.stack = stack
        bot, _ = connect(client)
        mb = mailbox()
        bot.send_json({"t": "register", "mailbox": mb})
        bot.receive_json()
        bot.send_json({"t": "send", "id": "msg-00000001", "to": [mb], "payload": "x" * 900})
        assert bot.receive_json()["t"] == "msg"
        assert bot.receive_json() == {"t": "sent", "id": "msg-00000001", "failed": []}
        bot.send_json({"t": "send", "id": "msg-00000002", "to": [mb], "payload": "x" * 900})
        assert bot.receive_json() == {
            "t": "sent", "id": "msg-00000002", "failed": [{"to": mb, "reason": "server_full"}]
        }
        assert "message queue is full" in caplog.text


# --- адрес клиента ----------------------------------------------------------


def test_ip_key():
    assert ip_key("203.0.113.7") == "203.0.113.7"
    assert ip_key("::ffff:203.0.113.7") == "203.0.113.7"
    # IPv6 — по сети /64: абоненту обычно выдают её целиком
    assert ip_key("2001:db8:1:2:aaaa::1") == ip_key("2001:db8:1:2:bbbb::9") == "2001:db8:1:2::/64"
    assert ip_key("2001:db8:1:3::1") != ip_key("2001:db8:1:2::1")
    # Локальный адрес (nginx не передал клиента, разработка) и мусор — без квоты
    for host in ("127.0.0.1", "::1", "testclient", "", None):
        assert ip_key(host) is None


# --- очередь: ведро на адрес ------------------------------------------------


def test_send_budget_charge_refund_refill():
    b = SendBudget(capacity=10_000, refill_sec=100, refund_window_sec=60)
    ip = "203.0.113.7"
    for i in range(5):
        assert b.allows(ip, 2000, now=0)
        b.charge(ip, (A, f"m{i}"), 2000, now=0)
    assert not b.allows(ip, 2000, now=0)
    assert b.allows("198.51.100.1", 2000, now=0)  # у другого адреса своё ведро
    assert b.allows(None, 10**9, now=0)  # без адреса — без квоты

    b.refund((A, "m0"), now=30)  # ack быстрый — вернулось
    assert b.allows(ip, 2000, now=30)
    b.refund((A, "m0"), now=30)  # повторный ack ничего не добавляет
    assert not b.allows(ip, 2000 + 3001, now=30)  # 2000 возврата + 3000 пополнения за 30 с

    b.refund((A, "m1"), now=200)  # ack после окна — не возвращается, но ведро уже пополнилось
    assert b.allows(ip, 10_000, now=200) and not b.allows(ip, 10_001, now=200)


def test_send_budget_prune_and_tracking_bound():
    b = SendBudget(capacity=1000, refill_sec=10, refund_window_sec=60, max_tracked=3)
    for i in range(5):
        b.charge("203.0.113.7", (A, f"m{i}"), 100, now=0)
    assert len(b.recent) == 3  # самые старые забыты — без возврата
    b.prune(now=1)
    assert "203.0.113.7" in b.buckets
    b.prune(now=100)  # ведро полное — адрес забыт
    assert b.buckets == {}


def per_ip_client(tmp_path, ip, **kw):
    cfg = Settings(db_path=str(tmp_path / "t.sqlite3"), blob_dir=str(tmp_path / "blobs"), **kw)
    return TestClient(create_app(cfg), client=(ip, 50000))


def test_send_quota_per_ip_and_refund_on_ack(tmp_path):
    with per_ip_client(tmp_path, "203.0.113.7", queue_bytes_per_ip=3 * 1024) as client, contextlib.ExitStack() as st:
        client.stack = st
        bot, _ = connect(client)
        sink, _ = connect(client)
        mbs = [mailbox() for _ in range(4)]
        for mb in mbs:
            sink.send_json({"t": "register", "mailbox": mb})
            sink.receive_json()

        # Три сообщения по 1 КиБ ведро вмещает, четвёртое — нет
        bot.send_json({"t": "send", "id": "msg-00000001", "to": mbs, "payload": "x"})
        for _ in range(3):
            assert sink.receive_json()["t"] == "msg"
        assert bot.receive_json() == {
            "t": "sent", "id": "msg-00000001", "failed": [{"to": mbs[3], "reason": "quota"}]
        }

        # Получатель подтвердил — место вернулось, можно слать дальше
        sink.send_json({"t": "ack", "mailbox": mbs[0], "ids": ["msg-00000001"]})
        sink.send_json({"t": "ping"})
        assert sink.receive_json() == {"t": "pong"}
        bot.send_json({"t": "send", "id": "msg-00000002", "to": [mbs[3]], "payload": "x"})
        assert sink.receive_json()["t"] == "msg"
        assert bot.receive_json() == {"t": "sent", "id": "msg-00000002", "failed": []}

        # Чужой ack (ящик не его) ничего не возвращает
        bot.send_json({"t": "ack", "mailbox": mbs[1], "ids": ["msg-00000001"]})
        bot.send_json({"t": "send", "id": "msg-00000003", "to": [mbs[0]], "payload": "x"})
        assert bot.receive_json()["failed"] == [{"to": mbs[0], "reason": "quota"}]


def test_no_per_ip_quota_without_client_address(tmp_path):
    # nginx не передал адрес — все «с 127.0.0.1»; делить одну квоту на всех нельзя
    with per_ip_client(tmp_path, "127.0.0.1", queue_bytes_per_ip=1024) as client, contextlib.ExitStack() as st:
        client.stack = st
        bot, _ = connect(client)
        mb = mailbox()
        bot.send_json({"t": "register", "mailbox": mb})
        bot.receive_json()
        for i in range(3):
            bot.send_json({"t": "send", "id": f"msg-0000000{i}", "to": [mb], "payload": "x"})
            assert bot.receive_json()["t"] == "msg"
            assert bot.receive_json()["failed"] == []


# --- файлы: место на адрес ----------------------------------------------------


def test_blob_ledger():
    led = BlobLedger(limit=1000)
    ip = "203.0.113.7"
    assert led.allows(ip, 1000) and not led.allows(ip, 1001)
    led.charge(ip, "f1", 600)
    assert not led.allows(ip, 401) and led.allows(ip, 400)
    led.charge(ip, "f1", 300)  # тот же id заново (истёк и загружен снова) — не вдвойне
    assert led.used[ip] == 300
    led.release("f1")
    led.release("f1")
    assert led.used == {} and led.allows(None, 10**9)


def test_blob_quota_per_ip(tmp_path):
    kw = dict(
        max_blob_bytes=1000, blob_quota_per_owner=10_000, blob_quota_total=10_000, blob_quota_per_ip=1500, blob_min_cost=1
    )
    with per_ip_client(tmp_path, "203.0.113.7", **kw) as client:

        def put(bid, size, key=None):
            key = key or Ed25519PrivateKey.generate()  # ключи бесплатны — бот берёт новый на каждый файл
            return client.put(f"/blob/{bid}?n=1", content=b"x" * size, headers=auth(key, bid, size))

        f1, f2, f3 = blob_id(), blob_id(), blob_id()
        assert put(f1, 1000).status_code == 201
        assert put(f2, 600).status_code == 507  # 1000 + 600 > 1500 с этого адреса
        assert put(f2, 500).status_code == 201

        # Скачали — место освободилось
        assert client.post(f"/blob/{f1}/done").status_code == 204
        assert put(f3, 1000).status_code == 201


def test_blob_min_cost(tmp_path):
    s = Store(str(tmp_path / "b.sqlite3"))
    args = dict(upload_timeout=10, quota_owner=10_000, quota_total=10_000, now=1000, min_cost=4096)
    assert s.blob_reserve("a" * 22, "o", 1, 1, **args) == "ok"
    assert s.blob_reserve("b" * 22, "o", 1, 1, **args) == "ok"
    assert s.blob_reserve("c" * 22, "o", 1, 1, **args) == "quota"  # 3 × 4 КиБ > 10 000
