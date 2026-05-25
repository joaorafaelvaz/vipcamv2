import io
import os

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from src.main import app

client = TestClient(app)
FIX = os.path.join(os.path.dirname(__file__), "fixtures")
FACE = os.path.join(FIX, "face.jpg")


def _dummy_jpeg(w: int = 200, h: int = 200) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color=(128, 128, 128)).save(buf, format="JPEG")
    return buf.getvalue()


def test_embed_422_when_bbox_outside_frame_and_no_face_in_fallback():
    """Onda 7.1: bbox fora do frame não-é mais 400 — sidecar pula direto pro
    fallback de frame inteiro. Dummy gray jpeg não tem rosto → 422."""
    body = _dummy_jpeg(100, 100)
    r = client.post(
        "/embed",
        files={"file": ("dummy.jpg", body, "image/jpeg")},
        data={"x": "200", "y": "200", "w": "50", "h": "50"},
    )
    assert r.status_code == 422
    assert "bbox crop nor full frame" in r.json()["detail"]


def test_embed_400_when_bbox_negative():
    body = _dummy_jpeg(100, 100)
    r = client.post(
        "/embed",
        files={"file": ("dummy.jpg", body, "image/jpeg")},
        data={"x": "-5", "y": "0", "w": "50", "h": "50"},
    )
    assert r.status_code == 400


def test_health_includes_model_metadata():
    r = client.get("/health")
    body = r.json()
    assert body["model_name"] == "buffalo_s"
    assert body["model_revision"].startswith("insightface-")


def test_warmup_returns_200_with_took_ms():
    r = client.post("/warmup")
    assert r.status_code == 200
    body = r.json()
    assert body["warmed"] is True
    assert body["took_ms"] >= 0


@pytest.mark.skipif(
    not os.path.exists(FACE),
    reason="face.jpg fixture not provisioned (VPS step)",
)
def test_embed_returns_512d_vector_for_face_crop():
    import base64
    with open(FACE, "rb") as f:
        raw = f.read()
    img = Image.open(io.BytesIO(raw))
    w, h = img.size
    x, y = w // 4, h // 4
    bw, bh = w // 2, h // 2
    r = client.post(
        "/embed",
        files={"file": ("face.jpg", raw, "image/jpeg")},
        data={"x": str(x), "y": str(y), "w": str(bw), "h": str(bh)},
    )
    assert r.status_code == 200
    body = r.json()
    assert len(body["embedding"]) == 512
    assert all(isinstance(v, (int, float)) for v in body["embedding"])
    assert body["model_name"] == "buffalo_s"
    assert body["model_revision"].startswith("insightface-")
    assert 0 <= body["det_score"] <= 1
    assert body["infer_ms"] >= 0
    crop_bytes = base64.b64decode(body["crop_jpeg_b64"])
    crop_img = Image.open(io.BytesIO(crop_bytes))
    assert crop_img.format == "JPEG"
    # Onda 7.1: se source='bbox', crop tem dimensões da bbox exata;
    # se source='frame_fallback', dimensões da face InsightFace + 10% margin.
    assert body["source"] in ("bbox", "frame_fallback")
    if body["source"] == "bbox":
        assert crop_img.size == (bw, bh)


@pytest.mark.skipif(
    not os.path.exists(FACE),
    reason="face.jpg fixture not provisioned (VPS step)",
)
def test_embed_fallback_when_bbox_misaligned():
    """Onda 7.1 core: bbox em região vazia (canto do frame) deve trigar
    fallback. Source deve ser 'frame_fallback' e ainda retornar embedding."""
    with open(FACE, "rb") as f:
        raw = f.read()
    img = Image.open(io.BytesIO(raw))
    fw, fh = img.size
    # Bbox em região marginal (10x10 px no canto) onde InsightFace não
    # deve encontrar nada → trigger fallback pro frame inteiro.
    r = client.post(
        "/embed",
        files={"file": ("face.jpg", raw, "image/jpeg")},
        data={"x": "0", "y": "0", "w": "10", "h": "10"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["source"] == "frame_fallback"
    assert len(body["embedding"]) == 512
