import os

import pytest
from fastapi.testclient import TestClient

from src.main import app

client = TestClient(app)
FIX = os.path.join(os.path.dirname(__file__), "fixtures")
FACE = os.path.join(FIX, "face.jpg")
BLANK = os.path.join(FIX, "blank.jpg")


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "healthy"


@pytest.mark.skipif(not os.path.exists(FACE), reason="face.jpg fixture not provisioned (VPS step)")
def test_detect_finds_face():
    with open(FACE, "rb") as f:
        r = client.post("/detect", files={"file": ("face.jpg", f, "image/jpeg")})
    assert r.status_code == 200
    body = r.json()
    assert len(body["faces"]) >= 1
    assert body["faces"][0]["det_score"] >= 0.5
    assert body["infer_ms"] >= 0
    assert body["width"] > 0 and body["height"] > 0


@pytest.mark.skipif(not os.path.exists(BLANK), reason="blank.jpg fixture not provisioned (VPS step)")
def test_detect_blank_no_face():
    with open(BLANK, "rb") as f:
        r = client.post("/detect", files={"file": ("blank.jpg", f, "image/jpeg")})
    assert r.status_code == 200
    assert r.json()["faces"] == []


def test_detect_undecodable_body_returns_empty_200():
    # Onda 6 contract: non-image body (probe may capture a 401/HTML .bin)
    # must NOT 500 — /detect returns empty 200 so the aggregator records
    # "no usable image" instead of a transport error.
    r = client.post("/detect", files={"file": ("x.bin", b"not-an-image", "application/octet-stream")})
    assert r.status_code == 200
    body = r.json()
    assert body["faces"] == []
    assert body["width"] == 0 and body["height"] == 0
