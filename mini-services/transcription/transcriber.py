"""
Whisper Transcription Wrapper
==============================
Handles model loading and inference using OpenAI Whisper.
Supports: tiny, base, small, medium, large-v3
"""

import json
import logging
import whisper
import torch

logger = logging.getLogger("transcription.whisper")

# Model cache to avoid reloading
_model_cache = {}


def get_model(model_name: str = "base"):
    """Load or retrieve cached Whisper model."""
    if model_name not in _model_cache:
        logger.info(f"Loading Whisper model: {model_name} (device: {'cuda' if torch.cuda.is_available() else 'cpu'})")
        _model_cache[model_name] = whisper.load_model(model_name)
        logger.info(f"Model {model_name} loaded successfully")
    return _model_cache[model_name]


def transcribe_audio(
    audio_path: str,
    model_name: str = "base",
    language: str = None,
) -> dict:
    """
    Transcribe an audio file using Whisper.
    
    Args:
        audio_path: Path to the WAV audio file (16kHz mono)
        model_name: Whisper model to use (tiny, base, small, medium, large-v3)
        language: Optional language code (e.g., "en", "es")
    
    Returns:
        dict with keys: text, segments, language, confidence
    """
    model = get_model(model_name)
    
    # Build transcription options
    options = {
        "fp16": torch.cuda.is_available(),
        "verbose": False,
    }
    if language:
        options["language"] = language
    
    # Run transcription
    result = model.transcribe(audio_path, **options)
    
    # Extract segments with timestamps
    segments = []
    for seg in result.get("segments", []):
        segments.append({
            "start": round(seg["start"], 2),
            "end": round(seg["end"], 2),
            "text": seg["text"].strip(),
        })
    
    # Calculate average confidence from segment no_speech_prob scores
    confidences = []
    for seg in result.get("segments", []):
        if "no_speech_prob" in seg:
            confidences.append(1.0 - seg["no_speech_prob"])
    
    avg_confidence = sum(confidences) / len(confidences) if confidences else None
    
    return {
        "text": result["text"].strip(),
        "segments": json.dumps(segments),
        "language": result.get("language", "en"),
        "confidence": avg_confidence,
    }
