"""Settings from the environment. The server refuses to start without a proper secret."""

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

# services/embedder/models when run from the repo; the Docker image sets MODEL_DIR.
DEFAULT_MODEL_DIR = Path(__file__).resolve().parents[2] / "models"
MIN_SECRET_LENGTH = 32


@dataclass(frozen=True)
class Settings:
    secret: str = field(repr=False)
    """Callers send it as `Authorization: Bearer <secret>`. Never printed or logged."""
    image_hosts: frozenset[str]
    """The only sites photos may be downloaded from (our photo CDN)."""
    model_dir: Path
    sentry_dsn: str | None
    sentry_environment: str | None


class SettingsError(Exception):
    pass


def model_dir_from_env(env: Mapping[str, str] = os.environ) -> Path:
    return Path(env.get("MODEL_DIR") or DEFAULT_MODEL_DIR)


def load_settings(env: Mapping[str, str] = os.environ) -> Settings:
    secret = env.get("EMBEDDER_SECRET", "")
    if len(secret) < MIN_SECRET_LENGTH:
        raise SettingsError(f"EMBEDDER_SECRET must be at least {MIN_SECRET_LENGTH} characters.")
    hosts = frozenset(
        h.strip().lower() for h in env.get("EMBEDDER_IMAGE_HOSTS", "").split(",") if h.strip()
    )
    if not hosts:
        raise SettingsError("EMBEDDER_IMAGE_HOSTS must list the photo host(s), comma-separated.")
    return Settings(
        secret=secret,
        image_hosts=hosts,
        model_dir=model_dir_from_env(env),
        sentry_dsn=env.get("SENTRY_DSN") or None,
        sentry_environment=env.get("SENTRY_ENVIRONMENT") or None,
    )
