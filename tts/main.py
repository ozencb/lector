import io
import logging
import os
import tempfile
import time
import threading
from typing import Optional

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from kokoro_onnx import Kokoro

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

app = FastAPI(title="Lector TTS Service")

IDLE_TIMEOUT_SECONDS = int(os.environ.get("IDLE_TIMEOUT_SECONDS", "600"))
SAMPLE_RATE = 24000

MODEL_DIR = os.environ.get("MODEL_DIR", os.path.join(os.path.dirname(__file__), "models"))
MODEL_PATH = os.path.join(MODEL_DIR, "kokoro-v1.0.fp16.onnx")
VOICES_PATH = os.path.join(MODEL_DIR, "voices-v1.0.bin")

LANG_CODES = {
    "a": "American English",
    "b": "British English",


    "e": "Spanish",
    "f": "French",
    "h": "Hindi",
    "i": "Italian",
    "p": "Brazilian Portuguese",
}

LANG_TO_ESPEAK = {
    "a": "en-us",
    "b": "en-gb",
    "e": "es",
    "f": "fr-fr",
    "h": "hi",
    "i": "it",
    "p": "pt-br",
}


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


    "e": ["ef_dora", "em_alex", "em_santa"],
    "f": ["ff_siwis"],
    "h": ["hf_alpha", "hf_beta", "hm_omega", "hm_psi"],
    "i": ["if_sara", "im_nicola"],
    "p": ["pf_dora", "pm_alex", "pm_santa"],
}

ALL_VOICE_IDS = {v for voices in VOICES.values() for v in voices}

DEMO_SENTENCES = {
    "a": "The quick brown fox jumps over the lazy dog.",
    "b": "The quick brown fox jumps over the lazy dog.",
    "e": "El rápido zorro marrón salta sobre el perro perezoso.",
    "f": "Le rapide renard brun saute par-dessus le chien paresseux.",
    "h": "तेज़ भूरी लोमड़ी आलसी कुत्ते के ऊपर कूद गई।",
    "i": "La veloce volpe marrone salta sopra il cane pigro.",

    "p": "A rápida raposa marrom pula sobre o cachorro preguiçoso.",

}


class ModelManager:
    def __init__(self, idle_timeout: int):
        self._lock = threading.Lock()
        self._idle_timeout = idle_timeout
        self._kokoro: Optional[Kokoro] = None
        self._last_used: float = 0
        self._unload_timer: Optional[threading.Timer] = None

    def _ensure_loaded(self) -> Kokoro:
        if self._kokoro is not None:
            return self._kokoro
        logger.info("Loading Kokoro ONNX model")
        start = time.time()
        self._kokoro = Kokoro(MODEL_PATH, VOICES_PATH)
        logger.info(f"Model loaded in {time.time() - start:.1f}s")
        return self._kokoro


    def _schedule_unload(self):
        self._unload_timer = threading.Timer(self._idle_timeout, self._idle_unload)
        self._unload_timer.daemon = True
        self._unload_timer.start()

    def _idle_unload(self):
        with self._lock:
            if self._kokoro is None:
                return
            elapsed = time.time() - self._last_used
            if elapsed >= self._idle_timeout:
                logger.info(f"Unloading model (idle {elapsed:.0f}s)")
                del self._kokoro
                self._kokoro = None

                import gc
                gc.collect()

    def synthesize(self, lang_code: str, text: str, voice: str, speed: float = 1.0) -> np.ndarray:
        with self._lock:
            if self._unload_timer:
                self._unload_timer.cancel()
                self._unload_timer = None

            kokoro = self._ensure_loaded()
            self._last_used = time.time()

            espeak_lang = LANG_TO_ESPEAK[lang_code]
            samples, _ = kokoro.create(text, voice=voice, speed=speed, lang=espeak_lang)

            self._schedule_unload()
            return samples

    @property
    def is_loaded(self) -> bool:
        return self._kokoro is not None


model_manager = ModelManager(idle_timeout=IDLE_TIMEOUT_SECONDS)

DEMO_CACHE_DIR = os.path.join(os.path.dirname(__file__), "demo_cache")


