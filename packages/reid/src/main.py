"""vipcam-reid sidecar — stub na Onda 1, expansão real na Fase 6."""
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="vipcam-reid", version="0.0.0")


class HealthResponse(BaseModel):
    status: str
    version: str


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="healthy", version="0.0.0")
