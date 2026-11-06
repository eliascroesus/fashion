# services/embedder

The fingerprint service (Step 3.2). It takes a photo, or words, and gives back "fingerprints": 768 numbers of length 1 from [Marqo-FashionSigLIP](https://huggingface.co/Marqo/marqo-fashionSigLIP) (Apache-2.0, pinned to commit `c56244c`), running on CPU. Similar-looking things have fingerprints with a high cosine similarity. The database stores them as `halfvec(768)` (Step 3.1).

Python 3.12 + FastAPI. Installed with [uv](https://docs.astral.sh/uv/) at the exact versions in `uv.lock`; on Linux, torch comes from PyTorch's CPU-only index.

## Routes
| Route | Body | Answer |
| --- | --- | --- |
| `GET /health` | (no secret needed) | `{ status, model, dimensions }` |
| `POST /embed-image` | `{ url, boxes? }` | `{ model, embeddings: [[…768]], timing }`: one per box, in order, or one for the whole photo |
| `POST /embed-text` | `{ text }` (1–200 characters) | `{ model, embedding: […768], timing }` |

- **Secret:** every route but health needs `Authorization: Bearer <EMBEDDER_SECRET>`, checked before anything else.
- **Boxes:** in fractions of the photo, `{ left, top, right, bottom }` from 0 to 1, like `garments`. At most 20 per photo.
- **Errors:** the same format and codes as the API (`apps/api/src/errors.ts`): `{ "error": { code, message, requestId, details? } }`, plus an `x-request-id` header.
  - 400 `validation_failed` (`details` lists dotted paths such as `boxes.0.left`)
  - 401 `unauthorized`
  - 403 `forbidden` (not https, host not allowed, address not public)
  - 404 `not_found`
  - 413 `payload_too_large` (over 15 MB or 25 megapixels)
  - 415 `unsupported_media_type` (not JPEG / PNG / WebP)
  - 502 `service_unavailable` (the photo couldn't be downloaded: worth retrying later)
  - 500 `internal_error`

## Safe downloads (`src/embedder/fetch.py`)
- Photos must be `https`, from a host in `EMBEDDER_IMAGE_HOSTS` (our R2 photo address).
- Every address the host resolves to must be public: no private networks, localhost, link-local / cloud metadata, carrier-grade NAT, Fly's `fdaa::` network, or IPv4 hidden in IPv6.
- No redirects; 3 s to connect, 10 s in total, 15 MB.
- Pictures are checked for size before they're decoded, and at most two are decoded at once (memory).

## Run it
```sh
uv sync                                  # libraries
uv run python -m embedder.download_model # model files into ./models (813 MB, once)
uv run pytest                            # tests (the real-model ones skip without ./models)
uv run --env-file ../../.env uvicorn embedder.app:build --factory --port 8091
```
From the repo root: `pnpm embedder:test`, and `pnpm embedder:speed [--count 30] [--boxes 5]` (times the live staging service with real feed photos).

## Settings
- `EMBEDDER_SECRET`: at least 32 characters; the server refuses to start without it.
- `EMBEDDER_IMAGE_HOSTS`: comma-separated list of photo hosts.
- `MODEL_DIR`: defaults to `./models`; `/models` in the image.
- `SENTRY_DSN`, `SENTRY_ENVIRONMENT`: optional. Server errors only, without headers, bodies, links, variable values or breadcrumbs (`tests/test_sentry.py` checks a crash report holds neither the secret nor the photo link).

## Deploy (staging)
`fly deploy services/embedder --ha=false` from the repo root (app `outfitly-embedder-staging`, Stockholm). The image (1.1 GB) has the model baked in and turns downloads off. The machine suspends when idle and wakes with the model already in memory. A new deploy or a full stop means loading the model again (about 20 s on its performance-1x machine).
