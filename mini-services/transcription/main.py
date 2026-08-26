"""
OmniSight Audio Transcription Microservice
==========================================
Internal service that transcribes audio using OpenAI Whisper.
Not exposed to the internet — authenticated via X-API-Key header.

Usage:
    python main.py
    # or
    uvicorn main:app --host 0.0.0.0 --port 8001
"""

import os
import time
import tempfile
import subprocess
import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel
from typing import Optional
import httpx

from transcriber import transcribe_audio

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("transcription")

app = FastAPI(title="OmniSight Transcription Service", version="1.0.0")

API_KEY = os.environ.get("TRANSCRIPTION_API_KEY", "")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base")
CALLBACK_URL = os.environ.get("CALLBACK_URL", "http://localhost:3100/api/internal/audio/transcription-callback")
MAX_FILE_SIZE_MB = int(os.environ.get("MAX_FILE_SIZE_MB", "100"))
MAX_AUDIO_DURATION_S = int(os.environ.get("MAX_AUDIO_DURATION_S", "7200"))  # 2 hours


class TranscriptionRequest(BaseModel):
    recording_id: str
    organization_id: str
    audio_url: str  # Signed URL or internal URL to fetch the audio
    language: Optional[str] = None
    model: Optional[str] = None


class HealthResponse(BaseModel):
    status: str
    model: str
    version: str


def verify_api_key(x_api_key: str = Header(default="")):
    """Verify the internal API key."""
    if not API_KEY:
        raise HTTPException(status_code=503, detail="TRANSCRIPTION_API_KEY not configured")
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return x_api_key


@app.get("/health", response_model=HealthResponse)
def health_check():
    """Health check endpoint (no auth required)."""
    return HealthResponse(status="ok", model=WHISPER_MODEL, version="1.0.0")


@app.post("/transcribe")
async def transcribe(
    request: TranscriptionRequest,
    x_api_key: str = Header(default=""),
):
    """
    Transcribe an audio file.
    
    1. Downloads audio from the provided URL
    2. Converts to 16kHz mono WAV using FFmpeg
    3. Runs Whisper inference
    4. Returns structured transcription result
    5. Sends result to callback URL
    """
    verify_api_key(x_api_key)
    
    start_time = time.time()
    temp_dir = None
    
    try:
        # Download audio
        logger.info(f"Downloading audio for recording {request.recording_id}")
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.get(
                request.audio_url,
                headers={"x-api-key": API_KEY},
            )
            if response.status_code != 200:
                raise HTTPException(
                    status_code=502,
                    detail=f"Failed to download audio: HTTP {response.status_code}",
                )
            
            audio_data = response.content
        
        if len(audio_data) > MAX_FILE_SIZE_MB * 1024 * 1024:
            raise HTTPException(
                status_code=413,
                detail=f"Audio file too large: {len(audio_data) / 1024 / 1024:.1f}MB (max {MAX_FILE_SIZE_MB}MB)",
            )
        
        # Save to temp file and convert with FFmpeg
        temp_dir = tempfile.mkdtemp()
        input_path = os.path.join(temp_dir, "input_audio")
        output_path = os.path.join(temp_dir, "output.wav")
        
        with open(input_path, "wb") as f:
            f.write(audio_data)
        
        # Convert to 16kHz mono WAV
        logger.info(f"Converting audio for recording {request.recording_id}")
        ffmpeg_cmd = [
            "ffmpeg", "-y", "-i", input_path,
            "-ar", "16000",  # 16kHz sample rate
            "-ac", "1",      # mono
            "-f", "wav",
            output_path,
        ]
        
        result = subprocess.run(
            ffmpeg_cmd,
            capture_output=True,
            timeout=300,
        )
        
        if result.returncode != 0:
            raise HTTPException(
                status_code=422,
                detail=f"FFmpeg conversion failed: {result.stderr.decode()[:500]}",
            )
        
        # Get audio duration
        probe_cmd = [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            output_path,
        ]
        
        probe_result = subprocess.run(probe_cmd, capture_output=True, timeout=30)
        duration = float(probe_result.stdout.decode().strip()) if probe_result.returncode == 0 else 0
        
        if duration > MAX_AUDIO_DURATION_S:
            raise HTTPException(
                status_code=413,
                detail=f"Audio too long: {duration:.0f}s (max {MAX_AUDIO_DURATION_S}s)",
            )
        
        # Run Whisper transcription
        model_name = request.model or WHISPER_MODEL
        logger.info(f"Transcribing with model {model_name} for recording {request.recording_id}")
        
        transcription = transcribe_audio(
            audio_path=output_path,
            model_name=model_name,
            language=request.language,
        )
        
        processing_ms = int((time.time() - start_time) * 1000)
        
        # Send callback to OmniSight
        callback_payload = {
            "recordingId": request.recording_id,
            "organizationId": request.organization_id,
            "success": True,
            "text": transcription["text"],
            "segments": transcription["segments"],
            "language": transcription["language"],
            "confidence": transcription.get("confidence"),
            "model": model_name,
            "duration": duration,
            "wordCount": len(transcription["text"].split()),
            "processingMs": processing_ms,
        }
        
        logger.info(f"Sending callback for recording {request.recording_id}")
        async with httpx.AsyncClient(timeout=30.0) as client:
            callback_response = await client.post(
                CALLBACK_URL,
                json=callback_payload,
                headers={"x-api-key": API_KEY, "Content-Type": "application/json"},
            )
            if callback_response.status_code != 200:
                logger.error(f"Callback failed: {callback_response.status_code} {callback_response.text}")
        
        return {
            "recordingId": request.recording_id,
            "success": True,
            "duration": duration,
            "wordCount": len(transcription["text"].split()),
            "processingMs": processing_ms,
        }
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Transcription failed for {request.recording_id}: {e}")
        
        # Send failure callback
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                await client.post(
                    CALLBACK_URL,
                    json={
                        "recordingId": request.recording_id,
                        "organizationId": request.organization_id,
                        "success": False,
                        "errorMessage": str(e)[:500],
                    },
                    headers={"x-api-key": API_KEY, "Content-Type": "application/json"},
                )
        except Exception as cb_err:
            logger.error(f"Failed callback for {request.recording_id}: {cb_err}")
        
        raise HTTPException(status_code=500, detail=str(e))
    
    finally:
        # Cleanup temp files
        if temp_dir:
            import shutil
            shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
