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


def test_embed_400_when_bbox_outside_frame():
    body = _dummy_jpeg(100, 100)
    r = client.post(
        "/embed",
        files={"file": ("dummy.jpg", body, "image/jpeg")},
        data={"x": "200", "y": "200", "w": "50", "h": "50"},
    )
    assert r.status_code == 400
    assert "bbox" in r.json()["detail"].lower()


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
    assert crop_img.size == (bw, bh)
