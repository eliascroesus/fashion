"""The fingerprint service's routes.

    GET  /health        no secret; Fly's health check
    POST /embed-image   { url, boxes? }  -> one fingerprint per box (or the whole photo)
    POST /embed-text    { text }         -> one fingerprint

Everything but /health needs `Authorization: Bearer <EMBEDDER_SECRET>`. Errors match the
API's (apps/api/src/errors.ts): { "error": { "code", "message", "requestId", "details"? } },
codes from API_ERROR_CODES, 400 for a bad request.
"""

import hmac
import logging
import time
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Annotated, Any

import httpx
import sentry_sdk
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration
from starlette.exceptions import HTTPException as StarletteHTTPException

from embedder import images
from embedder.fetch import FetchError, Resolver, fetch_bytes, new_client, system_resolver
from embedder.model import DIMENSIONS, Embedder, FashionSigLIP
from embedder.settings import Settings, load_settings

log = logging.getLogger("embedder")

MAX_BOXES = 20
MAX_TEXT = 200
MAX_BODY_BYTES = 64 * 1024
OPEN_PATHS = {"/health"}

# strict: "0.5" or true is a mistake, not a number.
Fraction = Annotated[float, Field(ge=0, le=1, allow_inf_nan=False, strict=True)]


class Box(BaseModel):
    """A part of the photo in fractions of its size, like `garments` boxes."""

    model_config = ConfigDict(extra="forbid")
    left: Fraction
    top: Fraction
    right: Fraction
    bottom: Fraction

    @model_validator(mode="after")
    def has_size(self) -> "Box":
        if not (self.left < self.right and self.top < self.bottom):
            raise ValueError("A box needs right > left and bottom > top.")
        return self


class ImageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(max_length=2048)
    boxes: list[Box] | None = Field(default=None, min_length=1, max_length=MAX_BOXES)


class TextRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(max_length=MAX_TEXT)

    @field_validator("text")
    @classmethod
    def not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Text can't be empty.")
        return value.strip()


class Timing(BaseModel):
    # camelCase: the API (TypeScript) reads this JSON.
    downloadMs: int
    inferenceMs: int


class ImageResponse(BaseModel):
    model: str
    embeddings: list[list[float]]
    timing: Timing


class TextResponse(BaseModel):
    model: str
    embedding: list[float]
    timing: Timing


def _rounded(vector: list[float]) -> list[float]:
    # Six decimals is far more than the database keeps (half precision) and halves the JSON.
    return [round(x, 6) for x in vector]


def _ms(since: float) -> int:
    return round((time.perf_counter() - since) * 1000)


def _error(request: Request, status: int, code: str, message: str, details: Any = None):
    request_id = getattr(request.state, "request_id", "")
    body: dict[str, Any] = {"code": code, "message": message, "requestId": request_id}
    if details is not None:
        body["details"] = details
    return JSONResponse({"error": body}, status_code=status, headers={"x-request-id": request_id})


