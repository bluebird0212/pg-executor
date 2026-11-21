"""PG Bridge —— 让浏览器里的 AI Studio 变成标准 Gemini API。

本服务只做三件事：
1. 把第三方客户端发来的 Gemini 请求编码成 AI Studio 的 wire 格式；
2. 通过长轮询把任务交给浏览器里的油猴脚本执行；
3. 把执行器抓回来的原始响应解析成标准 Gemini JSON / SSE。

上游请求由浏览器页面上下文发出，因此不需要 Cookie、不需要签名字节点。
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

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

DEFAULT_MODELS = [
    ("gemini-3.8-flash", "Gemini 3.8 Flash"),
    ("gemini-3.7-flash", "Gemini 3.7 Flash (默认)"),
    ("gemini-3.6-flash", "Gemini 3.6 Flash"),
    ("gemini-3.5-flash", "Gemini 3.5 Flash"),
    ("gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite"),
    ("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview"),
    ("gemini-3.1-flash-image", "Nano Banana 2 (图片)"),
    ("gemini-3-pro-image", "Nano Banana Pro (图片)"),
    ("gemini-flash-latest", "Gemini Flash Latest"),
    ("gemini-pro-latest", "Gemini Pro Latest"),
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

    def submit(self, job: Job) -> None:
        self.jobs[job.id] = job
        self.queue.put_nowait(job.id)
        self.total_tasks += 1


hub = ExecutorHub()

app = FastAPI(title="PG Bridge", docs_url=None, redoc_url=None)
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
        "executor": {
            "online": hub.online,
            "name": hub.name,
            "version": hub.version,
            "models": hub.models,
            "lastSeenAgo": round(time.time() - hub.last_seen, 1) if hub.last_seen else None,
            "connectedSeconds": int(time.time() - hub.connected_at) if hub.connected_at else 0,
            "totalTasks": hub.total_tasks,
            "cache": hub.cache,
        },
        "activeJobs": len(jobs),
        "models": [{"id": mid, "displayName": name} for mid, name in DEFAULT_MODELS],
    }


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
                "description": "Served through PG Bridge browser executor",
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


def _prepare_job(model: str, body: dict[str, Any], stream: bool) -> tuple[Job, str]:
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
    if candidate.thinking:
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
    if candidate.reasoning_images:
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
    if candidate.function_calls:
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
    if candidate.images:
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
    elif candidate.text_signature or candidate.standalone_signature:
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


async def _stream_job(job: Job, body: dict[str, Any]):
    parser = IncrementalJSONStreamParser()
    state: dict[str, Any] = {"usage": {}, "finish": None, "response_id": None}
    deadline = time.monotonic() + JOB_TIMEOUT
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                yield _sse_error(504, "执行器超时未返回结果")
                return
            try:
                event = await asyncio.wait_for(
                    job.events.get(), timeout=min(KEEPALIVE, remaining)
                )
            except (asyncio.TimeoutError, TimeoutError):
                if not hub.online:
                    yield _sse_error(503, "浏览器执行器已离线，请检查 AI Studio 页面")
                    return
                if deadline - time.monotonic() <= 0:
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
                    for line in _chunk_events(parsed, state, job.model):
                        yield line
            elif kind == "response":
                raw = str(event.get("rawResponse") or "")
                if not raw.strip():
                    yield _sse_error(502, "上游返回空内容")
                    return
                for parsed in parser.feed(raw):
                    for line in _chunk_events(parsed, state, job.model):
                        yield line
                for parsed in parser.finish():
                    for line in _chunk_events(parsed, state, job.model):
                        yield line
                yield _finish_sse(state, job.model)
                return
            elif kind == "end":
                for parsed in parser.finish():
                    for line in _chunk_events(parsed, state, job.model):
                        yield line
                yield _finish_sse(state, job.model)
                return
            elif kind == "error":
                status, message = _upstream_error(event)
                yield _sse_error(status, message)
                return
    finally:
        job.cancelled = True
        hub.jobs.pop(job.id, None)


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
<title>PG Bridge 控制台</title>
<style>
:root{color-scheme:dark}
body{margin:0;font:14px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
background:#0f1217;color:#e7eaf0;padding:24px;display:flex;justify-content:center}
main{width:min(760px,100%)}
h1{font-size:20px;margin:0 0 4px}
p.sub{color:#7b8494;margin:0 0 20px;font-size:13px}
.card{background:#161a21;border:1px solid #252b36;border-radius:12px;padding:16px 18px;margin-bottom:14px}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dot{width:9px;height:9px;border-radius:50%;background:#7b8494}
.dot.ok{background:#3ddc97;box-shadow:0 0 0 4px rgba(61,220,151,.15)}
.dot.err{background:#ff6b6b}
code{background:#1d222b;padding:2px 6px;border-radius:5px;font-family:ui-monospace,Consolas,monospace;font-size:12.5px}
table{width:100%;border-collapse:collapse}
td{padding:6px 0;border-bottom:1px solid #222836;font-size:13px}
td:first-child{color:#7b8494;width:140px}
a{color:#6aa9ff}
.kv{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}
</style>
</head>
<body><main>
<h1>PG Bridge</h1>
<p class="sub">浏览器 AI Studio → 标准 Gemini API。保持 AI Studio 标签页打开即可。</p>
<div class="card">
  <div class="row"><span class="dot" id="dot"></span><b id="state">读取中…</b>
  <span id="meta" style="color:#7b8494;font-size:12px"></span></div>
</div>
<div class="card">
  <div class="kv"><b>给客户端填写的地址</b></div>
  <table>
    <tr><td>API Base URL</td><td><code id="base"></code></td></tr>
    <tr><td>协议</td><td>Google Gemini（不要选 OpenAI 格式）</td></tr>
    <tr><td>API Key</td><td>随意填任意非空字符</td></tr>
    <tr><td>SillyTavern</td><td>来源选 Google AI Studio，代理地址填上面的 Base URL</td></tr>
  </table>
</div>
<div class="card">
  <div class="kv"><b>浏览器执行器</b><span id="cache" style="color:#7b8494;font-size:12px"></span></div>
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
    document.getElementById('cache').textContent=e.cache&&e.cache.ts?('缓存 '+new Date(e.cache.ts).toLocaleString()):'无缓存';
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
    print(f"PG Bridge 正在启动: http://{HOST}:{PORT}")
    print(f"客户端 Base URL: http://127.0.0.1:{PORT}/v1beta")
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    main()
