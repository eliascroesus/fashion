"""Fetches the pinned model files into MODEL_DIR (Docker build, CI and the Mac).

uv run python -m embedder.download_model
"""

from huggingface_hub import snapshot_download

from embedder.settings import model_dir_from_env

MODEL_ID = "Marqo/marqo-fashionSigLIP"
# Pinned: a new upload never changes fingerprints we've already stored.
MODEL_REVISION = "c56244cc94f92419e8369fa71efdaf403b124ce8"
# What open_clip's `local-dir:` needs: config, weights and the tokenizer.
MODEL_FILES = [
    "open_clip_config.json",
    "open_clip_model.safetensors",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
]


def main() -> None:
    target = model_dir_from_env()
    snapshot_download(
        MODEL_ID, revision=MODEL_REVISION, allow_patterns=MODEL_FILES, local_dir=target
    )
    print(f"{MODEL_ID}@{MODEL_REVISION[:7]} in {target}")


if __name__ == "__main__":
    main()
