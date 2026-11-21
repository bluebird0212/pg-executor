"""Bluebird PG —— 让浏览器里的 AI Studio 变成标准 Gemini API。

本服务只做三件事：
1. 把第三方客户端发来的 Gemini 请求编码成 AI Studio 的 wire 格式；
2. 通过长轮询把任务交给浏览器里的油猴脚本执行；
3. 把执行器抓回来的原始响应解析成标准 Gemini JSON / SSE。

上游请求由浏览器页面上下文发出，因此不需要 Cookie、不需要签名字节点。
"""

from __future__ import annotations

import asyncio
import copy
import json
import os
import random
import re
import socket
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# 打包成 exe 后，把 aistudio-api 的配置/数据目录放到用户目录，避免写入只读的临时解包目录
if getattr(sys, "frozen", False):
    _base_dir = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "pg-bridge"
    _data_dir = _base_dir / "data"
    _config_file = _base_dir / "config.yaml"
    try:
        _data_dir.mkdir(parents=True, exist_ok=True)
        if not _config_file.exists():
            _config_file.write_text("{}\n", encoding="utf-8")
        os.environ.setdefault("AISTUDIO_DATA_DIR", str(_data_dir))
        os.environ.setdefault("AISTUDIO_CONFIG_FILE", str(_config_file))
    except OSError:
        pass

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse

from aistudio_api.api.response_models import (
    GeminiCandidateResponse,
    GeminiContentResponse,
    GeminiGenerateContentResponse,
)
from aistudio_api.api.responses import to_gemini_parts, to_gemini_usage_metadata
from aistudio_api.api.schemas import GeminiGenerateContentRequest
from aistudio_api.application.api_service_gemini import (
    format_sse_event,
    format_sse_usage,
    to_gemini_finish_reason,
)
from aistudio_api.application.chat_service import normalize_gemini_request
from aistudio_api.infrastructure.gateway.stream_parser import IncrementalJSONStreamParser
from aistudio_api.infrastructure.gateway.wire_codec import encode_request_body
from aistudio_api.infrastructure.gateway.wire_spec import WIRE_FINISH_REASON_CONTINUING
from aistudio_api.infrastructure.gateway.wire_parser import (
    WIRE_RESPONSE_ID_INDEX,
    parse_chunk_usage,
    parse_response_chunk,
    parse_text_output,
)
from aistudio_api.infrastructure.waa.signer import extract_content_digest

HOST = os.getenv("PG_HOST", "127.0.0.1")
PORT = int(os.getenv("PG_PORT", "8090"))
JOB_TIMEOUT = float(os.getenv("PG_JOB_TIMEOUT", "300"))
EXECUTOR_STALE = float(os.getenv("PG_EXECUTOR_STALE", "45"))
POLL_WAIT = float(os.getenv("PG_POLL_WAIT", "25"))
KEEPALIVE = float(os.getenv("PG_SSE_KEEPALIVE", "15"))
ACCESS_TOKEN = os.getenv("PG_TOKEN", "").strip()


def _env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in ("0", "false", "off", "no", "")


# 运行时开关（面板可以修改）
SETTINGS = {
    "shield": _env_flag("PG_SHIELD", True),
    "shield_mode": "standard" if os.getenv("PG_SHIELD_MODE", "").lower() == "standard" else "deep",
    "anti_truncate": _env_flag("PG_ANTI_TRUNCATE", True),
}


# --------------------------------------------------------------------------
# 防路由护盾（移植自「通用 Gemini 防路由护盾 v3.2」，适配无酒馆上下文的服务端）
# --------------------------------------------------------------------------

_SAFE_LETTERS = "bcdfghjklmnpqrstvxzBCDFGHJKLMNPQRSTVXZ"
_SAFE_DIGITS = "0123456789"
_COMMENT_OPEN = "<" + "!" + "-- "
_COMMENT_CLOSE = " --" + ">"

_MARKER_RE = re.compile(
    r"(?:\{\{|\[|<)?[ \t]*(?:izumi[ \t_-]*|gemini[ \t_-]*)?anti[ \t_-]*route[ \t]*(?:\}\}|\]|\/?>)?",
    re.I,
)
_PROTECTED_RE = re.compile(
    r"\[\[IZUMI_CHAT_INDEX_V1\]\]"
    r"|<\s*\/?\s*(?:customfunction|worldcustomfunction|worldsystem|KonataExtraInformation|IzumiEdit"
    r"|UpdateVariable|JSONPatch|mvu|stat_data|delta_data|variables|StatusPlaceHolderImpl)\b"
    r"|IZW7_|IZM7_",
    re.I,
)

