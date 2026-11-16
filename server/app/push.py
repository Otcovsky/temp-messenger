"""Пуш-уведомления (Web Push, RFC 8030 + VAPID, RFC 8292) без содержимого.

Сервер шлёт пуш-сервису браузера (Google, Apple, Mozilla, Microsoft) пустой запрос: «разбуди
приложение». В нём нет ни текста, ни отправителя, ни номера ящика — пуш-сервис узнаёт только
время. Раз тела нет, шифровать нечего, и от подписки нужен один адрес (endpoint).

Пуш уходит, только если сообщение не забрали: получатель не в сети — почти сразу, в сети —
через несколько секунд, если так и не пришёл ack (соединение могло «уснуть» вместе с телефоном).
"""

import asyncio
import base64
import json
import logging
import time
import urllib.error
import urllib.request
from typing import Callable
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

from .config import Settings
from .store import Store

log = logging.getLogger("temp_messenger.push")

VAPID_META_KEY = "vapid_private"
JWT_LIFETIME_SEC = 12 * 3600  # пуш-сервисы принимают не больше 24 часов
MAX_ENDPOINT_LEN = 1024

# (endpoint, заголовок Authorization, TTL в секундах) -> HTTP-статус
PushSend = Callable[[str, str, int], int]


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


class Vapid:
    """Ключ сервера приложения (P-256). Создаётся при первом запуске и хранится в базе."""

    def __init__(self, store: Store, subject: str):
        self.subject = subject
        pem = store.meta_get(VAPID_META_KEY)
        if pem is None:
            key = ec.generate_private_key(ec.SECP256R1())
            pem = key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ).decode()
            store.meta_set(VAPID_META_KEY, pem)
        self.key = serialization.load_pem_private_key(pem.encode(), password=None)
        self.public = _b64(
            self.key.public_key().public_bytes(
                serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
            )
        )
        self._tokens: dict[str, tuple[int, str]] = {}  # audience -> (годен до, JWT)

    def authorization(self, endpoint: str, now: int | None = None) -> str:
        now = now or int(time.time())
        u = urlsplit(endpoint)
        aud = f"{u.scheme}://{u.netloc}"
        cached = self._tokens.get(aud)
        if cached is None or cached[0] - now < 3600:
            exp = now + JWT_LIFETIME_SEC
            head = _b64(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
            body = _b64(
                json.dumps({"aud": aud, "exp": exp, "sub": self.subject}, separators=(",", ":")).encode()
            )
            r, s = decode_dss_signature(self.key.sign(f"{head}.{body}".encode(), ec.ECDSA(hashes.SHA256())))
            sig = _b64(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
            cached = (exp, f"{head}.{body}.{sig}")
            self._tokens[aud] = cached
        return f"vapid t={cached[1]}, k={self.public}"


def endpoint_allowed(endpoint, hosts: tuple[str, ...]) -> bool:
    """Адрес подписки присылает клиент, а запрос по нему делает сервер. Чтобы сервер нельзя было
    заставить ходить куда угодно, принимаются только HTTPS-адреса известных пуш-сервисов."""
    if not isinstance(endpoint, str) or not 0 < len(endpoint) <= MAX_ENDPOINT_LEN:
        return False
    try:
        u = urlsplit(endpoint)
        host, port = u.hostname, u.port
    except ValueError:
        return False
    if u.scheme != "https" or not host or port not in (None, 443) or u.username or u.password:
        return False
    return any(host == h or host.endswith("." + h) for h in hosts)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # перенаправление увело бы запрос мимо списка разрешённых адресов


_opener = urllib.request.build_opener(_NoRedirect)


def http_send(endpoint: str, authorization: str, ttl: int) -> int:
    """Пустой пуш. Блокирующий вызов — запускать в отдельном потоке."""
    req = urllib.request.Request(
        endpoint,
        data=b"",
        method="POST",
        headers={
            "Authorization": authorization,
            "TTL": str(ttl),
            "Urgency": "high",  # иначе спящий телефон покажет уведомление с задержкой
            "Topic": "tm",  # недоставленные пуши одной подписки заменяют друг друга
            "Content-Length": "0",
        },
    )
    try:
        with _opener.open(req, timeout=10) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code


class Pusher:
    def __init__(self, store: Store, cfg: Settings, send: PushSend | None = None):
        self.store = store
        self.cfg = cfg
        self.send = send or http_send
        self.vapid = Vapid(store, cfg.push_subject) if cfg.push_subject else None
        # Владелец ящиков -> сообщения, за которыми следим. Пока запись есть, пуш уже запланирован,
        # так что пачка сообщений даёт одно уведомление.
        self.pending: dict[str, set[tuple[str, str]]] = {}
        self.tasks: set[asyncio.Task] = set()

    @property
    def enabled(self) -> bool:
        return self.vapid is not None

    @property
    def public_key(self) -> str | None:
        return self.vapid.public if self.vapid else None

    def notify(self, mailbox: str, msg_id: str, online: bool) -> None:
        """Сообщение легло в очередь ящика. online — у ящика есть открытое соединение."""
        if not self.enabled:
            return
        owner = self.store.mailbox_owner(mailbox)
        if owner is None or self.store.push_get(owner) is None:
            return
        watched = self.pending.get(owner)
        if watched is not None:
            watched.add((mailbox, msg_id))
            return
        self.pending[owner] = {(mailbox, msg_id)}
        delay = self.cfg.push_delay_sec if online else self.cfg.push_offline_delay_sec
        task = asyncio.create_task(self._run(owner, delay, online))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def _run(self, owner: str, delay: float, online: bool) -> None:
        started = time.monotonic()
        try:
            await asyncio.sleep(delay)
        finally:
            watched = self.pending.pop(owner, set())
        if not any(self.store.has_message(mb, msg_id) for mb, msg_id in watched):
            return  # всё уже забрали — человек в приложении
        status = await self.deliver(owner)
        # Сколько прошло от прихода сообщения до ответа пуш-сервиса — чтобы искать задержки
        log.info(
            "push for a %s recipient took %.1fs (HTTP %s)",
            "connected" if online else "disconnected", time.monotonic() - started, status,
        )

    async def deliver(self, owner: str) -> int | None:
        """Послать пуш владельцу сейчас. Возвращает HTTP-статус пуш-сервиса,
        0 — до него не достучались, None — подписки нет."""
        endpoint = self.store.push_get(owner)
        if endpoint is None or self.vapid is None:
            return None
        host = urlsplit(endpoint).hostname
        try:
            status = await asyncio.to_thread(
                self.send, endpoint, self.vapid.authorization(endpoint), self.cfg.push_ttl_sec
            )
        except Exception as e:
            log.warning("push to %s failed: %s", host, type(e).__name__)
            return 0
        # В журнале — только пуш-сервис и его ответ: по ним не понять, кому был пуш
        if status in (404, 410):  # подписки больше нет: её отозвали или приложение удалили
            self.store.push_delete(owner, endpoint)
            log.info("push via %s: HTTP %d, subscription removed", host, status)
        elif status >= 400:
            log.warning("push rejected by %s: HTTP %d", host, status)
        else:
            log.info("push via %s: HTTP %d", host, status)
        return status

    async def close(self) -> None:
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
