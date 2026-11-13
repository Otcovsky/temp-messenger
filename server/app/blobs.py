"""Файлы: хранение зашифрованных клиентом байтов (подробно — docs/protocol.md, «Файлы»).

  PUT  /blob/{id}?n=<получателей>   X-TM-Auth: <pub>.<sig>   тело — шифротекст
       sig = Ed25519(AUTH, "tm-blob-v1:<id>:<размер>:<n>")
  GET  /blob/{id}                   шифротекст
  POST /blob/{id}/done              получатель скачал; после n таких запросов файл стирается

Сервер не знает ни ключа, ни имени, ни типа файла: только id, размер и ключ доступа загрузившего
(для квоты). id случайный (128 бит) и известен только участникам переписки, поэтому скачивание
не требует авторизации.
"""

import base64
import contextlib
import logging
import os
import re
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from starlette.requests import ClientDisconnect

from .config import Settings
from .store import Store

log = logging.getLogger("temp_messenger")

BLOB_CONTEXT = b"tm-blob-v1:"
BLOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{22}$")  # 16 байт в base64url


class BlobFiles:
    """Каталог с файлами. Пока загрузка идёт, файл называется <id>.part."""

    def __init__(self, root: str):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, blob_id: str) -> Path:
        return self.root / blob_id

    def part(self, blob_id: str) -> Path:
        return self.root / f"{blob_id}.part"

    def remove(self, blob_id: str) -> None:
        for p in (self.path(blob_id), self.part(blob_id)):
            with contextlib.suppress(FileNotFoundError):
                p.unlink()

    def sweep(self, known: set[str]) -> int:
        """Стереть файлы, о которых база ничего не знает (след сбоя посреди удаления)."""
        n = 0
        for p in self.root.iterdir():
            if p.name.removesuffix(".part") not in known:
                with contextlib.suppress(OSError):
                    p.unlink()
                    n += 1
        return n


def cleanup_blobs(store: Store, files: BlobFiles) -> int:
    expired = store.blob_expired()
    for blob_id in expired:
        files.remove(blob_id)
    return len(expired) + files.sweep(store.blob_ids())


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _owner(header: str | None, message: bytes) -> str | None:
    """Проверить подпись X-TM-Auth и вернуть ключ доступа (base64url) или None."""
    if not header or "." not in header:
        return None
    pub, sig = header.split(".", 1)
    try:
        Ed25519PublicKey.from_public_bytes(_b64url_decode(pub)).verify(_b64url_decode(sig), message)
    except (ValueError, InvalidSignature):
        return None
    return pub


def _error(status: int, code: str) -> JSONResponse:
    return JSONResponse({"error": code}, status_code=status, headers={"Cache-Control": "no-store"})


def add_blob_routes(app: FastAPI, cfg: Settings) -> None:
    def store() -> Store:
        return app.state.store

    def files() -> BlobFiles:
        return app.state.blobs

    @app.put("/blob/{blob_id}")
    async def put_blob(blob_id: str, request: Request):
        if not BLOB_ID_RE.match(blob_id):
            return _error(404, "bad_id")
        try:
            size = int(request.headers["content-length"])
        except (KeyError, ValueError):
            return _error(411, "length_required")
        if size < 1 or size > cfg.max_blob_bytes:
            return _error(413, "too_large")
        try:
            n = int(request.query_params.get("n", "1"))
        except ValueError:
            n = 0
        if not 1 <= n <= cfg.max_recipients:
            return _error(400, "bad_recipients")
        owner = _owner(request.headers.get("x-tm-auth"), BLOB_CONTEXT + f"{blob_id}:{size}:{n}".encode())
        if owner is None:
            return _error(403, "auth_failed")

        res = store().blob_reserve(
            blob_id, owner, size, n, cfg.blob_upload_timeout_sec, cfg.blob_quota_per_owner, cfg.blob_quota_total
        )
        if res == "exists":  # повтор после потерянного ответа — файл уже здесь
            return Response(status_code=200)
        if res == "quota":
            return _error(507, "quota")
        if res != "ok":
            return _error(409, res)

        part = files().part(blob_id)
        written = 0
        try:
            with open(part, "wb") as f:
                async for chunk in request.stream():
                    written += len(chunk)
                    if written > size:
                        break
                    f.write(chunk)
            if written != size:
                raise ValueError("length mismatch")
            os.replace(part, files().path(blob_id))
        except (ClientDisconnect, ValueError, OSError) as e:
            store().blob_abort(blob_id)
            files().remove(blob_id)
            if isinstance(e, OSError):
                log.warning("blob write failed: %s", e)
                return _error(507, "storage")
            return _error(400, "incomplete")
        store().blob_complete(blob_id, cfg.blob_ttl_sec)
        return Response(status_code=201)

    @app.get("/blob/{blob_id}")
    async def get_blob(blob_id: str):
        if not BLOB_ID_RE.match(blob_id) or not store().blob_available(blob_id):
            return _error(404, "not_found")
        path = files().path(blob_id)
        if not path.is_file():
            return _error(404, "not_found")
        return FileResponse(path, media_type="application/octet-stream", headers={"Cache-Control": "no-store"})

    @app.post("/blob/{blob_id}/done")
    async def blob_done(blob_id: str):
        if BLOB_ID_RE.match(blob_id) and store().blob_done(blob_id):
            files().remove(blob_id)
        return Response(status_code=204)