# 固定套话同义微替换（只动常见预设锚点，改变分词边界）
_SIGNATURE_VARIANTS: list[tuple[str, list[str]]] = [
    ("请严格遵守以下创作规则", ["请严格遵守以下创作规则", "请务必遵循下述创作规则", "请严格按照以下创作规范执行", "请认真遵守下列创作准则"]),
    ("接下来请根据以上设定", ["接下来请根据以上设定", "下面请依据上述设定", "接下来请结合上方设定", "随后请按照以上背景与设定"]),
    ("正式开始创作前，请先进行思考", ["正式开始创作前，请先进行思考", "在正式动笔创作前，请先展开构思", "正式开始撰写正文前，请先理清思路", "开始正式创作之前，请先进行推演"]),
    ("正文必须使用简体中文", ["正文必须使用简体中文", "正文部分须采用简体中文", "正文内容必须以简体中文撰写", "请确保正文使用简体中文"]),
    ("专注调制特调饮品一样", ["专注调制特调饮品一样", "专注调配特调酒饮一样", "专心调制特调饮品那样", "专注调制专属特调一样"]),
    ("抽丝剥茧摸清故事脉络", ["抽丝剥茧摸清故事脉络", "抽丝剥茧理清故事脉络", "抽丝剥茧梳理剧情脉络", "丝丝入扣摸清故事脉络"]),
    ("把你的故事和设定推过来吧，我的杯子已经准备好了", ["把你的故事和设定推过来吧，我的杯子已经准备好了", "把你的设定和故事推过来吧，酒杯已经准备好了", "把故事与设定推过来吧，我的调酒杯已经就绪了", "把你的故事和设定端过来吧，我的杯子已经备好了"]),
    ("那我们来看分为两部分的创作规则吧", ["那我们来看分为两部分的创作规则吧", "那么我们来看看分为两个部分的创作规则吧", "那我们先来看由两部分组成的创作规则吧", "接下来我们看分为两部分的创作规则吧"]),
]


def _rand_int(min_v: int, max_v: int) -> int:
    return random.randint(min_v, max(min_v, max_v))


def _random_safe_token(length: int) -> str:
    chars: list[str] = []
    for _ in range(length):
        pool = _SAFE_DIGITS if random.random() < 0.30 else _SAFE_LETTERS
        chars.append(random.choice(pool))
    if length >= 2:
        if not any(ch in _SAFE_DIGITS for ch in chars):
            chars[random.randrange(length)] = random.choice(_SAFE_DIGITS)
        if not any(ch in _SAFE_LETTERS for ch in chars):
            chars[random.randrange(length)] = random.choice(_SAFE_LETTERS)
    return "".join(chars)


def _build_comment_block(count_min: int, count_max: int, char_min: int, char_max: int) -> str:
    count = _rand_int(count_min, count_max)
    parts = [
        _COMMENT_OPEN + _random_safe_token(_rand_int(char_min, char_max)) + _COMMENT_CLOSE
        for _ in range(count)
    ]
    return "".join(parts)


def _micro_jitter(text: str) -> str:
    if not isinstance(text, str) or len(text) < 20:
        return text
    out = text
    for needle, choices in _SIGNATURE_VARIANTS:
        if needle in out:
            out = out.replace(needle, random.choice(choices))
    lines = out.split("\n")
    if len(lines) > 2:
        for i in range(len(lines) - 1):
            line = lines[i]
            if len(line) > 10 and not line.rstrip().endswith((">", "}", "%")) and random.random() < 0.45:
                lines[i] = line + " " * _rand_int(1, 3)
        out = "\n".join(lines)
    return out


def _shield_text(text: str, prefix: str, suffix: str, mode: str) -> str:
    if not isinstance(text, str):
        return text
    if _MARKER_RE.search(text):
        text = _MARKER_RE.sub(
            lambda _m: _build_comment_block(15, 45, 16, 42), text
        )
    if mode == "deep":
        text = _micro_jitter(text)
    if prefix:
        text = prefix + text
    if suffix:
        text = text + suffix
    return text


def _parts_text(content: dict[str, Any]) -> str:
    parts = content.get("parts")
    if not isinstance(parts, list):
        return ""
    return "".join(
        p.get("text") or ""
        for p in parts
        if isinstance(p, dict) and isinstance(p.get("text"), str)
    )