def create_app(
    settings: Settings,
    *,
    load_embedder: Callable[[], Embedder] | None = None,
    http_client: httpx.Client | None = None,
    resolve: Resolver = system_resolver,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Loaded before the port opens, so a request that wakes the machine waits for the
        # model instead of failing.
        started = time.perf_counter()
        app.state.embedder = (load_embedder or (lambda: FashionSigLIP(settings.model_dir)))()
        app.state.http = http_client or new_client()
        log.info("model %s ready in %d ms", app.state.embedder.name, _ms(started))
        try:
            yield
        finally:
            app.state.http.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    expected = f"Bearer {settings.secret}".encode()

    @app.middleware("http")
    async def guard(request: Request, call_next):
        request.state.request_id = uuid.uuid4().hex
        if request.url.path not in OPEN_PATHS:
            given = request.headers.get("authorization", "").encode()
            if not hmac.compare_digest(given, expected):
                return _error(request, 401, "unauthorized", "Missing or wrong secret.")
            declared = request.headers.get("content-length", "")
            if declared.isdigit() and int(declared) > MAX_BODY_BYTES:
                return _error(request, 413, "payload_too_large", "The request is too large.")
        response = await call_next(request)
        response.headers["x-request-id"] = request.state.request_id
        return response

    @app.exception_handler(FetchError)
    async def fetch_error(request: Request, error: FetchError):
        return _error(request, error.status, error.code, error.message)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, error: RequestValidationError):
        details = [
            # Paths inside the body, dotted like the API's ("boxes.0.left").
            {
                "path": ".".join(str(p) for p in e["loc"][e["loc"][:1] == ("body",) :]),
                "message": e["msg"],
            }
            for e in error.errors()
        ]
        return _error(request, 400, "validation_failed", "The request isn't valid.", details)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, error: StarletteHTTPException):
        if error.status_code in (404, 405):
            return _error(request, 404, "not_found", "Not found.")
        return _error(request, 400, "validation_failed", str(error.detail))

    @app.exception_handler(Exception)
    async def crash(request: Request, error: Exception):
        sentry_sdk.capture_exception(error)
        log.exception("request %s failed", request.state.request_id)
        return _error(request, 500, "internal_error", "Something went wrong.")

    @app.get("/health")
    def health(request: Request) -> dict[str, Any]:
        return {"status": "ok", "model": request.app.state.embedder.name, "dimensions": DIMENSIONS}

    @app.post("/embed-image")
    def embed_image(body: ImageRequest, request: Request) -> ImageResponse:
        state = request.app.state
        started = time.perf_counter()
        data = fetch_bytes(
            body.url, client=state.http, allowed_hosts=settings.image_hosts, resolve=resolve
        )
        photo = images.decode(data)
        pictures = (
            [images.crop(photo, b.left, b.top, b.right, b.bottom) for b in body.boxes]
            if body.boxes
            else [photo]
        )
        download_ms = _ms(started)
        started = time.perf_counter()
        vectors = state.embedder.embed_images(pictures)
        return ImageResponse(
            model=state.embedder.name,
            embeddings=[_rounded(v) for v in vectors],
            timing=Timing(downloadMs=download_ms, inferenceMs=_ms(started)),
        )

    @app.post("/embed-text")
    def embed_text(body: TextRequest, request: Request) -> TextResponse:
        embedder = request.app.state.embedder
        started = time.perf_counter()
        vector = embedder.embed_text(body.text)
        return TextResponse(
            model=embedder.name,
            embedding=_rounded(vector),
            timing=Timing(downloadMs=0, inferenceMs=_ms(started)),
        )

    return app


def _without_request(event: dict[str, Any], _hint: dict[str, Any]) -> dict[str, Any]:
    # The secret travels in a header; bodies and links aren't ours to keep.
    event.pop("request", None)
    return event


def init_sentry(settings: Settings, **test_options: Any) -> None:
    """Server errors only. Never the secret: no request data, no variable values from the
    stack (they hold the secret and the ASGI headers), no breadcrumbs (they hold links)."""
    if not settings.sentry_dsn:
        return
    server_errors = set(range(500, 600))
    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=settings.sentry_environment,
        # Like the API's Sentry: no user details, cookies, headers, bodies or query strings,
        # and no variable values from the stack.
        data_collection={
            "user_info": False,
            "cookies": {"mode": "off"},
            "http_headers": {"request": {"mode": "off"}},
            "http_bodies": [],
            "url_query_params": {"mode": "off"},
            "stack_frame_variables": False,
        },
        max_breadcrumbs=0,
        traces_sample_rate=0,
        max_request_body_size="never",
        before_send=_without_request,
        integrations=[
            StarletteIntegration(failed_request_status_codes=server_errors),
            FastApiIntegration(failed_request_status_codes=server_errors),
        ],
        **test_options,
    )
    sentry_sdk.set_tag("service", "embedder")


def build() -> FastAPI:
    """Entry point: `uvicorn embedder.app:build --factory`."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    settings = load_settings()
    init_sentry(settings)
    return create_app(settings)
