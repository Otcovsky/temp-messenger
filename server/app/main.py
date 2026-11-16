"""Ретранслятор одноразового мессенджера.

Протокол — JSON-кадры по WebSocket (/ws). Подробно описан в docs/protocol.md.

  ← challenge {nonce}
  → auth {pub, sig}            подпись Ed25519 над b"tm-auth-v1:" + nonce
  ← ready {push?}              push — ключ VAPID, если сервер умеет слать пуш-уведомления
  → register {mailbox, invite?} ← registered {mailbox}, затем msg ... из очереди
  → probe {mailbox}            ← probe {mailbox, state: open|used|none}
  → unregister {mailbox}       ← unregistered {mailbox}
  → send {id, to:[...], payload, notify?}  ← sent {id, failed:[{to, reason}]}
  → push-sub {endpoint}        ← push-sub {ok: true}
  → push-unsub                 ← push-unsub {ok: true}
  → push-test                  ← push-test {status}   пробный пуш себе; status — ответ пуш-сервиса
  ← msg {id, mailbox, payload, ts}
  → ack {mailbox, ids:[...]}
  → ping                       ← pong

Файлы — обычным HTTP, см. blobs.py.
"""

import asyncio
import base64
import contextlib
import logging
import os
import re
import time
from collections import defaultdict
from contextlib import asynccontextmanager

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .blobs import BlobFiles, add_blob_routes, cleanup_blobs
from .config import Settings, settings as default_settings
from .push import Pusher, PushSend, endpoint_allowed
from .store import RegisterResult, Store

log = logging.getLogger("temp_messenger")

AUTH_CONTEXT = b"tm-auth-v1:"
MAILBOX_RE = re.compile(r"^[A-Za-z0-9_-]{22}$")  # 16 байт в base64url
MSG_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
MAX_ACK_IDS = 500


def b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def b64url_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


class ProtocolError(Exception):
    def __init__(self, code: str, ref: str | None = None):
        super().__init__(code)
        self.code = code
        self.ref = ref


class TokenBucket:
    def __init__(self, rate: float, burst: int):
        self.rate, self.burst = rate, burst
        self.tokens = float(burst)
        self.last = time.monotonic()

    def take(self) -> bool:
        now = time.monotonic()
        self.tokens = min(self.burst, self.tokens + (now - self.last) * self.rate)
        self.last = now
        if self.tokens >= 1:
            self.tokens -= 1
            return True
        return False


class Connection:
    def __init__(self, ws: WebSocket, owner: str, cfg: Settings):
        self.ws = ws
        self.owner = owner
        self.mailboxes: set[str] = set()
        self.bucket = TokenBucket(cfg.rate_per_sec, cfg.rate_burst)
        self.send_lock = asyncio.Lock()

    async def send(self, frame: dict) -> None:
        async with self.send_lock:
            await self.ws.send_json(frame)


class Hub:
    """Кто сейчас онлайн и слушает какой ящик."""

    def __init__(self):
        self.subs: dict[str, set[Connection]] = defaultdict(set)

    def add(self, mailbox: str, conn: Connection) -> None:
        self.subs[mailbox].add(conn)

    def remove(self, mailbox: str, conn: Connection) -> None:
        conns = self.subs.get(mailbox)
        if conns:
            conns.discard(conn)
            if not conns:
                del self.subs[mailbox]

    def drop(self, conn: Connection) -> None:
        for mb in list(conn.mailboxes):
            self.remove(mb, conn)

    async def push(self, mailbox: str, frame: dict) -> None:
        for conn in list(self.subs.get(mailbox, ())):
            try:
                await conn.send(frame)
            except Exception:  # соединение умирает — сообщение останется в очереди
                pass


def read_version(path: str) -> str:
    """Хеш коммита, записанный deploy.sh; при локальном запуске файла нет — "dev"."""
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip() or "dev"
    except OSError:
        return "dev"