def apply_anti_route_shield(body: dict[str, Any]) -> None:
    """在编码前对 Gemini 请求做防路由混淆，直接原地修改 body。"""
    if not SETTINGS.get("shield"):
        return
    mode = SETTINGS.get("shield_mode") or "deep"
    system = body.get("systemInstruction") or body.get("system_instruction")
    contents = body.get("contents")
    if not isinstance(contents, list):
        contents = []

    first_system = False
    first_user = False
    first_model = False

    # 保护段 ∪ 尾部定位：最后一个可改写的内容块
    last_idx = -1
    for i in range(len(contents) - 1, -1, -1):
        item = contents[i]
        if not isinstance(item, dict):
            continue
        text = _parts_text(item)
        if text.strip() and not _PROTECTED_RE.search(text):
            last_idx = i
            break

    # systemInstruction：单独在首部注入混淆注释
    if isinstance(system, dict):
        parts = system.get("parts")
        if isinstance(parts, list):
            for part in parts:
                if not isinstance(part, dict):
                    continue
                text = part.get("text")
                if not isinstance(text, str) or not text.strip() or _PROTECTED_RE.search(text):
                    continue
                prefix = ""
                if not first_system:
                    first_system = True
                    prefix = _build_comment_block(16, 36, 16, 42) + "\n"
                part["text"] = _shield_text(text, prefix, "", mode)

    for idx, item in enumerate(contents):
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip().lower()
        parts = item.get("parts")
        if not isinstance(parts, list):
            continue
        is_last = idx == last_idx
        for part in parts:
            if not isinstance(part, dict):
                continue
            text = part.get("text")
            if not isinstance(text, str) or not text.strip():
                continue
            # 函数调用 / 图片 / 受保护块一律不改
            if part.get("functionCall") or part.get("functionResponse") or part.get("inlineData"):
                continue
            if _PROTECTED_RE.search(text):
                continue
            has_advice = "<advice" in text.lower() or "按照advice继续" in text

            prefix = ""
            suffix = ""
            if role == "system":
                if not first_system:
                    first_system = True
                    prefix = _build_comment_block(16, 36, 16, 42) + "\n"
                elif mode == "deep" and is_last:
                    suffix = "\n" + _build_comment_block(8, 20, 16, 42)
            elif role in ("user", "human"):
                if not first_user:
                    first_user = True
                    prefix = _build_comment_block(8, 20, 16, 42) + "\n"
                elif mode == "deep" and is_last:
                    suffix = "\n" + _build_comment_block(8, 20, 16, 42)
                elif mode == "deep" and len(text) >= 150 and not has_advice:
                    prefix = _build_comment_block(4, 10, 16, 42) + "\n"
            elif role in ("model", "assistant", "ai"):
                if not first_model:
                    first_model = True
                    prefix = _build_comment_block(8, 20, 16, 42) + "\n"
                elif mode == "deep" and is_last:
                    suffix = "\n" + _build_comment_block(8, 20, 16, 42)

            if not prefix and not suffix and mode != "deep":
                continue
            part["text"] = _shield_text(text, prefix, suffix, mode)


def _lan_addresses() -> list[str]:
    """列出本机的局域网 IPv4（优先返回默认出口网卡地址）。"""
    now = time.time()
    cached = getattr(_lan_addresses, "_cache", None)
    if cached and now - cached[0] < 30:
        return cached[1]
    ips: list[str] = []
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.connect(("8.8.8.8", 80))
            ips.append(sock.getsockname()[0])
        finally:
            sock.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = str(info[4][0])
            if ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    ips = [ip for ip in ips if ip and not ip.startswith("127.")]
    _lan_addresses._cache = (now, ips)
    return ips


DEFAULT_MODELS = [
    ("gemini-flash-latest", "Gemini Flash Latest (默认)"),
    ("gemini-pro-latest", "Gemini Pro Latest"),
    ("gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite"),
    ("gemini-3.8-flash", "Gemini 3.8 Flash"),
    ("gemini-3.7-flash", "Gemini 3.7 Flash"),
    ("gemini-3.6-flash", "Gemini 3.6 Flash"),
    ("gemini-3.5-flash", "Gemini 3.5 Flash"),
    ("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview"),
    ("gemini-3.1-flash-image", "Nano Banana 2 (图片)"),
    ("gemini-3-pro-image", "Nano Banana Pro (图片)"),
]


@dataclass
class Job:
    id: str
    model: str
    stream: bool
    request_body: str = ""
    created: float = field(default_factory=time.time)
    events: asyncio.Queue = field(default_factory=asyncio.Queue)
    cancelled: bool = False
    finished: bool = False
    ack_at: float = 0.0


class ExecutorHub:
    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.last_seen = 0.0
        self.connected_at = 0.0
        self.name = ""
        self.version = ""
        self.models: list[str] = []
        self.cache: dict[str, Any] | None = None
        self.caches: list[dict[str, Any]] = []
        self.total_tasks = 0

    @property
    def online(self) -> bool:
        if self.last_seen and (time.time() - self.last_seen) < EXECUTOR_STALE:
            return True
        return any(
            not job.finished
            and not job.cancelled
            and job.ack_at
            and (time.time() - job.ack_at) < JOB_TIMEOUT
            for job in self.jobs.values()
        )

    def touch(self, payload: dict[str, Any]) -> None:
        now = time.time()
        if not self.online:
            self.connected_at = now
        self.last_seen = now
        self.name = str(payload.get("name") or self.name or "browser")
        self.version = str(payload.get("version") or self.version or "")
        raw_models = payload.get("models")
        if isinstance(raw_models, list):
            self.models = [str(m) for m in raw_models if str(m).strip()]
        cache = payload.get("cache")
        if isinstance(cache, dict):
            self.cache = cache
        caches = payload.get("caches")
        if isinstance(caches, list):
            self.caches = [c for c in caches if isinstance(c, dict)][:10]
            if self.caches:
                self.cache = self.caches[0]

    def submit(self, job: Job) -> None:
        self.jobs[job.id] = job
        self.queue.put_nowait(job.id)
        self.total_tasks += 1


