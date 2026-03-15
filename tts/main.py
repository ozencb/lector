import io
import logging
from typing import Optional

import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from kokoro import KPipeline
from pydantic import BaseModel

logger = logging.getLogger(__name__)

app = FastAPI(title="Lector TTS Service")

# Language code -> (display name, KPipeline instance)
LANG_CODES = {
    "a": "American English",
    "b": "British English",
    "j": "Japanese",
    "z": "Mandarin Chinese",
    "e": "Spanish",
    "f": "French",
    "h": "Hindi",
    "i": "Italian",
    "p": "Brazilian Portuguese",
}

# All available voices grouped by language code prefix
VOICES = {
    "a": [
        "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica",
        "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
        "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
        "am_michael", "am_onyx", "am_puck", "am_santa",
    ],
    "b": [
        "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
        "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
    ],
    "j": [
        "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro",
        "jm_kumo",
    ],
    "z": [
        "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi",
        "zm_yunjian", "zm_yunxi", "zm_yunxia", "zm_yunyang",
    ],
    "e": ["ef_dora", "em_alex", "em_santa"],
    "f": ["ff_siwis"],
    "h": ["hf_alpha", "hf_beta", "hm_omega", "hm_psi"],
    "i": ["if_sara", "im_nicola"],
    "p": ["pf_dora", "pm_alex", "pm_santa"],
}

ALL_VOICE_IDS = {v for voices in VOICES.values() for v in voices}

SAMPLE_RATE = 24000

# Load pipelines once at startup. Each language code needs its own pipeline
# for correct G2P (grapheme-to-phoneme) processing.
pipelines: dict[str, KPipeline] = {}
model_ready = False


@app.on_event("startup")
def load_model():
    global pipelines, model_ready
    logger.info("Loading Kokoro pipelines...")
    # Create a pipeline for each language code. The first pipeline loads the
    # model weights; subsequent ones share via model=False then we assign.
    first_pipeline: Optional[KPipeline] = None
    for lang_code in LANG_CODES:
        if first_pipeline is None:
            pipe = KPipeline(lang_code=lang_code)
            first_pipeline = pipe
        else:
            pipe = KPipeline(lang_code=lang_code, model=first_pipeline.model)
        pipelines[lang_code] = pipe
    model_ready = True
    logger.info("Kokoro pipelines loaded and ready.")


@app.get("/health")
def health():
    if not model_ready:
        raise HTTPException(status_code=503, detail="Model not loaded yet")
    return {"status": "ready"}


@app.get("/voices")
def voices():
    result = {}
    for lang_code, voice_list in VOICES.items():
        lang_name = LANG_CODES[lang_code]
        result[lang_name] = [
            {"id": v, "name": v.split("_", 1)[1].replace("_", " ").title()}
            for v in voice_list
        ]
    return result


class SynthesizeRequest(BaseModel):
    text: str
    voice: str
    language: str  # language code like "a", "b", "j", etc.


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest):
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="Text must not be empty")

    if req.voice not in ALL_VOICE_IDS:
        raise HTTPException(status_code=400, detail=f"Unknown voice: {req.voice}")

    lang_code = req.language
    if lang_code not in pipelines:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown language code: {lang_code}. Valid codes: {list(LANG_CODES.keys())}",
        )

    pipeline = pipelines[lang_code]

    # Generate audio. The pipeline yields Result objects; concatenate all audio.
    audio_chunks = []
    for result in pipeline(req.text, voice=req.voice, speed=1.0):
        if result.audio is not None:
            audio_chunks.append(result.audio)

    if not audio_chunks:
        raise HTTPException(status_code=500, detail="No audio generated")

    audio = torch.cat(audio_chunks) if len(audio_chunks) > 1 else audio_chunks[0]
    audio_np = audio.numpy() if isinstance(audio, torch.Tensor) else audio

    buf = io.BytesIO()
    sf.write(buf, audio_np, SAMPLE_RATE, format="OGG", subtype="VORBIS")
    buf.seek(0)

    return Response(content=buf.read(), media_type="audio/ogg")