def _pregenerate_demos():
    os.makedirs(DEMO_CACHE_DIR, exist_ok=True)
    total = sum(len(v) for v in VOICES.values())
    generated = 0
    for lang_code, voice_ids in VOICES.items():
        text = DEMO_SENTENCES.get(lang_code, DEMO_SENTENCES["a"])
        for voice_id in voice_ids:
            cache_path = os.path.join(DEMO_CACHE_DIR, f"{voice_id}.ogg")
            if os.path.exists(cache_path):
                generated += 1
                continue
            try:
                audio = model_manager.synthesize(lang_code, text, voice_id)
                buf = io.BytesIO()
                sf.write(buf, audio, SAMPLE_RATE, format="OGG", subtype="VORBIS")
                fd, tmp_path = tempfile.mkstemp(dir=DEMO_CACHE_DIR, suffix=".ogg")
                try:
                    os.write(fd, buf.getvalue())
                    os.close(fd)
                    os.rename(tmp_path, cache_path)
                except BaseException:
                    os.close(fd)
                    os.unlink(tmp_path)
                    raise
                generated += 1
                logger.info(f"Pre-generated demo {generated}/{total}: {voice_id}")
            except Exception as e:
                logger.warning(f"Failed to pre-generate demo for {voice_id}: {e}")
    logger.info(f"Demo pre-generation complete: {generated}/{total}")


@app.on_event("startup")
def startup_pregenerate():
    threading.Thread(target=_pregenerate_demos, daemon=True).start()


@app.get("/health")
def health():
    return {"status": "ready"}


@app.get("/voices")
def voices():
    result = {}
    for lang_code in LANG_CODES:
        voice_list = VOICES.get(lang_code, [])
        lang_name = LANG_CODES[lang_code]
        result[lang_name] = [
            {"id": v, "name": v.split("_", 1)[1].replace("_", " ").title()}
            for v in voice_list
        ]
    return result


@app.get("/demo/{voice_id}")
def demo(voice_id: str):
    if voice_id not in ALL_VOICE_IDS:
        raise HTTPException(status_code=400, detail=f"Unknown voice: {voice_id}")

    cache_path = os.path.join(DEMO_CACHE_DIR, f"{voice_id}.ogg")
    if os.path.exists(cache_path):
        with open(cache_path, "rb") as f:
            return Response(content=f.read(), media_type="audio/ogg")

    lang_code = voice_id[0]
    text = DEMO_SENTENCES.get(lang_code, DEMO_SENTENCES["a"])
    audio = model_manager.synthesize(lang_code, text, voice_id)

    buf = io.BytesIO()
    sf.write(buf, audio, SAMPLE_RATE, format="OGG", subtype="VORBIS")
    content = buf.getvalue()

    os.makedirs(DEMO_CACHE_DIR, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=DEMO_CACHE_DIR, suffix=".ogg")
    try:
        os.write(fd, content)
        os.close(fd)
        os.rename(tmp_path, cache_path)
    except BaseException:
        os.close(fd)
        os.unlink(tmp_path)

    return Response(content=content, media_type="audio/ogg")


class SynthesizeRequest(BaseModel):
    text: str = Field(..., max_length=5000)
    voice: str
    language: str


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest):
    if not req.text or not req.text.strip():
        raise HTTPException(status_code=400, detail="Text must not be empty")

    if req.voice not in ALL_VOICE_IDS:
        raise HTTPException(status_code=400, detail=f"Unknown voice: {req.voice}")

    lang_code = req.language
    if lang_code not in LANG_CODES:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown language code: {lang_code}. Valid codes: {list(LANG_CODES.keys())}",
        )

    start = time.time()
    audio = model_manager.synthesize(lang_code, req.text, req.voice)

    buf = io.BytesIO()
    sf.write(buf, audio, SAMPLE_RATE, format="OGG", subtype="VORBIS")
    buf.seek(0)

    elapsed = time.time() - start
    if elapsed > 10:
        logger.info(f"Slow synthesis time={elapsed:.1f}s text_length={len(req.text)}")

    return Response(content=buf.read(), media_type="audio/ogg")
