"""Квоты на адрес клиента.

Ключ доступа бесплатен — новый создаётся за миллисекунду, поэтому квоты «на ключ» бота не держат.
Адрес стоит денег, поэтому то, что бот может копить на диске сервера (очередь сообщений и файлы),
дополнительно ограничено по адресу.

Адреса живут только в памяти процесса: на диск и в журнал не пишутся, после перезапуска счёт
начинается заново. IPv6 считается по сети /64 — столько обычно выдают одному абоненту.
Адрес приходит от nginx (X-Forwarded-For, его разбирает uvicorn). Если запрос пришёл с локального
адреса — nginx адрес не передал или это разработка, — квота не применяется: иначе все люди
делили бы одну квоту на всех.
"""

import ipaddress
import time
from collections import OrderedDict


def ip_key(host: str | None) -> str | None:
    """Ключ квоты для адреса клиента или None — не ограничивать."""
    try:
        ip = ipaddress.ip_address(host or "")
    except ValueError:
        return None
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    if ip.is_loopback or ip.is_unspecified:
        return None
    if isinstance(ip, ipaddress.IPv6Address):
        return str(ipaddress.IPv6Network((ip, 64), strict=False))
    return str(ip)


class SendBudget:
    """Сколько байт очереди может занять отправитель с одного адреса.

    Ведро на адрес: полное — `capacity` байт, пополняется на `capacity` за `refill_sec` (срок жизни
    сообщения). Каждое сообщение, положенное в очередь, списывает свою стоимость. Если получатель
    подтвердил его (ack) в течение `refund_window_sec`, стоимость возвращается: сообщение уже стёрто
    с диска. Поэтому живая переписка ведро почти не тратит, а то, что лежит и ждёт, — тратит.
    Бот, который шлёт себе и не подтверждает, держит на сервере не больше `capacity` плюс
    пополнение за срок жизни, то есть ~2 × `capacity` с адреса.
    """

    def __init__(self, capacity: int, refill_sec: float, refund_window_sec: float, max_tracked: int = 1_000_000):
        self.capacity = capacity
        self.rate = capacity / refill_sec
        self.refund_window = refund_window_sec
        self.max_tracked = max_tracked
        self.buckets: dict[str, tuple[float, float]] = {}  # ip → (байт в ведре, когда пересчитано)
        # (ящик, id) → (ip, стоимость, когда положено); по порядку добавления, старые — первыми
        self.recent: OrderedDict[tuple[str, str], tuple[str, int, float]] = OrderedDict()

    def _level(self, ip: str, now: float) -> float:
        tokens, last = self.buckets.get(ip, (self.capacity, now))
        return min(self.capacity, tokens + (now - last) * self.rate)

    def allows(self, ip: str | None, cost: int, now: float | None = None) -> bool:
        if ip is None:
            return True
        return self._level(ip, time.monotonic() if now is None else now) >= cost

    def charge(self, ip: str | None, key: tuple[str, str], cost: int, now: float | None = None) -> None:
        if ip is None:
            return
        now = time.monotonic() if now is None else now
        self.buckets[ip] = (self._level(ip, now) - cost, now)
        self.recent.pop(key, None)
        self.recent[key] = (ip, cost, now)
        self._expire(now)

    def refund(self, key: tuple[str, str], now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        self._expire(now)
        entry = self.recent.pop(key, None)
        if entry is None:
            return
        ip, cost, _ = entry
        if ip in self.buckets:
            self.buckets[ip] = (min(self.capacity, self._level(ip, now) + cost), now)

    def _expire(self, now: float) -> None:
        while self.recent:
            key, (_, _, t) = next(iter(self.recent.items()))
            if now - t < self.refund_window and len(self.recent) <= self.max_tracked:
                break
            del self.recent[key]

    def prune(self, now: float | None = None) -> None:
        """Забыть адреса с полным ведром — для них запись ничего не меняет."""
        now = time.monotonic() if now is None else now
        self._expire(now)
        for ip in [ip for ip in self.buckets if self._level(ip, now) >= self.capacity]:
            del self.buckets[ip]


class BlobLedger:
    """Сколько места занимают файлы, загруженные с одного адреса, пока они лежат на сервере.

    Файл учитывается с загрузки до удаления (скачали все получатели, загрузка брошена или истёк
    срок). После перезапуска файлы, загруженные раньше, ни на кого не записаны.
    """

    def __init__(self, limit: int):
        self.limit = limit
        self.owner: dict[str, tuple[str, int]] = {}  # id файла → (ip, байт)
        self.used: dict[str, int] = {}  # ip → байт

    def allows(self, ip: str | None, cost: int) -> bool:
        return ip is None or self.used.get(ip, 0) + cost <= self.limit

    def charge(self, ip: str | None, blob_id: str, cost: int) -> None:
        self.release(blob_id)
        if ip is None:
            return
        self.owner[blob_id] = (ip, cost)
        self.used[ip] = self.used.get(ip, 0) + cost

    def release(self, blob_id: str) -> None:
        entry = self.owner.pop(blob_id, None)
        if entry is None:
            return
        ip, cost = entry
        left = self.used.get(ip, 0) - cost
        if left > 0:
            self.used[ip] = left
        else:
            self.used.pop(ip, None)
