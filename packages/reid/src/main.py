"""vipcam-reid sidecar — Onda 6: InsightFace buffalo_s (CPU) face detection.

/detect resolve o gate do Failover B: dado uma imagem, retorna faces
detectadas (bbox px na imagem nativa + det_score) e infer_ms. /health mantido.
"""
import base64
import io
import time

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from PIL import Image
from pydantic import BaseModel

app = FastAPI(title="vipcam-reid", version="0.2.1")

# Onda 7: trocar quando atualizar pip insightface — pra invalidar embeddings
# antigos via WHERE clause no edge sem precisar re-migrar tabela.
MODEL_NAME = "buffalo_s"
MODEL_REVISION = "insightface-0.7.3"

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
    model_name: str
    model_revision: str


class Face(BaseModel):
    bbox: list[float]  # [x, y, w, h] px na imagem nativa
    det_score: float


class DetectResponse(BaseModel):
    faces: list[Face]
    width: int
    height: int
    infer_ms: int


class WarmupResponse(BaseModel):
    warmed: bool
    took_ms: int


class EmbedResponse(BaseModel):
    embedding: list[float]
    det_score: float
    infer_ms: int
    model_name: str
    model_revision: str
    crop_jpeg_b64: str
    # Onda 7.1: indica se o embedding veio do crop pela bbox do evento
    # ("bbox") ou do fallback frame-inteiro ("frame_fallback"). Edge usa pra
    # observability/metrics; embedding é igualmente válido nos dois casos.
    source: str = "bbox"


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="healthy",
        version=app.version,
        model_name=MODEL_NAME,
        model_revision=MODEL_REVISION,
    )


@app.post("/warmup", response_model=WarmupResponse)
async def warmup() -> WarmupResponse:
    """Força carga do modelo InsightFace (idempotente)."""
    t0 = time.monotonic()
    _ = _model()
    took_ms = int((time.monotonic() - t0) * 1000)
    return WarmupResponse(warmed=True, took_ms=took_ms)


def _embed_pil(crop_img: "Image.Image") -> "tuple[list[float], float, int] | None":
    """Roda InsightFace numa imagem PIL. Retorna (embedding, det_score, infer_ms)
    do rosto de maior det_score, ou None se nenhum rosto detectado."""
    arr = np.ascontiguousarray(np.asarray(crop_img)[:, :, ::-1])
    t0 = time.monotonic()
    faces = _model().get(arr)
    infer_ms = int((time.monotonic() - t0) * 1000)
    if not faces:
        return None
    best = max(faces, key=lambda f: f.det_score)
    return ([float(v) for v in best.normed_embedding.tolist()],
            float(best.det_score), infer_ms)


def _jpeg_b64(img: "Image.Image", *, quality: int = 85) -> str:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode("ascii")


@app.post("/embed", response_model=EmbedResponse)
async def embed(
    file: UploadFile = File(...),
    x: int = Form(...),
    y: int = Form(...),
    w: int = Form(...),
    h: int = Form(...),
) -> EmbedResponse:
    """Onda 7.1: tenta bbox primeiro; se InsightFace falha (rosto se moveu
    entre evento Dahua e snapshot.cgi ~700ms depois), faz fallback pra frame
    inteiro escolhendo o maior rosto. Edge recebe source='bbox' ou
    'frame_fallback' pra observability."""
    if x < 0 or y < 0 or w <= 0 or h <= 0:
        raise HTTPException(status_code=400, detail="bbox: x/y must be >= 0, w/h must be > 0")
    raw = await file.read()
    try:
        img = Image.open(io.BytesIO(raw)).convert("RGB")
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"undecodable image: {exc}") from exc
    fw, fh = img.size

    # Tentativa 1: crop pela bbox do evento (rápido, ~30ms). Se bbox cabe no
    # frame, pode ter o rosto. Se não cabe, pulamos direto pro fallback (em vez
    # de 400 — quando bbox vem inválida por timing/race, fallback recupera).
    if x + w <= fw and y + h <= fh:
        crop = img.crop((x, y, x + w, y + h))
        res = _embed_pil(crop)
        if res is not None:
            emb, det_score, infer_ms = res
            return EmbedResponse(
                embedding=emb,
                det_score=det_score,
                infer_ms=infer_ms,
                model_name=MODEL_NAME,
                model_revision=MODEL_REVISION,
                crop_jpeg_b64=_jpeg_b64(crop),
                source="bbox",
            )

    # Tentativa 2: frame inteiro (mais lento, ~150ms no DH-IPC-HFW5442T-ASE
    # @2688x1520). Se nenhum rosto for detectado nem aqui, 422.
    res = _embed_pil(img)
    if res is None:
        raise HTTPException(
            status_code=422,
            detail="no face detected in bbox crop nor full frame",
        )
    emb, det_score, infer_ms = res
    # Crop final pro edge persistir: usa bbox do InsightFace (rosto real) com
    # margem de 10% pra dar contexto pro /live. Re-extrai o rosto de maior
    # det_score (reusa _embed_pil já encontrou, mas precisamos da bbox).
    faces = _model().get(np.ascontiguousarray(np.asarray(img)[:, :, ::-1]))
    best = max(faces, key=lambda f: f.det_score)
    x1, y1, x2, y2 = (float(v) for v in best.bbox)
    margin_x = (x2 - x1) * 0.10
    margin_y = (y2 - y1) * 0.10
    cx1 = max(0, int(x1 - margin_x))
    cy1 = max(0, int(y1 - margin_y))
    cx2 = min(fw, int(x2 + margin_x))
    cy2 = min(fh, int(y2 + margin_y))
    face_crop = img.crop((cx1, cy1, cx2, cy2))
    return EmbedResponse(
        embedding=emb,
        det_score=det_score,
        infer_ms=infer_ms,
        model_name=MODEL_NAME,
        model_revision=MODEL_REVISION,
        crop_jpeg_b64=_jpeg_b64(face_crop),
        source="frame_fallback",
    )


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