hub = ExecutorHub()

app = FastAPI(title="Bluebird PG", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------
# 执行器通道
# --------------------------------------------------------------------------


@app.post("/api/executor/poll")
async def executor_poll(request: Request) -> Response:
    """浏览器执行器长轮询要任务。"""
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    hub.touch(payload)

    deadline = time.monotonic() + POLL_WAIT
    while time.monotonic() < deadline:
        timeout = max(0.1, deadline - time.monotonic())
        try:
            job_id = await asyncio.wait_for(hub.queue.get(), timeout=timeout)
        except (asyncio.TimeoutError, TimeoutError):
            break
        job = hub.jobs.get(job_id)
        if job is None or job.cancelled:
            continue
        return JSONResponse(
            {
                "ok": True,
                "task": {
                    "id": job.id,
                    "model": job.model,
                    "stream": job.stream,
                    "requestBody": job.request_body,
                },
            }
        )
    return Response(status_code=204)


@app.post("/api/executor/result")
async def executor_result(request: Request) -> Response:
    """浏览器执行器回传结果。"""
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "invalid json"}, status_code=400)
    if not isinstance(payload, dict):
        return JSONResponse({"ok": False, "error": "invalid payload"}, status_code=400)
    hub.touch(payload)
    job_id = str(payload.get("id") or "")
    job = hub.jobs.get(job_id)
    if job is None:
        return JSONResponse({"ok": True, "ignored": "unknown job"})
    kind = str(payload.get("kind") or "")
    if job.cancelled:
        return JSONResponse({"ok": True, "ignored": "cancelled"})
    if kind == "ack":
        job.ack_at = time.time()
        return JSONResponse({"ok": True})
    await job.events.put(payload)
    if kind in ("response", "end", "error"):
        job.finished = True
    return JSONResponse({"ok": True})


@app.get("/api/status")
async def status() -> dict[str, Any]:
    jobs = [j for j in hub.jobs.values() if not j.finished and not j.cancelled]
    return {
        "ok": True,
        "network": {"port": PORT, "lan": _lan_addresses()},
        "shield": {
            "enabled": bool(SETTINGS.get("shield")),
            "mode": SETTINGS.get("shield_mode") or "deep",
        },
        "antiTruncate": bool(SETTINGS.get("anti_truncate")),
        "executor": {
            "online": hub.online,
            "name": hub.name,
            "version": hub.version,
            "models": hub.models,
            "lastSeenAgo": round(time.time() - hub.last_seen, 1) if hub.last_seen else None,
            "connectedSeconds": int(time.time() - hub.connected_at) if hub.connected_at else 0,
            "totalTasks": hub.total_tasks,
            "cache": hub.cache,
            "caches": hub.caches,
        },
        "activeJobs": len(jobs),
        "models": [{"id": mid, "displayName": name} for mid, name in DEFAULT_MODELS],
    }


@app.get("/api/shield")
async def get_shield() -> dict[str, Any]:
    return {
        "ok": True,
        "enabled": bool(SETTINGS.get("shield")),
        "mode": SETTINGS.get("shield_mode") or "deep",
        "antiTruncate": bool(SETTINGS.get("anti_truncate")),
    }


@app.post("/api/shield")
async def set_shield(request: Request) -> Response:
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    if "enabled" in payload:
        SETTINGS["shield"] = bool(payload.get("enabled"))
    if str(payload.get("mode") or "") in ("deep", "standard"):
        SETTINGS["shield_mode"] = str(payload.get("mode"))
    if "antiTruncate" in payload:
        SETTINGS["anti_truncate"] = bool(payload.get("antiTruncate"))
    return JSONResponse(
        {
            "ok": True,
            "enabled": bool(SETTINGS.get("shield")),
            "mode": SETTINGS.get("shield_mode") or "deep",
            "antiTruncate": bool(SETTINGS.get("anti_truncate")),
        }
    )


# --------------------------------------------------------------------------
# Gemini 兼容接口
# --------------------------------------------------------------------------


def _check_token(request: Request) -> None:
    if not ACCESS_TOKEN:
        return
    supplied = request.headers.get("x-api-key") or request.query_params.get("key") or ""
    if supplied != ACCESS_TOKEN:
        raise PermissionError("invalid api key")