def create_app(cfg: Settings = default_settings, push_send: PushSend | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.store = Store(cfg.db_path)
        app.state.blobs = BlobFiles(cfg.blob_dir)
        app.state.hub = Hub()
        app.state.pusher = Pusher(app.state.store, cfg, push_send)
        task = asyncio.create_task(cleanup_loop(app.state.store, app.state.blobs))
        try:
            yield
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            await app.state.pusher.close()
            app.state.store.close()

    async def cleanup_loop(store: Store, blobs: BlobFiles) -> None:
        while True:
            try:
                msgs, boxes = store.cleanup(cfg.mailbox_idle_ttl_sec)
                files = cleanup_blobs(store, blobs)
                if msgs or boxes or files:
                    log.info("cleanup: %d messages, %d mailboxes, %d files", msgs, boxes, files)
            except Exception:
                log.exception("cleanup failed")
            await asyncio.sleep(cfg.cleanup_interval_sec)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    version = read_version(cfg.version_file)

    @app.get("/health")
    async def health():
        return {"ok": True, "version": version}

    add_blob_routes(app, cfg)

    async def authenticate(ws: WebSocket) -> str:
        nonce = os.urandom(32)
        await ws.send_json({"t": "challenge", "nonce": b64url_encode(nonce)})
        frame = await asyncio.wait_for(ws.receive_json(), cfg.auth_timeout_sec)
        if not isinstance(frame, dict) or frame.get("t") != "auth":
            raise ProtocolError("auth_required")
        try:
            pub_raw = b64url_decode(str(frame["pub"]))
            sig = b64url_decode(str(frame["sig"]))
            Ed25519PublicKey.from_public_bytes(pub_raw).verify(sig, AUTH_CONTEXT + nonce)
        except (KeyError, ValueError, InvalidSignature):
            raise ProtocolError("auth_failed")
        return b64url_encode(pub_raw)

    @app.websocket("/ws")
    async def websocket_endpoint(ws: WebSocket):
        store: Store = app.state.store
        hub: Hub = app.state.hub
        await ws.accept()
        try:
            owner = await authenticate(ws)
        except (ProtocolError, asyncio.TimeoutError, WebSocketDisconnect, ValueError) as e:
            code = e.code if isinstance(e, ProtocolError) else "auth_failed"
            with contextlib.suppress(Exception):
                await ws.send_json({"t": "error", "code": code})
                await ws.close(code=4001)
            return

        pusher: Pusher = app.state.pusher
        conn = Connection(ws, owner, cfg)
        await conn.send({"t": "ready", "push": pusher.public_key} if pusher.enabled else {"t": "ready"})
        try:
            while True:
                try:
                    frame = await ws.receive_json()
                except ValueError:
                    await conn.send({"t": "error", "code": "bad_json"})
                    continue
                if not conn.bucket.take():
                    await conn.send({"t": "error", "code": "rate_limited", "ref": _ref(frame)})
                    continue
                try:
                    await handle(conn, frame, store, hub, pusher)
                except ProtocolError as e:
                    await conn.send({"t": "error", "code": e.code, "ref": e.ref})
        except WebSocketDisconnect:
            pass
        finally:
            hub.drop(conn)

    async def handle(conn: Connection, frame: dict, store: Store, hub: Hub, pusher: Pusher) -> None:
        if not isinstance(frame, dict):
            raise ProtocolError("bad_frame")
        t = frame.get("t")

        if t == "ping":
            await conn.send({"t": "pong"})

        elif t == "register":
            mb = _mailbox(frame.get("mailbox"))
            if mb not in conn.mailboxes and len(conn.mailboxes) >= cfg.max_mailboxes_per_conn:
                raise ProtocolError("too_many_mailboxes", mb)
            invite = frame.get("invite")
            if invite is not None and not isinstance(invite, bool):
                raise ProtocolError("bad_frame", mb)
            res = store.register(mb, conn.owner, invite=invite)
            if res == RegisterResult.FORBIDDEN:
                raise ProtocolError("forbidden", mb)
            conn.mailboxes.add(mb)
            hub.add(mb, conn)
            await conn.send({"t": "registered", "mailbox": mb, "created": res == RegisterResult.CREATED})
            for m in store.pending(mb, cfg.max_queue_per_mailbox):
                await conn.send(
                    {"t": "msg", "id": m.id, "mailbox": mb, "payload": m.payload, "ts": m.created_at}
                )

        elif t == "probe":
            # Живо ли приглашение: чтобы не создавать чат по отозванной или уже принятой ссылке.
            # ID ящика случаен (128 бит), так что узнать что-то можно, только зная саму ссылку.
            mb = _mailbox(frame.get("mailbox"))
            await conn.send({"t": "probe", "mailbox": mb, "state": store.invite_state(mb)})

        elif t == "unregister":
            mb = _mailbox(frame.get("mailbox"))
            store.unregister(mb, conn.owner)
            conn.mailboxes.discard(mb)
            hub.remove(mb, conn)
            await conn.send({"t": "unregistered", "mailbox": mb})

        elif t == "send":
            msg_id = frame.get("id")
            if not isinstance(msg_id, str) or not MSG_ID_RE.match(msg_id):
                raise ProtocolError("bad_id")
            to = frame.get("to")
            if not isinstance(to, list) or not 1 <= len(to) <= cfg.max_recipients:
                raise ProtocolError("bad_recipients", msg_id)
            payload = frame.get("payload")
            if not isinstance(payload, str) or len(payload.encode()) > cfg.max_payload_bytes:
                raise ProtocolError("bad_payload", msg_id)
            # notify: true — сообщение стоит уведомления (не квитанция и не служебное).
            notify = frame.get("notify") is True

            now = int(time.time())
            failed = []
            for raw in dict.fromkeys(to):  # без дублей, порядок сохраняется
                if not isinstance(raw, str) or not MAILBOX_RE.match(raw):
                    failed.append({"to": raw, "reason": "bad_mailbox"})
                    continue
                res = store.enqueue(raw, msg_id, payload, cfg.message_ttl_sec, cfg.max_queue_per_mailbox, now)
                if res == "stored":
                    online = bool(hub.subs.get(raw))
                    await hub.push(raw, {"t": "msg", "id": msg_id, "mailbox": raw, "payload": payload, "ts": now})
                    if notify:
                        pusher.notify(raw, msg_id, online)
                elif res != "duplicate":
                    failed.append({"to": raw, "reason": res})
            await conn.send({"t": "sent", "id": msg_id, "failed": failed})

        elif t == "ack":
            mb = _mailbox(frame.get("mailbox"))
            ids = frame.get("ids")
            if not isinstance(ids, list) or len(ids) > MAX_ACK_IDS or not all(isinstance(i, str) for i in ids):
                raise ProtocolError("bad_ack", mb)
            store.ack(mb, conn.owner, ids)

        elif t == "push-sub":
            if not pusher.enabled:
                raise ProtocolError("push_disabled")
            endpoint = frame.get("endpoint")
            if not endpoint_allowed(endpoint, cfg.push_hosts):
                raise ProtocolError("bad_endpoint")
            store.push_set(conn.owner, endpoint)
            await conn.send({"t": "push-sub", "ok": True})

        elif t == "push-unsub":
            store.push_delete(conn.owner)
            await conn.send({"t": "push-unsub", "ok": True})

        elif t == "push-test":
            # Пробный пуш самому себе: клиент показывает ответ пуш-сервиса, чтобы было видно,
            # на каком шаге теряются уведомления.
            status = await pusher.deliver(conn.owner)
            if status is None:
                raise ProtocolError("no_subscription")
            await conn.send({"t": "push-test", "status": status})

        else:
            raise ProtocolError("unknown_type")

    return app


def _mailbox(value) -> str:
    if not isinstance(value, str) or not MAILBOX_RE.match(value):
        raise ProtocolError("bad_mailbox")
    return value


def _ref(frame) -> str | None:
    """К чему относится ошибка: id сообщения (send) или ящик (register, probe, ...)."""
    if not isinstance(frame, dict):
        return None
    for key in ("id", "mailbox"):
        if isinstance(frame.get(key), str):
            return frame[key]
    return None


logging.basicConfig(level=logging.INFO)
app = create_app()
