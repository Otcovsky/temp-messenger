"""Пуши в Android-приложение через Firebase Cloud Messaging (HTTP v1).

Браузеры получают пуши по Web Push (push.py), а приложению Google доставляет их через FCM.
Как и там, в пуше нет ни текста, ни отправителя: только пометка, что это — сообщение, звонок
или конец звонка. Пометка зашифрована AES-GCM ключом, который приложение создало само и прислало
вместе с токеном, поэтому Google её не видит (как и в Web Push, различить можно разве что по времени).

Включается, когда задан TM_FCM_CREDENTIALS — путь к JSON-ключу сервисного аккаунта Firebase.
Ключ — секрет: он лежит только на сервере, в репозиторий не попадает.
"""

import base64
import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

log = logging.getLogger("temp_messenger.fcm")

# Подписка приложения хранится там же, где подписки браузеров: endpoint = "fcm:<токен>",
# auth = ключ шифрования пометки (base64url, 32 байта)
FCM_PREFIX = "fcm:"
TOKEN_RE = re.compile(r"[A-Za-z0-9_:\-]{20,1000}")  # проверять только fullmatch
KEY_BYTES = 32

SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
TOKEN_URI = "https://oauth2.googleapis.com/token"
SEND_URL = "https://fcm.googleapis.com/v1/projects/{project}/messages:send"

# (токен устройства, данные пуша, TTL в секундах) -> HTTP-статус FCM
FcmSend = Callable[[str, dict[str, str], int], int]


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def token_valid(token) -> bool:
    return isinstance(token, str) and TOKEN_RE.fullmatch(token) is not None


def key_valid(key) -> bool:
    if not isinstance(key, str) or len(key) > 64:
        return False
    try:
        return len(_unb64(key)) == KEY_BYTES
    except ValueError:
        return False


def seal(mark: bytes, key_b64: str) -> str:
    """Зашифровать пометку: base64url(nonce 12 байт ‖ шифротекст с тегом)."""
    nonce = os.urandom(12)
    return _b64(nonce + AESGCM(_unb64(key_b64)).encrypt(nonce, mark, None))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def _post(url: str, body: bytes, headers: dict[str, str]) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with _opener.open(req, timeout=10) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class Fcm:
    """Отправка через FCM HTTP v1 с ключом сервисного аккаунта. Блокирующие вызовы — в потоке."""

    def __init__(self, credentials_path: str):
        with open(credentials_path, encoding="utf-8") as f:
            info = json.load(f)
        self.project = info["project_id"]
        self.email = info["client_email"]
        self.key = serialization.load_pem_private_key(info["private_key"].encode(), password=None)
        self.token_uri = info.get("token_uri") or TOKEN_URI
        if self.token_uri != TOKEN_URI:
            raise ValueError("unexpected token_uri in FCM credentials")
        self._access: tuple[float, str] | None = None
        self._lock = threading.Lock()

    def _assertion(self, now: int) -> str:
        head = _b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
        claims = {"iss": self.email, "scope": SCOPE, "aud": self.token_uri, "iat": now, "exp": now + 3600}
        body = _b64(json.dumps(claims).encode())
        sig = self.key.sign(f"{head}.{body}".encode(), padding.PKCS1v15(), hashes.SHA256())
        return f"{head}.{body}.{_b64(sig)}"

    def access_token(self) -> str:
        """OAuth-токен Google живёт час; берём новый за 5 минут до конца."""
        with self._lock:
            now = time.time()
            if self._access and self._access[0] - 300 > now:
                return self._access[1]
            form = urllib.parse.urlencode(
                {"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": self._assertion(int(now))}
            ).encode()
            status, raw = _post(self.token_uri, form, {"Content-Type": "application/x-www-form-urlencoded"})
            if status != 200:
                raise RuntimeError(f"Google OAuth refused the FCM key: HTTP {status}")
            data = json.loads(raw)
            self._access = (now + int(data.get("expires_in", 3600)), data["access_token"])
            return self._access[1]

    def send(self, token: str, data: dict[str, str], ttl: int) -> int:
        message = {
            "message": {
                "token": token,
                "data": data,
                # high — иначе спящий телефон получит пуш с задержкой; collapse_key — недоставленные
                # пуши одного устройства заменяют друг друга, как Topic в Web Push
                "android": {"priority": "HIGH", "ttl": f"{ttl}s", "collapse_key": "tm"},
            }
        }
        status, _ = _post(
            SEND_URL.format(project=self.project),
            json.dumps(message).encode(),
            {"Authorization": f"Bearer {self.access_token()}", "Content-Type": "application/json"},
        )
        return status

