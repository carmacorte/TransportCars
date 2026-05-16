from __future__ import annotations

import os
import shutil
import subprocess
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent
WORKSPACE = Path(os.getenv("VOICECLONE_WORKSPACE", PROJECT_ROOT / "voice_workspace")).resolve()
VOCALTWIN_PATH = Path(os.getenv("VOCALTWIN_PATH", PROJECT_ROOT / "VocalTwin")).resolve()

SAMPLES_DIR = WORKSPACE / "audio_samples"
TEXTS_DIR = WORKSPACE / "texts"
OUTPUTS_DIR = WORKSPACE / "outputs"
CHECKPOINTS_DIR = WORKSPACE / "checkpoints"
STATIC_DIR = BASE_DIR / "static"

for folder in [WORKSPACE, SAMPLES_DIR, TEXTS_DIR, OUTPUTS_DIR, CHECKPOINTS_DIR]:
    folder.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Lean English Voice Twin API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

if STATIC_DIR.exists():
    app.mount("/app", StaticFiles(directory=str(STATIC_DIR), html=True), name="voiceclone_app")


class SynthesizeRequest(BaseModel):
    text: str
    language: str = "ES"
    file_name: Optional[str] = None


def _run(command: list[str], cwd: Path) -> dict:
    try:
        proc = subprocess.run(
            command,
            cwd=str(cwd),
            text=True,
            capture_output=True,
            check=False,
            timeout=int(os.getenv("VOICECLONE_TIMEOUT", "1800")),
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail=f"Process timeout: {exc}") from exc

    payload = {
        "command": " ".join(command),
        "returncode": proc.returncode,
        "stdout": proc.stdout[-4000:],
        "stderr": proc.stderr[-4000:],
    }
    if proc.returncode != 0:
        raise HTTPException(status_code=500, detail=payload)
    return payload


def _sync_workspace_to_vocaltwin() -> None:
    if not VOCALTWIN_PATH.exists():
        raise HTTPException(
            status_code=400,
            detail=f"VocalTwin path not found: {VOCALTWIN_PATH}. Set VOCALTWIN_PATH environment variable.",
        )
    for name in ["audio_samples", "texts", "outputs", "checkpoints"]:
        target = VOCALTWIN_PATH / name
        target.mkdir(parents=True, exist_ok=True)
    for sample in SAMPLES_DIR.glob("*"):
        if sample.is_file():
            shutil.copy2(sample, VOCALTWIN_PATH / "audio_samples" / sample.name)
    for text_file in TEXTS_DIR.glob("*.txt"):
        shutil.copy2(text_file, VOCALTWIN_PATH / "texts" / text_file.name)


def _sync_vocaltwin_to_workspace() -> None:
    for source_dir, target_dir in [
        (VOCALTWIN_PATH / "outputs", OUTPUTS_DIR),
        (VOCALTWIN_PATH / "checkpoints", CHECKPOINTS_DIR),
    ]:
        if source_dir.exists():
            for item in source_dir.glob("*"):
                if item.is_file():
                    shutil.copy2(item, target_dir / item.name)


@app.get("/")
def root() -> FileResponse | dict:
    index = STATIC_DIR / "index.html"
    if index.exists():
        return FileResponse(index)
    return {"service": "Lean English Voice Twin API", "ui": "/app", "status": "/health"}


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "workspace": str(WORKSPACE),
        "vocaltwin_path": str(VOCALTWIN_PATH),
        "vocaltwin_exists": VOCALTWIN_PATH.exists(),
        "samples": len(list(SAMPLES_DIR.glob("*"))),
        "outputs": len(list(OUTPUTS_DIR.glob("*"))),
        "has_voice_embedding": (CHECKPOINTS_DIR / "target_se.pth").exists(),
    }


@app.post("/samples")
async def upload_sample(file: UploadFile = File(...)) -> dict:
    suffix = Path(file.filename or "sample.wav").suffix.lower()
    if suffix not in {".wav", ".mp3", ".m4a", ".aac"}:
        raise HTTPException(status_code=400, detail="Allowed formats: wav, mp3, m4a, aac")
    safe_name = f"sample_{uuid.uuid4().hex[:8]}{suffix}"
    destination = SAMPLES_DIR / safe_name
    with destination.open("wb") as out:
        shutil.copyfileobj(file.file, out)
    return {"file": safe_name, "path": str(destination)}


@app.get("/samples")
def list_samples() -> dict:
    return {"samples": [p.name for p in sorted(SAMPLES_DIR.glob("*")) if p.is_file()]}


@app.post("/train")
def train() -> dict:
    _sync_workspace_to_vocaltwin()
    result = _run(["python", "main.py", "train"], cwd=VOCALTWIN_PATH)
    _sync_vocaltwin_to_workspace()
    return {"ok": True, "result": result, "has_voice_embedding": (CHECKPOINTS_DIR / "target_se.pth").exists()}


@app.post("/synthesize")
def synthesize(payload: SynthesizeRequest) -> dict:
    if not payload.text.strip():
        raise HTTPException(status_code=400, detail="Text is required")
    file_stem = payload.file_name or f"lean_voice_{uuid.uuid4().hex[:8]}"
    text_path = TEXTS_DIR / f"{file_stem}.txt"
    text_path.write_text(payload.text.strip(), encoding="utf-8")
    _sync_workspace_to_vocaltwin()
    result = _run(["python", "main.py", "synthesize", "--language", payload.language.upper()], cwd=VOCALTWIN_PATH)
    _sync_vocaltwin_to_workspace()
    outputs = [p.name for p in sorted(OUTPUTS_DIR.glob("*"), key=lambda x: x.stat().st_mtime, reverse=True)]
    return {"ok": True, "result": result, "outputs": outputs[:10]}


@app.get("/outputs")
def list_outputs() -> dict:
    files = [p.name for p in sorted(OUTPUTS_DIR.glob("*"), key=lambda x: x.stat().st_mtime, reverse=True) if p.is_file()]
    return {"outputs": files}


@app.get("/outputs/{file_name}")
def download_output(file_name: str) -> FileResponse:
    target = OUTPUTS_DIR / Path(file_name).name
    if not target.exists():
        raise HTTPException(status_code=404, detail="Output not found")
    return FileResponse(target, media_type="audio/wav", filename=target.name)


@app.delete("/workspace")
def clear_workspace() -> JSONResponse:
    for folder in [SAMPLES_DIR, TEXTS_DIR, OUTPUTS_DIR]:
        for item in folder.glob("*"):
            if item.is_file():
                item.unlink()
    return JSONResponse({"ok": True})