def _grpc_status(code: int) -> str:
    return {
        400: "INVALID_ARGUMENT",
        401: "UNAUTHENTICATED",
        403: "PERMISSION_DENIED",
        404: "NOT_FOUND",
        429: "RESOURCE_EXHAUSTED",
        499: "CANCELLED",
        500: "INTERNAL",
        502: "INTERNAL",
        503: "UNAVAILABLE",
        504: "DEADLINE_EXCEEDED",
    }.get(code, "INTERNAL")


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(
        {
            "error": {
                "code": status,
                "message": message,
                "status": _grpc_status(status),
            }
        },
        status_code=status,
    )


def _model_list() -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for mid, display in DEFAULT_MODELS:
        seen.add(mid)
        out.append(
            {
                "name": f"models/{mid}",
                "displayName": display,
                "description": "Served through Bluebird PG browser executor",
                "supportedGenerationMethods": [
                    "generateContent",
                    "streamGenerateContent",
                    "countTokens",
                ],
            }
        )
    for mid in hub.models:
        if mid in seen:
            continue
        seen.add(mid)
        out.append(
            {
                "name": f"models/{mid}",
                "displayName": mid,
                "description": "Detected from AI Studio page",
                "supportedGenerationMethods": [
                    "generateContent",
                    "streamGenerateContent",
                    "countTokens",
                ],
            }
        )
    return out


@app.get("/v1beta/models")
@app.get("/v1/models")
async def list_models(request: Request) -> Response:
    try:
        _check_token(request)
    except PermissionError as exc:
        return _error(401, str(exc))
    return JSONResponse({"models": _model_list()})


