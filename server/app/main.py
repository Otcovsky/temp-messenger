"""Ретранслятор одноразового мессенджера.

Протокол — JSON-кадры по WebSocket (/ws). Подробно описан в docs/protocol.md.

  ← challenge {nonce}
  → auth {pub, sig}            подпись Ed25519 над b"tm-auth-v1:" + nonce
  ← ready {push?, fcm?}        push — ключ VAPID, если сервер умеет слать пуш-уведомления;
                               fcm: true — умеет слать их Android-приложению через Firebase
  → register {mailbox, invite?} ← registered {mailbox}, затем msg ... из очереди
  → probe {mailbox}            ← probe {mailbox, state: open|used|none}
  → unregister {mailbox}       ← unregistered {mailbox}
  → send {id, to:[...], payload, notify?, ttl?}  ← sent {id, failed:[{to, reason}]}
  → push-sub {endpoint, p256dh?, auth?}  ← push-sub {ok: true}
  → push-sub {fcm, key}        то же из Android-приложения: токен FCM и ключ AES-256 (base64url)
  → push-unsub                 ← push-unsub {ok: true}
  → push-test {kind?}          ← push-test {status}   пробный пуш себе; status — ответ пуш-сервиса
  → ice                        ← ice {servers, ttl}   STUN/TURN для звонка с временным логином
  ← msg {id, mailbox, payload, ts}
  → ack {mailbox, ids:[...]}
  → ping                       ← pong

Файлы — обычным HTTP, см. blobs.py.
"""

import asyncio
import base64
import contextlib
import hashlib
import hmac
import logging
import os
import re
import time
from collections import defaultdict
from contextlib import asynccontextmanager

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .blobs import BlobFiles, add_blob_routes, cleanup_blobs
from .config import Settings, settings as default_settings
from .fcm import FCM_PREFIX, FcmSend, key_valid, token_valid
from .push import KINDS, Pusher, PushSend, endpoint_allowed, keys_valid
from .quota import BlobLedger, SendBudget, ip_key
from .store import RegisterResult, Store, message_cost

log = logging.getLogger("temp_messenger")

AUTH_CONTEXT = b"tm-auth-v1:"
MAILBOX_RE = re.compile(r"^[A-Za-z0-9_-]{22}$")  # 16 байт в base64url
MSG_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
MAX_ACK_IDS = 500


def b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def b64url_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def ice_servers(cfg: Settings, now: int | None = None) -> list[dict]:
    """Список для RTCPeerConnection. Логин TURN временный (схема REST API coturn): имя — время,
    до которого он годен, пароль — HMAC-SHA1 от имени на общем с coturn секрете. Сам секрет
    клиенту не уходит, а просроченный логин coturn не примет."""
    if not cfg.ice_urls:
        return []
    stun = [u for u in cfg.ice_urls if u.startswith(("stun:", "stuns:"))]
    turn = [u for u in cfg.ice_urls if u.startswith(("turn:", "turns:"))]
    servers: list[dict] = []
    if stun:
        servers.append({"urls": stun})
    if turn and cfg.turn_secret:
        username = str((now or int(time.time())) + cfg.turn_ttl_sec)
        digest = hmac.new(cfg.turn_secret.encode(), username.encode(), hashlib.sha1).digest()
        servers.append({"urls": turn, "username": username, "credential": base64.b64encode(digest).decode()})
    return servers


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
        self.ip = ip_key(ws.client.host if ws.client else None)  # только для квот, нигде не пишется
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


