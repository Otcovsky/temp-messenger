"""Нагрузочный тест ретранслятора Temp Messenger.

k6 не умеет Ed25519, а без него не пройти авторизацию на /ws, поэтому тест на Python.

Режим chat: N клиентов, разбитых на пары. Каждый подключается к /ws, проходит авторизацию,
регистрирует свой ящик и шлёт собеседнику сообщения со средней частотой --rate в секунду.
Меряем: подключение+авторизацию, ответ сервера на send (sent), доставку до получателя (msg).
В конце каждый клиент снимает свой ящик (unregister), на сервере ничего не остаётся.

Режим blob: --workers параллельных циклов «загрузить → скачать → done». Файл стирается
сервером после done (n=1).

Тест сам останавливается, если сервер явно не справляется (см. --abort-*).
"""

import argparse
import asyncio
import base64
import json
import os
import random
import ssl
import statistics
import sys
import time
from collections import Counter

import aiohttp
import websockets
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def b64u_dec(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def pct(values, p):
    if not values:
        return None
    v = sorted(values)
    return round(v[min(len(v) - 1, int(len(v) * p))] * 1000, 1)


def summary(values):
    if not values:
        return {"n": 0}
    return {
        "n": len(values),
        "p50_ms": pct(values, 0.50),
        "p95_ms": pct(values, 0.95),
        "p99_ms": pct(values, 0.99),
        "max_ms": round(max(values) * 1000, 1),
    }


class Stats:
    def __init__(self):
        self.connect = []          # подключение + авторизация + регистрация, сек
        self.sent_rtt = []         # send → sent
        self.deliver = []          # send → msg у получателя
        self.window_deliver = []   # то же за последнее окно прогресса
        self.counts = Counter()
        self.errors = Counter()
        self.sent_at = {}          # id → время отправки
        self.active = 0
        self.peak_active = 0


class Client:
    def __init__(self, idx, args, stats, stop):
        self.idx = idx
        self.args = args
        self.st = stats
        self.stop = stop
        self.key = Ed25519PrivateKey.generate()
        self.pub = b64u(self.key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw))
        self.mailbox = b64u(os.urandom(16))
        self.partner = None
        self.ws = None
        self.ready = asyncio.Event()
        self.pending_acks = []

    async def run(self, ssl_ctx):
        st = self.st
        t0 = time.monotonic()
        try:
            self.ws = await asyncio.wait_for(
                websockets.connect(self.args.url, ssl=ssl_ctx, max_size=2**20, open_timeout=20,
                                   ping_interval=None, user_agent_header="tm-loadtest"),
                timeout=25,
            )
        except websockets.exceptions.InvalidStatusCode as e:
            st.counts["connect_fail"] += 1
            st.errors[f"http_{e.status_code}"] += 1
            return
        except Exception as e:
            st.counts["connect_fail"] += 1
            st.errors[f"connect_{type(e).__name__}"] += 1
            return
        try:
            ch = json.loads(await asyncio.wait_for(self.ws.recv(), 20))
            sig = self.key.sign(b"tm-auth-v1:" + b64u_dec(ch["nonce"]))
            await self.ws.send(json.dumps({"t": "auth", "pub": self.pub, "sig": b64u(sig)}))
            r = json.loads(await asyncio.wait_for(self.ws.recv(), 20))
            if r.get("t") != "ready":
                raise RuntimeError(f"auth: {r}")
            await self.ws.send(json.dumps({"t": "register", "mailbox": self.mailbox, "invite": False}))
            r = json.loads(await asyncio.wait_for(self.ws.recv(), 20))
            if r.get("t") != "registered":
                raise RuntimeError(f"register: {r}")
        except Exception as e:
            st.counts["connect_fail"] += 1
            st.errors[f"handshake_{type(e).__name__}"] += 1
            await self.ws.close()
            return
        st.connect.append(time.monotonic() - t0)
        st.counts["connected"] += 1
        st.active += 1
        st.peak_active = max(st.peak_active, st.active)
        self.ready.set()
        reader = asyncio.create_task(self.reader())
        try:
            await self.sender()
        finally:
            st.active -= 1
            # Дать дойти последним сообщениям, затем убрать ящик с сервера.
            await asyncio.sleep(self.args.drain)
            reader.cancel()
            try:
                await self.flush_acks()
                await self.ws.send(json.dumps({"t": "unregister", "mailbox": self.mailbox}))
                st.counts["unregistered"] += 1
                await asyncio.sleep(0.2)
                await self.ws.close()
            except Exception:
                st.counts["cleanup_fail"] += 1

    async def flush_acks(self):
        if self.pending_acks:
            ids, self.pending_acks = self.pending_acks[:500], self.pending_acks[500:]
            await self.ws.send(json.dumps({"t": "ack", "mailbox": self.mailbox, "ids": ids}))

    async def reader(self):
        st = self.st
        try:
            async for raw in self.ws:
                f = json.loads(raw)
                t = f.get("t")
                now = time.monotonic()
                if t == "msg":
                    sent = st.sent_at.pop(f["id"], None)
                    if sent is not None:
                        d = now - sent
                        st.deliver.append(d)
                        st.window_deliver.append(d)
                    st.counts["delivered"] += 1
                    self.pending_acks.append(f["id"])
                    if len(self.pending_acks) >= 20:
                        await self.flush_acks()
                elif t == "sent":
                    t_send = self.sent_rtt_start.pop(f["id"], None) if hasattr(self, "sent_rtt_start") else None
                    if t_send is not None:
                        st.sent_rtt.append(now - t_send)
                    if f.get("failed"):
                        st.errors["send_failed_" + f["failed"][0].get("reason", "?")] += 1
                elif t == "error":
                    st.errors["frame_" + str(f.get("code"))] += 1
        except websockets.exceptions.ConnectionClosed as e:
            if not self.stop.is_set():
                st.counts["dropped"] += 1
                st.errors[f"closed_{e.code}"] += 1
        except asyncio.CancelledError:
            pass

    async def sender(self):
        st = self.st
        self.sent_rtt_start = {}
        await self.partner.ready.wait() if self.partner else None
        last_ack = time.monotonic()
        while not self.stop.is_set():
            # Пуассоновский поток: средний интервал 1/rate
            await asyncio.sleep(random.expovariate(self.args.rate))
            if self.stop.is_set() or self.ws.closed:
                break
            mid = b64u(os.urandom(12))
            payload = b64u(os.urandom(self.args.payload * 3 // 4))
            now = time.monotonic()
            st.sent_at[mid] = now
            self.sent_rtt_start[mid] = now
            try:
                await self.ws.send(json.dumps({"t": "send", "id": mid, "to": [self.partner.mailbox], "payload": payload}))
                st.counts["sent"] += 1
            except websockets.exceptions.ConnectionClosed:
                st.sent_at.pop(mid, None)
                break
            if now - last_ack > 1:
                last_ack = now
                try:
                    await self.flush_acks()
                except websockets.exceptions.ConnectionClosed:
                    break


async def progress(st, stop, args, t_start, log):
    last_sent = last_deliv = 0
    while not stop.is_set():
        await asyncio.sleep(5)
        el = time.monotonic() - t_start
        sent, deliv = st.counts["sent"], st.counts["delivered"]
        w = st.window_deliver
        st.window_deliver = []
        line = {
            "t": round(el),
            "active": st.active,
            "connected": st.counts["connected"],
            "connect_fail": st.counts["connect_fail"],
            "sent_per_s": round((sent - last_sent) / 5),
            "deliv_per_s": round((deliv - last_deliv) / 5),
            "deliv_p95_ms": pct(w, 0.95),
            "errors": sum(st.errors.values()),
        }
        last_sent, last_deliv = sent, deliv
        print(json.dumps(line), flush=True)
        log.append(line)
        attempted = st.counts["connected"] + st.counts["connect_fail"]
        if attempted >= 20 and st.counts["connect_fail"] / attempted > args.abort_fail_ratio:
            print(f"ABORT: connect failures {st.counts['connect_fail']}/{attempted}", flush=True)
            stop.set()
        if w and pct(w, 0.95) > args.abort_p95_ms:
            print(f"ABORT: delivery p95 {pct(w, 0.95)} ms > {args.abort_p95_ms}", flush=True)
            stop.set()


async def run_chat(args):
    st = Stats()
    stop = asyncio.Event()
    ssl_ctx = ssl.create_default_context()
    clients = [Client(i, args, st, stop) for i in range(args.clients)]
    for a, b in zip(clients[0::2], clients[1::2]):
        a.partner, b.partner = b, a
    log = []
    t_start = time.monotonic()
    prog = asyncio.create_task(progress(st, stop, args, t_start, log))
    tasks = []
    gap = args.ramp / max(1, args.clients)
    for c in clients:
        if stop.is_set():
            break
        tasks.append(asyncio.create_task(c.run(ssl_ctx)))
        await asyncio.sleep(gap)
    if args.steps:
        # Ступени частоты после разгона: "1:30,5:30" — 1 сообщ./с на клиента 30 с, затем 5 сообщ./с 30 с
        for step in args.steps.split(","):
            rate, secs = (float(x) for x in step.split(":"))
            args.rate = rate
            print(json.dumps({"step_rate": rate, "secs": secs, "active": st.active}), flush=True)
            log.append({"t": round(time.monotonic() - t_start), "step_rate": rate})
            try:
                await asyncio.wait_for(stop.wait(), secs)
                break
            except asyncio.TimeoutError:
                pass
    else:
        remaining = args.ramp + args.duration - (time.monotonic() - t_start)
        try:
            await asyncio.wait_for(stop.wait(), max(0, remaining))
        except asyncio.TimeoutError:
            pass
    stop.set()
    # Клиенты, чей собеседник не подключился, ждут его — отпустить
    for c in clients:
        c.ready.set()
    await asyncio.gather(*tasks, return_exceptions=True)
    prog.cancel()
    res = {
        "mode": "chat",
        "args": vars(args),
        "elapsed_s": round(time.monotonic() - t_start, 1),
        "peak_active": st.peak_active,
        "counts": dict(st.counts),
        "lost": len(st.sent_at),
        "errors": dict(st.errors),
        "connect": summary(st.connect),
        "sent_rtt": summary(st.sent_rtt),
        "deliver": summary(st.deliver),
        "timeline": log,
    }
    return res


async def run_blobs(args):
    base = args.url.replace("wss://", "https://").replace("ws://", "http://").rsplit("/ws", 1)[0]
    stop = asyncio.Event()
    lat = {"put": [], "get": [], "done": []}
    counts, errors = Counter(), Counter()
    key = Ed25519PrivateKey.generate()
    pub = b64u(key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw))
    t_start = time.monotonic()
    nbytes = 0
    leftover = set()  # загружены, но done не прошёл — остались на сервере

    async def worker(session):
        nonlocal nbytes
        while not stop.is_set():
            bid = b64u(os.urandom(16))
            body = os.urandom(args.blob_size)
            sig = b64u(key.sign(f"tm-blob-v1:{bid}:{len(body)}:1".encode()))
            try:
                t0 = time.monotonic()
                async with session.put(f"{base}/blob/{bid}?n=1", data=body,
                                       headers={"X-TM-Auth": f"{pub}.{sig}"}) as r:
                    await r.read()
                    if r.status not in (200, 201):
                        errors[f"put_{r.status}"] += 1
                        await asyncio.sleep(1)
                        continue
                lat["put"].append(time.monotonic() - t0)
                leftover.add(bid)
                # GET и done повторяем при 429: иначе файл останется на сервере и съест квоту
                for _ in range(20):
                    t0 = time.monotonic()
                    async with session.get(f"{base}/blob/{bid}") as r:
                        data = await r.read()
                    if r.status != 429:
                        break
                    errors["get_429_retry"] += 1
                    await asyncio.sleep(1)
                if r.status != 200 or data != body:
                    errors[f"get_{r.status}"] += 1
                lat["get"].append(time.monotonic() - t0)
                for _ in range(20):
                    t0 = time.monotonic()
                    async with session.post(f"{base}/blob/{bid}/done") as r:
                        status = r.status
                    if status != 429:
                        break
                    errors["done_429_retry"] += 1
                    await asyncio.sleep(1)
                if status == 204:
                    leftover.discard(bid)
                else:
                    errors[f"done_{status}"] += 1
                lat["done"].append(time.monotonic() - t0)
                counts["cycles"] += 1
                nbytes += 2 * len(body)
            except Exception as e:
                errors[type(e).__name__] += 1
                await asyncio.sleep(1)

    timeout = aiohttp.ClientTimeout(total=120)
    async with aiohttp.ClientSession(timeout=timeout, headers={"User-Agent": "tm-loadtest"}) as s:
        tasks = [asyncio.create_task(worker(s)) for _ in range(args.workers)]
        await asyncio.sleep(args.duration)
        stop.set()
        await asyncio.gather(*tasks, return_exceptions=True)
    el = time.monotonic() - t_start
    return {
        "mode": "blob",
        "args": vars(args),
        "elapsed_s": round(el, 1),
        "counts": dict(counts),
        "errors": dict(errors),
        "mbit_per_s": round(nbytes * 8 / el / 1e6, 1),
        "leftover_ids": sorted(leftover),
        "put": summary(lat["put"]),
        "get": summary(lat["get"]),
        "done": summary(lat["done"]),
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("mode", choices=["chat", "blob"])
    p.add_argument("--url", default="wss://chat.tempmessenger.tech/ws")
    p.add_argument("--clients", type=int, default=20)
    p.add_argument("--rate", type=float, default=0.2, help="сообщений в секунду на клиента")
    p.add_argument("--payload", type=int, default=600, help="размер payload, байт")
    p.add_argument("--ramp", type=float, default=10, help="секунд на подключение всех клиентов")
    p.add_argument("--duration", type=float, default=30, help="секунд после разгона")
    p.add_argument("--steps", help='ступени частоты вместо --duration: "1:30,5:30,10:30"')
    p.add_argument("--drain", type=float, default=3)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--blob-size", type=int, default=256 * 1024)
    p.add_argument("--abort-fail-ratio", type=float, default=0.3)
    p.add_argument("--abort-p95-ms", type=float, default=5000)
    p.add_argument("--out")
    args = p.parse_args()
    res = asyncio.run(run_chat(args) if args.mode == "chat" else run_blobs(args))
    text = json.dumps(res, ensure_ascii=False, indent=1)
    if args.out:
        with open(args.out, "w") as f:
            f.write(text)
    tl = res.pop("timeline", None)
    print(json.dumps(res, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    sys.exit(main())
