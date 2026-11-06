"""Marqo-FashionSigLIP on CPU: pictures or words in, fingerprints (768 numbers, length 1) out."""

import os
import threading
from pathlib import Path
from typing import Protocol

import open_clip
import torch
from PIL import Image

from embedder.download_model import MODEL_ID, MODEL_REVISION

DIMENSIONS = 768
MODEL_NAME = f"{MODEL_ID}@{MODEL_REVISION[:7]}"


class Embedder(Protocol):
    name: str

    def embed_images(self, images: list[Image.Image]) -> list[list[float]]: ...

    def embed_text(self, text: str) -> list[float]: ...


class FashionSigLIP:
    """Loaded once at startup from MODEL_DIR (never downloads). One inference at a time:
    torch already uses every CPU thread, so running two at once only slows both down."""

    name = MODEL_NAME

    def __init__(self, model_dir: Path) -> None:
        torch.set_num_threads(os.cpu_count() or 1)
        source = f"local-dir:{model_dir}"
        model, _, preprocess = open_clip.create_model_and_transforms(source)
        model.eval()
        self._model = model
        self._preprocess = preprocess
        self._tokenizer = open_clip.get_tokenizer(source)
        self._lock = threading.Lock()
        # The first pass is slow (memory, kernels); pay it before the first request.
        self.embed_images([Image.new("RGB", (224, 224))])
        self.embed_text("warm up")

    def embed_images(self, images: list[Image.Image]) -> list[list[float]]:
        batch = torch.stack([self._preprocess(image) for image in images])
        with self._lock, torch.inference_mode():
            features = self._model.encode_image(batch, normalize=True)
        return features.tolist()

    def embed_text(self, text: str) -> list[float]:
        # The tokenizer isn't safe to use from two threads at once either.
        with self._lock, torch.inference_mode():
            tokens = self._tokenizer([text])
            features = self._model.encode_text(tokens, normalize=True)
        return features[0].tolist()