def create_app(
    cfg: Settings = default_settings, push_send: PushSend | None = None, fcm_send: FcmSend | None = None
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.store = Store(cfg.db_path)
        app.state.blobs = BlobFiles(cfg.blob_dir)
        app.state.hub = Hub()
        app.state.pusher = Pusher(app.state.store, cfg, push_send, fcm_send)
        app.state.send_budget = SendBudget(cfg.queue_bytes_per_ip, cfg.message_ttl_sec, cfg.queue_refund_window_sec)
        app.state.blob_ledger = BlobLedger(cfg.blob_quota_per_ip)
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
                files = cleanup_blobs(store, blobs, app.state.blob_ledger)
                app.state.send_budget.prune()
                if msgs or boxes or files:
                    log.info("cleanup: %d messages, %d mailboxes, %d files", msgs, boxes, files)
            except Exception:
                log.exception("cleanup failed")
            await asyncio.sleep(cfg.cleanup_interval_sec)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    version = read_version(cfg.version_file)
    if cfg.app_origins:
        # Файлы приложение качает по fetch с https://localhost — браузерный движок требует разрешения.
        # Куки и прочие учётные данные не участвуют: доступ к файлам — по подписи в X-TM-Auth.
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(cfg.app_origins),
            allow_methods=["GET", "PUT", "POST"],
            allow_headers=["X-TM-Auth", "Content-Type"],
            max_age=86400,
        )

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
        ready: dict = {"t": "ready"}
        if pusher.public_key:
            ready["push"] = pusher.public_key
        if pusher.fcm_enabled:
            ready["fcm"] = True
        await conn.send(ready)
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

    last_full_warning: float | None = None

    def warn_server_full() -> None:
        # Очередь упёрлась в потолок — скорее всего, кто-то её забивает. В журнал не чаще раза в минуту.
        nonlocal last_full_warning
        if last_full_warning is None or time.monotonic() - last_full_warning >= 60:
            last_full_warning = time.monotonic()
            log.warning(
                "message queue is full (%d bytes, limit TM_MAX_QUEUE_BYTES_TOTAL=%d): new messages are refused",
                app.state.store.queue_bytes(),
                cfg.max_queue_bytes_total,
            )

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
            # notify — сообщение стоит уведомления (не квитанция и не служебное): true — обычное,
            # "call" — приглашение к звонку, "call-end" — звонок закончился без ответа.
            notify = frame.get("notify")
            if not isinstance(notify, (bool, str)) or notify not in KINDS:
                notify = None
            # ttl — сколько секунд хранить, если получатель не в сети (сигналы звонка живут секунды)
            ttl = frame.get("ttl", cfg.message_ttl_sec)
            if not isinstance(ttl, int) or isinstance(ttl, bool) or ttl < 1:
                raise ProtocolError("bad_ttl", msg_id)
            ttl = min(ttl, cfg.message_ttl_sec)

            now = int(time.time())
            budget: SendBudget = app.state.send_budget
            cost = message_cost(len(payload.encode()))
            failed = []
            for raw in dict.fromkeys(to):  # без дублей, порядок сохраняется
                if not isinstance(raw, str) or not MAILBOX_RE.match(raw):
                    failed.append({"to": raw, "reason": "bad_mailbox"})
                    continue
                if not budget.allows(conn.ip, cost):
                    failed.append({"to": raw, "reason": "quota"})
                    continue
                res = store.enqueue(
                    raw, msg_id, payload, ttl, cfg.max_queue_per_mailbox, now, cfg.max_queue_bytes_total
                )
                if res == "server_full":
                    warn_server_full()
                if res == "stored":
                    budget.charge(conn.ip, (raw, msg_id), cost)
                    online = bool(hub.subs.get(raw))
                    await hub.push(raw, {"t": "msg", "id": msg_id, "mailbox": raw, "payload": payload, "ts": now})
                    if notify:
                        pusher.notify(raw, msg_id, online, notify)
                elif res != "duplicate":
                    failed.append({"to": raw, "reason": res})
            await conn.send({"t": "sent", "id": msg_id, "failed": failed})

        elif t == "ack":
            mb = _mailbox(frame.get("mailbox"))
            ids = frame.get("ids")
            if not isinstance(ids, list) or len(ids) > MAX_ACK_IDS or not all(isinstance(i, str) for i in ids):
                raise ProtocolError("bad_ack", mb)
            if store.ack(mb, conn.owner, ids):
                # Сообщения стёрты с диска — отправителю возвращается их стоимость (если ack быстрый)
                for i in ids:
                    app.state.send_budget.refund((mb, i))

        elif t == "push-sub" and "fcm" in frame:
            # Android-приложение: токен FCM и ключ, которым шифруется пометка в пуше
            if not pusher.fcm_enabled:
                raise ProtocolError("push_disabled")
            token, key = frame.get("fcm"), frame.get("key")
            if not token_valid(token):
                raise ProtocolError("bad_endpoint")
            if not key_valid(key):
                raise ProtocolError("bad_keys")
            store.push_set(conn.owner, FCM_PREFIX + token, None, key)
            await conn.send({"t": "push-sub", "ok": True})

        elif t == "push-sub":
            if pusher.vapid is None:
                raise ProtocolError("push_disabled")
            endpoint = frame.get("endpoint")
            if not endpoint_allowed(endpoint, cfg.push_hosts):
                raise ProtocolError("bad_endpoint")
            p256dh, auth = frame.get("p256dh"), frame.get("auth")
            if p256dh is None and auth is None:
                store.push_set(conn.owner, endpoint)  # клиент прежней версии: пуши будут пустыми
            elif keys_valid(p256dh, auth):
                store.push_set(conn.owner, endpoint, p256dh, auth)
            else:
                raise ProtocolError("bad_keys")
            await conn.send({"t": "push-sub", "ok": True})

        elif t == "push-unsub":
            store.push_delete(conn.owner)
            await conn.send({"t": "push-unsub", "ok": True})

        elif t == "ice":
            # Логин TURN получает только тот, у кого есть хотя бы один ящик: чужим ретранслятор
            # трафика не раздаём (а расход ограничен ещё и квотами самого coturn).
            servers = ice_servers(cfg) if store.has_mailboxes(conn.owner) else []
            await conn.send({"t": "ice", "servers": servers, "ttl": cfg.turn_ttl_sec})

        elif t == "push-test":
            # Пробный пуш самому себе: клиент показывает ответ пуш-сервиса, чтобы было видно,
            # на каком шаге теряются уведомления.
            kind = frame.get("kind", True)
            if not isinstance(kind, (bool, str)) or kind not in KINDS:
                raise ProtocolError("bad_kind")
            status = await pusher.deliver(conn.owner, kind)
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
