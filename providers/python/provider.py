# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "aiohttp>=3.12,<4",
#   "httpx>=0.28,<1",
#   "openai>=2.54,<3",
#   "simplejson>=3.20",
# ]
# ///
"""A reference provider for one text deployment."""

import asyncio
import hashlib
import json
import os
import socket
import sqlite3
import time
from collections.abc import Mapping
from contextlib import ExitStack, suppress
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from types import TracebackType
from typing import Any, cast
from urllib.parse import urlparse
from uuid import uuid4

import httpx
import simplejson
from aiohttp import ClientError, ClientSession, ClientWebSocketResponse, WSMsgType, web
from openai import AsyncOpenAI, OpenAIError
from openai.types.chat import ChatCompletionMessageParam

VERSION = "0.1.0"


def log(event: str, **fields: object) -> None:
    print(json.dumps({"event": event, **fields}), flush=True)


@dataclass(frozen=True)
class Settings:
    exchange_url: str
    slug: str
    provider_key: str
    deployment_name: str
    dispatch_bind: str
    dispatch_url: str
    upstream_url: str
    upstream_key: str
    input_rate: Decimal
    cache_rate: Decimal
    output_rate: Decimal
    retention: str
    award_db: Path
    quote_lifetime_ms: int
    upstream_timeout: float
    shutdown_timeout: float

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "Settings":
        def required(name: str) -> str:
            value = env.get(f"LIQUID_{name}", "").strip()
            if not value:
                raise ValueError(f"LIQUID_{name} is required")
            return value

        def rate(name: str) -> Decimal:
            try:
                value = Decimal(required(name))
            except InvalidOperation as error:
                raise ValueError(f"LIQUID_{name} must be a decimal price") from error
            exponent = value.as_tuple().exponent
            if not value.is_finite() or value < 0 or not isinstance(exponent, int) or exponent < -9:
                raise ValueError(
                    f"LIQUID_{name} must be non-negative with at most nine decimal places"
                )
            return value

        def duration(name: str, default: str) -> float:
            value = float(env.get(f"LIQUID_{name}", default))
            if not 0 < value <= 3600:
                raise ValueError(f"LIQUID_{name} must be between zero and 3600 seconds")
            return value

        exchange = required("EXCHANGE_URL").rstrip("/")
        upstream = required("UPSTREAM_BASE_URL").rstrip("/")
        dispatch = required("DISPATCH_URL")
        for name, value in [
            ("EXCHANGE_URL", exchange),
            ("UPSTREAM_BASE_URL", upstream),
            ("DISPATCH_URL", dispatch),
        ]:
            parsed = urlparse(value)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username:
                raise ValueError(f"LIQUID_{name} must be an HTTP URL without credentials")
        retention = required("RETENTION_POLICY")
        if retention not in {"none", "allowed"}:
            raise ValueError("LIQUID_RETENTION_POLICY must be none or allowed")
        lifetime = int(env.get("LIQUID_QUOTE_LIFETIME_MS", "60000"))
        if not 0 < lifetime <= 600000:
            raise ValueError("LIQUID_QUOTE_LIFETIME_MS must be between zero and 600000")
        bind = required("DISPATCH_BIND")
        host, port = bind.rsplit(":", 1)
        if not host or not 0 <= int(port) <= 65535:
            raise ValueError("LIQUID_DISPATCH_BIND must be host:port")
        return cls(
            exchange,
            required("PROVIDER_SLUG"),
            required("PROVIDER_API_KEY"),
            required("DEPLOYMENT_NAME"),
            bind,
            dispatch,
            upstream,
            required("UPSTREAM_API_KEY"),
            rate("RATE_INPUT"),
            rate("RATE_CACHE_READ"),
            rate("RATE_OUTPUT"),
            retention,
            Path(required("AWARD_DB")),
            lifetime,
            duration("UPSTREAM_TIMEOUT_SECONDS", "30"),
            duration("SHUTDOWN_TIMEOUT_SECONDS", "35"),
        )


def count(value: object) -> int:
    if type(value) is not int or value < 0:
        raise ValueError("usage must contain non-negative integer counts")
    return value


def details(value: object) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("usage details must be an object")
    return value


def optional_count(value: object) -> int:
    return 0 if value is None else count(value)