@app.api_route("/v1beta/models/{model_path:path}", methods=["POST"])
@app.api_route("/v1/models/{model_path:path}", methods=["POST"])
async def model_action(model_path: str, request: Request) -> Response:
    try:
        _check_token(request)
    except PermissionError as exc:
        return _error(401, str(exc))

    action = ""
    model = model_path
    if ":" in model_path:
        model, action = model_path.rsplit(":", 1)
    model = model.strip().strip("/")
    if model.startswith("models/"):
        model = model[len("models/") :]
    if not model:
        return _error(400, "missing model name")

    if action == "countTokens":
        try:
            body = await request.json()
        except Exception:
            body = {}
        text = json.dumps(body, ensure_ascii=False)
        return JSONResponse({"totalTokens": max(1, len(text) // 4)})

    if action not in ("generateContent", "streamGenerateContent"):
        return _error(404, f"unsupported method: {action or '(none)'}")

    try:
        body = await request.json()
    except Exception:
        return _error(400, "request body must be JSON")
    if not isinstance(body, dict):
        return _error(400, "request body must be a JSON object")

    if not hub.online:
        return _error(
            503,
            "浏览器执行器未连接。请打开 AI Studio 页面并确认油猴脚本已连接本服务。",
        )

    stream = action == "streamGenerateContent"
    try:
        job, normalized_model = _prepare_job(model, body, stream)
    except Exception as exc:
        return _error(400, f"invalid Gemini request: {exc}")

    hub.submit(job)
    if stream:
        return StreamingResponse(
            _stream_job(job, body),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "Connection": "keep-alive",
            },
        )
    return await _collect_job(job, normalized_model)


def _prepare_job(
    model: str, body: dict[str, Any], stream: bool, shield: bool = True
) -> tuple[Job, str]:
    if shield:
        apply_anti_route_shield(body)
    gemini_req = GeminiGenerateContentRequest.model_validate(body)
    normalized = normalize_gemini_request(gemini_req, model)
    binding, _digest = extract_content_digest(normalized.contents)
    wire_text = encode_request_body(
        model=normalized.model,
        contents=normalized.contents,
        system_instruction_content=normalized.system_instruction,
        safety_settings=normalized.safety_settings,
        tools=normalized.tools,
        tool_config=normalized.tool_config,
        temperature=normalized.temperature,
        top_p=normalized.top_p,
        top_k=normalized.top_k,
        max_tokens=normalized.max_tokens,
        generation_config_overrides=normalized.generation_config_overrides,
        prompt=binding,
    )
    job = Job(id=uuid.uuid4().hex, model=normalized.model, stream=stream)
    job.request_body = json.dumps(
        {"wire": json.loads(wire_text), "binding": binding}, ensure_ascii=False
    )
    return job, normalized.model


async def _job_timeout(job: Job) -> None:
    job.cancelled = True
    await job.events.put(
        {
            "id": job.id,
            "kind": "error",
            "status": 504,
            "message": "执行器超时未返回结果（浏览器标签页可能被冻结）",
        }
    )


def _upstream_error(payload: dict[str, Any]) -> tuple[int, str]:
    status = int(payload.get("status") or 502)
    message = str(payload.get("message") or "browser executor failed")
    return status, message


def _response_payload(model: str, raw: str) -> dict[str, Any]:
    output = parse_text_output(raw)
    candidate = output.candidates[0] if output.candidates else None
    parts = to_gemini_parts(
        output.text,
        function_calls=output.function_calls,
        function_responses=output.function_responses,
        thinking=output.thinking,
        images=output.images,
        reasoning_images=output.reasoning_images,
        thinking_signature=candidate.thinking_signature if candidate else "",
        text_signature=candidate.text_signature if candidate else "",
        standalone_signature=candidate.standalone_signature if candidate else "",
    )
    response = GeminiGenerateContentResponse(
        candidates=[
            GeminiCandidateResponse(
                content=GeminiContentResponse(parts=parts),
                finishReason=to_gemini_finish_reason(
                    candidate.finish_reason if candidate else None
                ),
                index=0,
            )
        ],
        usageMetadata=to_gemini_usage_metadata(output.usage),
        modelVersion=model,
        responseId=output.response_id or None,
    )
    return response.model_dump(mode="json", exclude_none=True)


async def _collect_job(job: Job, model: str) -> Response:
    parser = IncrementalJSONStreamParser()
    raw_parts: list[str] = []
    try:
        deadline = time.monotonic() + JOB_TIMEOUT
        while True:
            timeout = deadline - time.monotonic()
            if timeout <= 0:
                return _error(504, "执行器超时未返回结果")
            try:
                event = await asyncio.wait_for(
                    job.events.get(), timeout=min(5.0, timeout)
                )
            except (asyncio.TimeoutError, TimeoutError):
                if not hub.online:
                    return _error(503, "浏览器执行器已离线，请检查 AI Studio 页面")
                continue
            kind = str(event.get("kind") or "")
            if kind == "response":
                raw = str(event.get("rawResponse") or "")
                if not raw.strip():
                    return _error(502, "上游返回空内容")
                return JSONResponse(_response_payload(model, raw))
            if kind == "chunk":
                raw_parts.append(str(event.get("chunkBody") or ""))
            elif kind == "end":
                raw = "".join(raw_parts)
                if not raw.strip():
                    return _error(502, "上游返回空内容")
                return JSONResponse(_response_payload(model, raw))
            elif kind == "error":
                status, message = _upstream_error(event)
                return _error(status, message)
    finally:
        job.cancelled = True
        hub.jobs.pop(job.id, None)


def _chunk_events(
    parsed: list[Any],
    state: dict[str, Any],
    model: str,
    only_text: bool = False,
) -> list[str]:
    """把一条解析后的 wire chunk 转成若干条 SSE 文本。"""
    out: list[str] = []
    usage = parse_chunk_usage(parsed)
    if usage:
        state["usage"] = usage
    if (
        isinstance(parsed, list)
        and len(parsed) > WIRE_RESPONSE_ID_INDEX
        and isinstance(parsed[WIRE_RESPONSE_ID_INDEX], str)
        and parsed[WIRE_RESPONSE_ID_INDEX]
    ):
        state["response_id"] = parsed[WIRE_RESPONSE_ID_INDEX]
    candidate = parse_response_chunk(parsed)
    response_id = state.get("response_id")
    if candidate.finish_reason is not None and candidate.finish_reason not in (
        0,
        WIRE_FINISH_REASON_CONTINUING,
    ):
        state["finish"] = candidate.finish_reason
    if candidate.thinking and not only_text:
        out.append(
            format_sse_event(
                "thinking",
                candidate.thinking,
                model_version=model,
                response_id=response_id,
                thought_signature=candidate.thinking_signature or None,
            )
            or ""
        )
    if candidate.reasoning_images and not only_text:
        out.append(
            format_sse_event(
                "reasoning_images",
                candidate.reasoning_images,
                model_version=model,
                response_id=response_id,
                thought_signature=candidate.thought_signature or None,
            )
            or ""
        )
    if candidate.function_calls and not only_text:
        out.append(
            format_sse_event(
                "tool_calls",
                candidate.function_calls,
                model_version=model,
                response_id=response_id,
                thought_signature=candidate.thought_signature or None,
            )
            or ""
        )
    if candidate.images and not only_text:
        out.append(
            format_sse_event(
                "images",
                candidate.images,
                model_version=model,
                response_id=response_id,
                thought_signature=candidate.thought_signature or None,
            )
            or ""
        )
    if candidate.text:
        state.setdefault("text_parts", []).append(candidate.text)
        out.append(
            format_sse_event(
                "body",
                candidate.text,
                model_version=model,
                response_id=response_id,
                thought_signature=candidate.text_signature or None,
            )
            or ""
        )
    elif not only_text and (candidate.text_signature or candidate.standalone_signature):
        out.append(
            format_sse_event(
                "thought_signature",
                candidate.text_signature or candidate.standalone_signature,
                model_version=model,
                response_id=response_id,
            )
            or ""
        )
    return [line for line in out if line]


async def _consume_stream(
    job: Job,
    state: dict[str, Any],
    only_text: bool,
    deadline: float,
):
    """消费一个任务的执行器事件，产出 SSE 行；结束原因写入 state。"""
    parser = IncrementalJSONStreamParser()
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            state["aborted"] = "timeout"
            yield _sse_error(504, "执行器超时未返回结果")
            return
        try:
            event = await asyncio.wait_for(
                job.events.get(), timeout=min(KEEPALIVE, remaining)
            )
        except (asyncio.TimeoutError, TimeoutError):
            if not hub.online:
                state["aborted"] = "offline"
                yield _sse_error(503, "浏览器执行器已离线，请检查 AI Studio 页面")
                return
            if deadline - time.monotonic() <= 0:
                state["aborted"] = "timeout"
                yield _sse_error(504, "执行器超时未返回结果")
                return
            yield ": keepalive\n\n"
            continue

        kind = str(event.get("kind") or "")
        if kind == "chunk":
            text = str(event.get("chunkBody") or "")
            if not text:
                continue
            for parsed in parser.feed(text):
                for line in _chunk_events(parsed, state, job.model, only_text):
                    yield line
        elif kind == "response":
            raw = str(event.get("rawResponse") or "")
            if not raw.strip():
                state["aborted"] = "empty"
                yield _sse_error(502, "上游返回空内容")
                return
            for parsed in parser.feed(raw):
                for line in _chunk_events(parsed, state, job.model, only_text):
                    yield line
            for parsed in parser.finish():
                for line in _chunk_events(parsed, state, job.model, only_text):
                    yield line
            state["ended"] = True
            return
        elif kind == "end":
            for parsed in parser.finish():
                for line in _chunk_events(parsed, state, job.model, only_text):
                    yield line
            state["ended"] = True
            return
        elif kind == "error":
            status, message = _upstream_error(event)
            state["aborted"] = "error"
            yield _sse_error(status, message)
            return


def _make_continuation_job(
    body: dict[str, Any], partial_text: str, model: str
) -> Job | None:
    """根据已生成的半截正文，构造一次「继续写」的任务。"""
    cont_body = copy.deepcopy(body)
    contents = cont_body.get("contents")
    if not isinstance(contents, list) or not contents:
        return None
    contents.append({"role": "model", "parts": [{"text": partial_text}]})
    contents.append(
        {
            "role": "user",
            "parts": [
                {
                    "text": "请紧接上文继续输出，从中断处接着写，不要重复已经输出过的内容，也不要重新开头。"
                }
            ],
        }
    )
    try:
        new_job, _model = _prepare_job(model, cont_body, True, shield=False)
    except Exception:
        return None
    hub.submit(new_job)
    return new_job


async def _stream_job(job: Job, body: dict[str, Any]):
    state: dict[str, Any] = {
        "usage": {},
        "finish": None,
        "response_id": None,
        "text_parts": [],
    }
    current = job
    try:
        async for line in _consume_stream(
            current, state, False, time.monotonic() + JOB_TIMEOUT
        ):
            yield line

        if state.get("aborted"):
            return

        # 正常结束（有 finishReason）直接收尾
        if state.get("finish") is not None:
            yield _finish_sse(state, job.model)
            return

        # 没有 finishReason → 判定为流式截断，自动续写一次
        partial = "".join(state.get("text_parts") or [])
        if SETTINGS.get("anti_truncate") and partial.strip() and len(partial) >= 30:
            next_job = _make_continuation_job(body, partial, job.model)
            if next_job is not None:
                current = next_job
                async for line in _consume_stream(
                    current, state, True, time.monotonic() + JOB_TIMEOUT
                ):
                    yield line
        yield _finish_sse(state, job.model)
    finally:
        job.cancelled = True
        hub.jobs.pop(job.id, None)
        if current is not job:
            current.cancelled = True
            hub.jobs.pop(current.id, None)


def _finish_sse(state: dict[str, Any], model: str) -> str:
    finish = to_gemini_finish_reason(
        state.get("finish") if state.get("finish") is not None else 1
    )
    return format_sse_usage(
        state.get("usage") or {},
        finish_reason=finish,
        model_version=model,
        response_id=state.get("response_id"),
    )


def _sse_error(status: int, message: str) -> str:
    return (
        "data: "
        + json.dumps(
            {
                "error": {
                    "code": status,
                    "message": message,
                    "status": _grpc_status(status),
                }
            },
            ensure_ascii=False,
        )
        + "\n\n"
    )


# --------------------------------------------------------------------------
# 控制台页面
# --------------------------------------------------------------------------


PANEL_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bluebird PG 控制台</title>
<style>
:root{color-scheme:dark}
body{margin:0;font:14px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
background:linear-gradient(160deg,#0f1622,#121b2a);color:#e7eefb;padding:24px;display:flex;justify-content:center}
main{width:min(760px,100%)}
h1{font-size:20px;margin:0 0 4px;color:#eaf2ff}
p.sub{color:#8b9bb0;margin:0 0 20px;font-size:13px}
.card{background:#17202e;border:1px solid #2a3748;border-radius:14px;padding:16px 18px;margin-bottom:14px;box-shadow:0 10px 30px rgba(0,0,0,.25)}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dot{width:9px;height:9px;border-radius:50%;background:#8b9bb0}
.dot.ok{background:#5fd3ae;box-shadow:0 0 0 4px rgba(95,211,174,.15)}
.dot.err{background:#ff8fa0}
code{background:#202b3b;padding:2px 6px;border-radius:5px;font-family:ui-monospace,Consolas,monospace;font-size:12.5px;color:#bcd2f2}
table{width:100%;border-collapse:collapse}
td{padding:6px 0;border-bottom:1px solid #263243;font-size:13px}
td:first-child{color:#8b9bb0;width:140px}
a{color:#7799cc}
.kv{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
</style>
</head>
<body><main>
<h1>Bluebird PG</h1>
<p class="sub">浏览器 AI Studio → 标准 Gemini API。保持 AI Studio 标签页打开即可。</p>
<div class="card">
  <div class="row"><span class="dot" id="dot"></span><b id="state">读取中…</b>
  <span id="meta" style="color:#8b9bb0;font-size:12px"></span></div>
</div>
<div class="card">
  <div class="kv"><b>给客户端填写的地址</b></div>
  <table>
    <tr><td>API Base URL</td><td><code id="base"></code></td></tr>
    <tr><td>局域网地址</td><td><code id="lanaddr">检测中…</code></td></tr>
    <tr><td>协议</td><td>Google Gemini（不要选 OpenAI 格式）</td></tr>
    <tr><td>API Key</td><td>随意填任意非空字符</td></tr>
    <tr><td>SillyTavern</td><td>来源选 Google AI Studio，代理地址填上面的 Base URL</td></tr>
  </table>
</div>
<div class="card">
  <div class="kv"><b>浏览器执行器</b><span id="cache" style="color:#8b9bb0;font-size:12px"></span></div>
  <table>
    <tr><td>连接状态</td><td id="exec"></td></tr>
    <tr><td>最近心跳</td><td id="seen"></td></tr>
    <tr><td>执行器模型</td><td id="emodels"></td></tr>
    <tr><td>进行中任务</td><td id="jobs"></td></tr>
  </table>
</div>
<p class="sub">油猴脚本：请在 AI Studio 页面右上角面板填写本服务地址 <code id="ws"></code> 并点击“连接”。</p>
<script>
async function tick(){
  try{
    const r=await fetch('/api/status',{cache:'no-store'});
    const s=await r.json();
    const e=s.executor||{};
    document.getElementById('dot').className='dot '+(e.online?'ok':'err');
    document.getElementById('state').textContent=e.online?'执行器已连接':'执行器未连接';
    document.getElementById('meta').textContent=e.online?('本次连接 '+e.connectedSeconds+' 秒 · 累计 '+e.totalTasks+' 个任务'):'请在 AI Studio 页面打开油猴脚本';
    document.getElementById('exec').textContent=e.online?'在线':'离线';
    document.getElementById('seen').textContent=e.lastSeenAgo==null?'—':(e.lastSeenAgo+' 秒前');
    document.getElementById('emodels').textContent=(e.models&&e.models.length)?e.models.join(' / '):'使用内置模型列表';
    document.getElementById('jobs').textContent=s.activeJobs||0;
    const cl=(e.caches&&e.caches.length)?e.caches.length:0;
    document.getElementById('cache').textContent=cl?('缓存 '+cl+' 份'+(e.cache&&e.cache.ts?' · 最新 '+new Date(e.cache.ts).toLocaleTimeString():'')):'无缓存';
    const net=s.network||{};
    if(net.lan&&net.lan.length){document.getElementById('lanaddr').textContent='http://'+net.lan[0]+':'+(net.port||8090)+'/v1beta';}
    else{document.getElementById('lanaddr').textContent='仅本机可用（127.0.0.1）';}
  }catch(err){
    document.getElementById('dot').className='dot err';
    document.getElementById('state').textContent='无法连接本服务';
  }
}
document.getElementById('base').textContent=location.origin+'/v1beta';
document.getElementById('ws').textContent=location.origin;
tick();setInterval(tick,3000);
</script>
</main></body></html>"""


@app.get("/", response_class=HTMLResponse)
async def index() -> HTMLResponse:
    return HTMLResponse(PANEL_HTML)


def main() -> None:
    if os.name == "nt":
        try:
            os.system("chcp 65001 >nul")
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    print("=" * 52)
    print(f"Bluebird PG 正在启动: http://{HOST}:{PORT}")
    print(f"客户端 Base URL: http://127.0.0.1:{PORT}/v1beta")
    print("请不要关闭这个窗口；关闭窗口即停止服务。")
    print("=" * 52)
    if getattr(sys, "frozen", False) and os.getenv("PG_NO_BROWSER", "") != "1":
        import threading
        import webbrowser

        threading.Timer(1.5, lambda: webbrowser.open(f"http://127.0.0.1:{PORT}/")).start()
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    main()
