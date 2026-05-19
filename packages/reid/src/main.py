"""vipcam-reid sidecar — Onda 6: InsightFace buffalo_s (CPU) face detection.

/detect resolve o gate do Failover B: dado uma imagem, retorna faces
detectadas (bbox px na imagem nativa + det_score) e infer_ms. /health mantido.
"""
import io
import time

import numpy as np
from fastapi import FastAPI, File, UploadFile
from PIL import Image
from pydantic import BaseModel

app = FastAPI(title="vipcam-reid", version="0.1.0")

# INSIGHTFACE_HOME deve apontar p/ um path em ReadWritePaths do systemd unit
# (default ~/.insightface é bloqueado por ProtectHome=read-only).
_MODEL = None


def _model():
    global _MODEL
    if _MODEL is None:
        from insightface.app import FaceAnalysis

        _MODEL = FaceAnalysis(name="buffalo_s", providers=["CPUExecutionProvider"])
        _MODEL.prepare(ctx_id=-1, det_size=(640, 640))
    return _MODEL


class HealthResponse(BaseModel):
    status: str
    version: str


class Face(BaseModel):
    bbox: list[float]  # [x, y, w, h] px na imagem nativa
    det_score: float


class DetectResponse(BaseModel):
    faces: list[Face]
    width: int
    height: int
    infer_ms: int


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="healthy", version="0.1.0")


@app.post("/detect", response_model=DetectResponse)
async def detect(file: UploadFile = File(...)) -> DetectResponse:
    raw = await file.read()
    try:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
    except OSError:
        # Body não-decodável (ex: o probe capturou um 401/HTML como amostra
        # .bin). Contrato com o aggregator da Onda 6: responder 200 vazio
        # (faces=[], dims 0) → ele classifica naturalmente como "sem imagem
        # utilizável", sem precisar tratar erro de transporte por amostra.
        return DetectResponse(faces=[], width=0, height=0, infer_ms=0)
    w, h = img.size
    # ascontiguousarray: [:, :, ::-1] gera view com stride negativo não-
    # contíguo; alguns paths cv2/onnxruntime assumem buffer contíguo.
    arr = np.ascontiguousarray(np.asarray(img)[:, :, ::-1])  # RGB->BGR p/ InsightFace
    t0 = time.monotonic()
    faces = _model().get(arr)
    infer_ms = int((time.monotonic() - t0) * 1000)
    out = []
    for f in faces:
        x1, y1, x2, y2 = f.bbox
        out.append(Face(bbox=[float(x1), float(y1), float(x2 - x1), float(y2 - y1)],
                         det_score=float(f.det_score)))
    return DetectResponse(faces=out, width=w, height=h, infer_ms=infer_ms)