# doc:start usage
def usage_report(raw: dict[str, Any], tokenizer_id: str) -> dict[str, Any]:
    prompt = count(raw.get("prompt_tokens"))
    output = count(raw.get("completion_tokens"))
    input_details = details(raw.get("prompt_tokens_details"))
    output_details = details(raw.get("completion_tokens_details"))
    cached = optional_count(input_details.get("cached_tokens"))
    if cached > prompt:
        raise ValueError("cached input exceeds total input")
    if optional_count(output_details.get("reasoning_tokens")):
        raise ValueError("the reference does not support reasoning")
    if optional_count(input_details.get("cache_write_tokens")):
        raise ValueError("the reference does not support cache writes")
    return {
        "meters": {
            "uncached_input": prompt - cached,
            "cache_read": cached,
            "cache_write_short": 0,
            "cache_write_long": 0,
            "generation": output,
        },
        "tokenizer_id": tokenizer_id,
        "reasoning_tokens": None,
        "raw": raw,
    }


# doc:end usage


class Journal:
    """Retains each award claim before an upstream request."""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, timeout=5)
        self.connection.execute("PRAGMA synchronous = FULL")
        self.connection.execute(
            "CREATE TABLE IF NOT EXISTS awards ("
            "provider_id TEXT NOT NULL, award_id TEXT NOT NULL, "
            "request_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, "
            "PRIMARY KEY (provider_id, award_id))"
        )

    def contains(self, provider_id: str, award_id: str) -> bool:
        return (
            self.connection.execute(
                "SELECT 1 FROM awards WHERE provider_id = ? AND award_id = ?",
                (provider_id, award_id),
            ).fetchone()
            is not None
        )

    # doc:start claim
    def claim(self, provider_id: str, award_id: str, request: dict[str, object]) -> bool:
        fingerprint = hashlib.sha256(
            json.dumps(request, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        with self.connection:
            cursor = self.connection.execute(
                "INSERT OR IGNORE INTO awards (provider_id, award_id, request_hash) "
                "VALUES (?, ?, ?)",
                (provider_id, award_id, fingerprint),
            )
        return cursor.rowcount == 1

    # doc:end claim

    def __enter__(self) -> "Journal":
        return self

    def __exit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.connection.close()


@dataclass(frozen=True)
class Snapshot:
    model_id: str
    model: str
    tokenizer_id: str
    max_input_tokens: int
    # None when the deployment states no output limit.
    max_output_tokens: int | None
    reference: str

    @classmethod
    def from_model(cls, model: dict[str, Any]) -> "Snapshot":
        if model.get("kind", "chat") != "chat" or model.get("pricing_unit", "tokens") != "tokens":
            raise ValueError("the reference requires a text deployment with token prices")
        return cls(
            model["model_id"],
            model["model"],
            model["tokenizer_id"],
            model["max_input_tokens"],
            model.get("max_output_tokens"),
            str(uuid4()),
        )

    def identity(self) -> tuple[str, str, str, int, int | None]:
        return (
            self.model_id,
            self.model,
            self.tokenizer_id,
            self.max_input_tokens,
            self.max_output_tokens,
        )


class Connection:
    """One session with the exchange. During a handover there are two."""

    def __init__(self, session: "Session", handover_from: "Connection | None" = None) -> None:
        self.session = session
        self.settings = session.settings
        self.handover_from = handover_from
        self.logged_in = False
        self.selected: Snapshot | None = None
        self.pending: dict[int, tuple[Snapshot, float]] = {}
        self.revision = 0
        self.refresh_at = float("inf")
        self.socket: ClientWebSocketResponse | None = None
        self.changed = asyncio.Event()
        # A newer session of this provider quotes now: this one sends heartbeats
        # only, until a `listed` makes it current again.
        self.retiring = False
        self.listed = False
        self.ready_sent = handover_from is None

    async def send(self, frame: dict[str, Any]) -> None:
        if self.socket is not None:
            await self.socket.send_str(simplejson.dumps(frame, use_decimal=True))

    # doc:start quote
    async def quote(self) -> None:
        model = self.selected
        if model is None or self.retiring:
            return
        self.revision += 1
        self.pending[self.revision] = (model, time.monotonic())
        await self.send(
            {
                "type": "quote",
                "target": {"kind": "registered", "model_id": model.model_id},
                "execution_ref": model.reference,
                "execution_limits": {
                    "max_input_tokens": model.max_input_tokens,
                    "max_output_tokens": model.max_output_tokens,
                },
                "rate_uncached_input": self.settings.input_rate,
                "rate_cache_read": self.settings.cache_rate,
                "rate_generation": self.settings.output_rate,
                "fixed_fee": 0,
                "service_class": {"ttft_ms": 1500, "completion_ms": 30000},
                "supported_features": ["text"],
                "retention_policy_supported": [self.settings.retention],
                "valid_for_ms": self.settings.quote_lifetime_ms,
                "revision": self.revision,
            }
        )
        self.refresh_at = time.monotonic() + self.settings.quote_lifetime_ms / 2000

    # doc:end quote

    async def receive(self, frame: dict[str, Any]) -> bool:
        """Handles one frame. Returns False when the exchange ended this session."""
        kind = frame.get("type")
        if kind == "login_ack":
            self.session.provider_id = frame["provider_id"]
            self.logged_in = True
            log("login_ack", provider_id=frame["provider_id"], slug=frame.get("slug"))
        elif kind == "login_reject":
            log("login_reject", reason=frame.get("reason"))
            raise ValueError("login refused")
        elif kind == "listed":
            if not self.logged_in:
                raise ValueError("listed arrived before login_ack")
            matches = [
                model
                for model in frame["models"]
                if model["deployment_name"] == self.settings.deployment_name
            ]
            previous = self.selected
            self.retiring = False
            self.refresh_at = float("inf")
            self.selected = Snapshot.from_model(matches[0]) if len(matches) == 1 else None
            if self.selected and previous and self.selected.identity() == previous.identity():
                self.selected = previous
            elif previous:
                await self.send(
                    {
                        "type": "withdraw_quote",
                        "target": {"kind": "registered", "model_id": previous.model_id},
                    }
                )
            log(
                "listed",
                deployment=self.settings.deployment_name,
                available=self.selected is not None,
            )
            await self.quote()
            self.listed = True
            self.changed.set()
        elif kind == "quote_ack":
            pending = self.pending.pop(frame["revision"], None)
            if pending is not None and frame["offer_id"] == pending[0].model_id:
                model, sent_at = pending
                self.session.snapshots[model.reference] = model
                lifetime = frame.get("valid_for_ms", 0) or self.settings.quote_lifetime_ms
                if self.selected == model:
                    self.refresh_at = sent_at + lifetime / 2000
                self.changed.set()
            log("quote_ack", **{key: value for key, value in frame.items() if key != "type"})
        elif kind == "quote_reject":
            # The reference quotes one deployment, so a refusal answers every
            # quote in flight.
            self.pending.clear()
            if frame.get("code") == "superseded":
                self.retiring = True
                self.refresh_at = float("inf")
            log("quote_reject", **{key: value for key, value in frame.items() if key != "type"})
        elif kind == "award_notice":
            await self.session.notice(frame)
        elif kind == "settlement_notice":
            self.session.awards.pop(frame["award_id"], None)
            log(
                "settlement_notice", **{key: value for key, value in frame.items() if key != "type"}
            )
        elif kind == "risk_notice":
            log("risk_notice", severity=frame.get("severity"), message=frame.get("message"))
        elif kind == "handover":
            log("handover")
            self.session.handover(self)
        elif kind == "superseded":
            log("superseded")
            return False
        if not self.ready_sent and self.listed and not self.pending and self.handover_from:
            self.ready_sent = True
            await self.handover_from.send({"type": "handover_ready"})
            log("handover_ready")
        return True

    async def refresh(self) -> None:
        while not self.session.stopping.is_set():
            self.changed.clear()
            try:
                await asyncio.wait_for(
                    self.changed.wait(), max(0.01, min(1, self.refresh_at - time.monotonic()))
                )
            except TimeoutError:
                if time.monotonic() >= self.refresh_at:
                    await self.quote()
                await self.send({"type": "heartbeat"})

    async def run(self, http: ClientSession, url: str) -> str:
        """Holds the session until it ends. Returns `closed` when the session
        ended after the login, `superseded` when a newer session took over,
        and `failed` otherwise."""
        try:
            async with http.ws_connect(url, heartbeat=10) as socket:
                self.socket = socket
                await self.send(
                    {
                        "type": "login",
                        "slug": self.settings.slug,
                        "api_key": self.settings.provider_key,
                        "dispatch_url": self.settings.dispatch_url,
                        "capabilities": ["handover"],
                    }
                )
                async with asyncio.TaskGroup() as group:
                    refresher = group.create_task(self.refresh())
                    try:
                        async for message in socket:
                            if message.type == WSMsgType.TEXT and not await self.receive(
                                json.loads(message.data)
                            ):
                                return "superseded"
                    finally:
                        refresher.cancel()
        except (ClientError, OSError, ValueError, ExceptionGroup) as error:
            log("session_error", error=type(error).__name__)
        finally:
            self.socket = None
            log("session_closed")
        return "closed" if self.logged_in else "failed"


class Session:
    """The provider's state that its sessions share: the awards, the execution
    snapshots, and the sessions themselves."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.provider_id: str | None = None
        self.snapshots: dict[str, Snapshot] = {}
        self.awards: dict[str, dict[str, Any]] = {}
        self.noticed = asyncio.Condition()
        self.stopping = asyncio.Event()
        self.connections: dict[Connection, asyncio.Task[str]] = {}
        self.added = asyncio.Event()
        # A newer process of this provider serves it, so this one does not
        # reconnect. It still serves the jobs that it has.
        self.standby = False
        self.http: ClientSession | None = None
        self.url = (
            settings.exchange_url.replace("https://", "wss://", 1).replace("http://", "ws://", 1)
            + "/v1/provider/ws"
        )

    @property
    def current(self) -> Connection | None:
        return next(reversed(self.connections), None)

    @property
    def socket(self) -> ClientWebSocketResponse | None:
        current = self.current
        return current.socket if current else None

    @property
    def refresh_at(self) -> float:
        current = self.current
        return current.refresh_at if current else float("inf")

    async def notice(self, frame: dict[str, Any]) -> None:
        # An award can arrive on either session during a handover.
        async with self.noticed:
            self.awards[frame["award_id"]] = {
                **frame,
                "provider_id": self.provider_id,
                "references": tuple(self.snapshots),
            }
            self.noticed.notify_all()
        log("award_notice", award_id=frame["award_id"], job_id=frame["job_id"])

    async def award(self, award_id: str) -> dict[str, Any]:
        async with asyncio.timeout(2), self.noticed:
            await self.noticed.wait_for(lambda: award_id in self.awards)
            return self.awards[award_id]

    def open(self, handover_from: Connection | None = None) -> None:
        assert self.http is not None
        connection = Connection(self, handover_from)
        self.connections[connection] = asyncio.create_task(connection.run(self.http, self.url))
        self.added.set()

    def handover(self, connection: Connection) -> None:
        """The exchange process of `connection` stops soon: open a second
        session, which the load balancer sends to the next process."""
        if len(self.connections) < 2 and not self.stopping.is_set():
            self.open(handover_from=connection)

    async def run(self) -> None:
        backoff = 0.25
        async with ClientSession() as http:
            self.http = http
            self.open()
            while not self.stopping.is_set():
                self.added.clear()
                added = asyncio.create_task(self.added.wait())
                stopping = asyncio.create_task(self.stopping.wait())
                done, _ = await asyncio.wait(
                    [*self.connections.values(), added, stopping],
                    return_when=asyncio.FIRST_COMPLETED,
                )
                added.cancel()
                stopping.cancel()
                ended = [c for c, task in self.connections.items() if task in done]
                for connection in ended:
                    end = self.connections.pop(connection).result()
                    if self.connections:
                        continue
                    if end == "superseded":
                        self.standby = True
                        log("standby")
                        await self.stopping.wait()
                        return
                    if end == "failed":
                        try:
                            await asyncio.wait_for(self.stopping.wait(), backoff)
                            return
                        except TimeoutError:
                            backoff = min(backoff * 2, 5)
                    else:
                        backoff = 0.25
                    if not self.stopping.is_set():
                        self.open()
            # `stop` withdraws on each session and closes it. Give the sessions
            # that time before they are cancelled.
            tasks = list(self.connections.values())
            if tasks:
                await asyncio.wait(tasks, timeout=2)
            for task in tasks:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task

    async def stop(self) -> None:
        self.stopping.set()
        live = [c for c in self.connections if c.socket is not None]
        for connection in live:
            connection.changed.set()
            await connection.send({"type": "mass_withdraw"})
        for connection in live:
            if connection.socket is not None:
                await connection.socket.close()


class Runtime:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.journal = Journal(settings.award_db)
        self.session = Session(settings)
        self.upstream = AsyncOpenAI(
            base_url=settings.upstream_url,
            api_key=settings.upstream_key,
            max_retries=0,
            timeout=settings.upstream_timeout,
        )
        self.task: asyncio.Task[None] | None = None

    def application(self) -> web.Application:
        app = web.Application(client_max_size=1024 * 1024)
        app.router.add_post("/dispatch", self.dispatch)
        app.router.add_get("/health", self.health)
        app.on_startup.append(self.start)
        app.on_shutdown.append(self.shutdown)
        app.on_cleanup.append(self.close)
        return app

    async def start(self, app: web.Application) -> None:
        self.task = asyncio.create_task(self.session.run())

    async def shutdown(self, app: web.Application) -> None:
        try:
            async with asyncio.timeout(self.settings.shutdown_timeout):
                await self.session.stop()
                if self.task is not None and not self.task.done():
                    await asyncio.shield(self.task)
        except TimeoutError:
            log("session_shutdown_timeout")
        finally:
            if self.task is not None:
                self.task.cancel()
                with suppress(asyncio.CancelledError):
                    await self.task

    async def close(self, app: web.Application) -> None:
        await self.upstream.close()
        self.journal.connection.close()

    async def health(self, request: web.Request) -> web.Response:
        return web.json_response(
            {
                "connected": self.session.socket is not None,
                "connections": sum(1 for c in self.session.connections if c.socket is not None),
                "standby": self.session.standby,
                "deployment": self.settings.deployment_name,
            }
        )

    async def validate(self, body: dict[str, Any]) -> Snapshot:
        notice = await self.session.award(body["award_id"])
        for key in ("award_id", "job_id", "offer_id", "served_model"):
            if body.get(key) != notice.get(key):
                raise ValueError(f"dispatch {key} does not match the award")
        model = self.session.snapshots.get(body.get("execution_ref", ""))
        if model is None or model.reference not in notice["references"]:
            raise ValueError("dispatch execution_ref does not match the award")
        if model.model_id != body["offer_id"] or model.model != body["served_model"]:
            raise ValueError("dispatch does not match the deployment")
        limit = count(body.get("max_output_tokens"))
        allowed = notice["max_output_tokens"]
        if model.max_output_tokens is not None:
            allowed = min(allowed, model.max_output_tokens)
        if not 0 < limit <= allowed:
            raise ValueError("dispatch exceeds the output limit")
        unsupported = (
            "tools",
            "tool_choice",
            "response_format",
            "top_p",
            "stop",
            "seed",
            "logprobs",
            "top_logprobs",
            "logit_bias",
            "frequency_penalty",
            "presence_penalty",
            "reasoning",
            "image",
            "audio",
            "video",
            "pricing_unit",
        )
        if any(body.get(key) not in (None, [], {}) for key in unsupported):
            raise ValueError("dispatch requires an unsupported feature")
        cache = body.get("cache") or {}
        if not isinstance(cache, dict):
            raise ValueError("dispatch requires a valid cache object")
        if cache.get("breakpoints") or cache.get("key") or cache.get("scope"):
            raise ValueError("dispatch requires prompt cache support")
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            raise ValueError("dispatch requires text messages")
        for message in messages:
            if not isinstance(message, dict):
                raise ValueError("dispatch requires a message object")
            if message.get("role") not in {"system", "user", "assistant", "developer"}:
                raise ValueError("dispatch requires a text role")
            if not isinstance(message.get("content"), str):
                raise ValueError("dispatch requires text content")
            if message.get("tool_calls") or message.get("tool_call_id") or message.get("reasoning"):
                raise ValueError("dispatch requires an unsupported message feature")
            parts = message.get("parts", [])
            if not isinstance(parts, list) or any(
                not isinstance(part, dict) or part.get("type") != "text" for part in parts
            ):
                raise ValueError("dispatch requires an unsupported input modality")
        return model

    async def dispatch(self, request: web.Request) -> web.StreamResponse:
        try:
            body = await request.json()
            if not isinstance(body, dict) or not isinstance(body.get("award_id"), str):
                raise ValueError("dispatch requires an award_id")
            if request.headers.get("idempotency-key") != body["award_id"]:
                raise ValueError("idempotency-key must match award_id")
            provider_id = self.session.provider_id
            if provider_id is None:
                return web.json_response({"error": "session_unavailable"}, status=503)
            if self.journal.contains(provider_id, body["award_id"]):
                return web.json_response({"error": "duplicate_award"}, status=409)
            model = await self.validate(body)
            if not self.journal.claim(provider_id, body["award_id"], body):
                return web.json_response({"error": "duplicate_award"}, status=409)
        except (ValueError, KeyError, TypeError, TimeoutError) as error:
            return web.json_response(
                {"error": "invalid_dispatch", "message": str(error)}, status=400
            )
        except sqlite3.Error:
            log("journal_unavailable")
            return web.json_response({"error": "journal_unavailable"}, status=503)
        response = web.StreamResponse(headers={"Content-Type": "application/x-ndjson"})
        await response.prepare(request)

        async def emit(event: dict[str, Any]) -> None:
            await response.write((json.dumps(event) + "\n").encode())

        try:
            # doc:start upstream
            stream = await self.upstream.chat.completions.create(
                model=model.model,
                messages=cast(
                    list[ChatCompletionMessageParam],
                    [
                        {"role": message["role"], "content": message["content"]}
                        for message in body["messages"]
                    ],
                ),
                max_tokens=body["max_output_tokens"],
                temperature=body.get("temperature"),
                stream=True,
                stream_options={"include_usage": True},
            )
            raw: dict[str, Any] | None = None
            finish_reason: str | None = None
            output_sent = False
            async with stream:
                async for chunk in stream:
                    if chunk.usage is not None:
                        raw = chunk.usage.model_dump(mode="json", exclude_unset=True)
                    for choice in chunk.choices:
                        if choice.delta.tool_calls or choice.delta.function_call:
                            raise ValueError("upstream returned a tool call")
                        if choice.delta.model_extra and any(
                            choice.delta.model_extra.get(key)
                            for key in ("reasoning", "reasoning_content", "reasoning_details")
                        ):
                            raise ValueError("upstream returned reasoning")
                        if choice.delta.content:
                            await emit({"type": "delta", "text": choice.delta.content})
                            if not output_sent:
                                log("first_output", award_id=body["award_id"])
                                output_sent = True
                        if choice.finish_reason is not None:
                            finish_reason = choice.finish_reason
            if raw is None or finish_reason not in {"stop", "length", "content_filter"}:
                raise ValueError("upstream ended without valid usage and finish_reason")
            await emit(
                {
                    "type": "done",
                    "finish_reason": finish_reason,
                    "usage": usage_report(raw, model.tokenizer_id),
                }
            )
            # doc:end upstream
        except (OpenAIError, httpx.HTTPError, ValueError, TypeError, OSError) as error:
            log("dispatch_failed", award_id=body["award_id"], error=type(error).__name__)
            if request.transport is not None and not request.transport.is_closing():
                await emit(
                    {
                        "type": "failed",
                        "code": "upstream_failed",
                        "message": "the upstream did not return a valid text response",
                    }
                )
        return response


def main() -> None:
    try:
        settings = Settings.from_env(os.environ)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    log("reference_version", version=VERSION)
    host, port = settings.dispatch_bind.rsplit(":", 1)
    addresses = socket.getaddrinfo(host, int(port), type=socket.SOCK_STREAM)
    with ExitStack() as stack:
        listeners = []
        seen = set()
        for family, _, _, _, address in addresses:
            if (family, address) in seen:
                continue
            seen.add((family, address))
            listener = stack.enter_context(socket.create_server(address, family=family))
            listeners.append(listener)
            bound = listener.getsockname()
            log("dispatch_bound", host=bound[0], port=bound[1])
        web.run_app(
            Runtime(settings).application(),
            sock=listeners,
            shutdown_timeout=settings.shutdown_timeout,
            handler_cancellation=True,
            print=None,
        )


if __name__ == "__main__":
    main()
