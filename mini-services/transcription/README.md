# OmniSight Transcription Service

Internal Python microservice for audio transcription using OpenAI Whisper.

## Setup

### Local Development

```bash
pip install -r requirements.txt
python main.py
```

### Docker

```bash
docker build -t omnisight-transcription .
docker run -p 8001:8001 \
    -e TRANSCRIPTION_API_KEY=your-secret-key \
    -e WHISPER_MODEL=base \
    -e CALLBACK_URL=http://host.docker.internal:3100/api/internal/audio/transcription-callback \
    omnisight-transcription
```

### GPU Support

For GPU acceleration, use the NVIDIA CUDA base image:

```dockerfile
FROM nvidia/cuda:11.8.0-runtime-ubuntu22.04
```

And install PyTorch with CUDA support:

```bash
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TRANSCRIPTION_API_KEY` | (required) | Internal API key for authentication |
| `WHISPER_MODEL` | `base` | Whisper model (tiny, base, small, medium, large-v3) |
| `CALLBACK_URL` | `http://localhost:3100/api/internal/audio/transcription-callback` | OmniSight callback URL |
| `MAX_FILE_SIZE_MB` | `100` | Maximum audio file size in MB |
| `MAX_AUDIO_DURATION_S` | `7200` | Maximum audio duration in seconds (2 hours) |

## API Endpoints

### Health Check
```
GET /health
```

### Transcribe
```
POST /transcribe
Headers: x-api-key: <api-key>
Body: {
    "recording_id": "string",
    "organization_id": "string",
    "audio_url": "string (signed URL)",
    "language": "string (optional)",
    "model": "string (optional)"
}
```

## Models

| Model | Size | Speed | Quality |
|-------|------|-------|---------|
| tiny | 75MB | Fast | Low |
| base | 142MB | Medium | Good |
| small | 466MB | Slow | Better |
| medium | 1.5GB | Slower | Great |
| large-v3 | 3GB | Slowest | Best |

## Architecture

1. Receives transcription request with signed audio URL
2. Downloads audio from OmniSight storage
3. Converts to 16kHz mono WAV using FFmpeg
4. Runs Whisper inference
5. Sends structured result to OmniSight callback endpoint
6. Cleans up temporary files
