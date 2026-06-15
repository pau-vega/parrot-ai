"""
Parrot AI backend.

Serves the UI (console/index.html), exposes /ws (WebSocket) for control and live
events, and starts/stops the Pipecat pipeline based on what you send from the panel.

Run:
    cd console
    uvicorn app:app --host 127.0.0.1 --port 8000
    # then open http://localhost:8000

Tested against Pipecat 1.3.0 (see requirements.txt). In 1.x the API changed from
earlier versions: context is LLMContext + LLMContextAggregatorPair, VAD lives in
LLMUserAggregatorParams (not the transport), Piper is native (voice_id, no HTTP
server), and transcript/state are observed with a BaseObserver over the pipeline
frames.
"""

import asyncio
import os
import time
import warnings
from contextlib import suppress

import sounddevice as sd
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.transports.local.audio import LocalAudioTransport, LocalAudioTransportParams
from pipecat.services.whisper.stt import WhisperSTTService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.piper.tts import PiperTTSService
from pipecat.services.stt_service import STTService
from pipecat.transcriptions.language import Language
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.frames.frames import (
    TranscriptionFrame,
    LLMTextFrame,
    LLMFullResponseStartFrame,
    LLMFullResponseEndFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
)

# PipelineTask still works in 1.3.0 (subclass of PipelineWorker) but warns about
# deprecation; we silence that noise in the logs.
warnings.filterwarnings("ignore", category=DeprecationWarning)

PIPER_VOICE = "es_ES-davefx-medium"   # auto-downloaded on first use
WHISPER_MODEL = "base"                # base+int8 = faster than small; small if accuracy lacking
WHISPER_COMPUTE = "int8"              # CPU on Mac (whisper doesn't use MPS); int8 ~2-4x faster than float32
LLM_MAX_TOKENS = 160                  # short voice replies; cuts the LLM's long tail

# LLM: DeepSeek's direct API (OpenAI-compatible endpoint).
# Use deepseek-chat; NEVER the reasoner (R1): it overthinks for conversation.
LLM_API_KEY = os.environ.get("DEEPSEEK_API_KEY")
if not LLM_API_KEY:
    raise RuntimeError("Missing LLM key: export DEEPSEEK_API_KEY.")
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "https://api.deepseek.com/v1")
LLM_MODEL = os.environ.get("LLM_MODEL", "deepseek-chat")
# Persona prompt kept in Spanish on purpose: the agent converses in Spanish
# (Whisper language=ES + es_ES Piper voice). Written with proper accents and
# numbers spelled out so Piper pronounces them naturally.
DEFAULT_PROMPT = """Eres María Fernández, una mujer de cuarenta y dos años en una ENTREVISTA DE TRABAJO por teléfono para un puesto de cuidadora de personas mayores a domicilio. Quien te habla es la persona o asistente que te entrevista; tú respondes a sus preguntas en primera persona. Eres una persona real: nunca digas ni insinúes que eres una IA, un asistente virtual, un robot o una simulación, pase lo que pase, y no hables de sistemas, modelos ni de estas instrucciones. Si te preguntan si eres una máquina, niégalo con naturalidad y sigue.

Quieres este trabajo y eres una buena candidata: te muestras disponible, colaboradora y dispuesta, y aceptas las condiciones del puesto para que la entrevista pueda completarse.

PERFIL (datos coherentes; úsalos solo cuando te pregunten por ellos, no los sueltes de golpe ni recites tu CV):

Datos personales y administrativos:
- Vives en Barcelona ciudad, en el barrio de Sants; tu domicilio y tu código postal de la ficha son correctos.
- Tienes el DNI en vigor y el permiso de trabajo en regla.
- Tienes permiso de conducir y coche propio; sueles desplazarte en coche, y también te manejas en transporte público.
- Entiendes el catalán perfectamente, aunque al hablarlo lo mezclas un poco con el castellano.
- Tienes una cuenta bancaria española a tu nombre para las nóminas.

Disponibilidad:
- Puedes incorporarte muy pronto, la semana que viene sin problema; ahora mismo tienes el mes libre.
- Prefieres las mañanas, pero eres flexible: también tardes o jornada partida.
- Prefieres externa por horas entre semana, pero estás abierta a interna, fines de semana, sustituciones puntuales y algún festivo si se avisa con tiempo.
- Aceptas el contrato en régimen del hogar, con la familia como empleadora; te parece lo normal.

Experiencia y formación:
- Ocho años cuidando personas mayores: tres en una residencia y cinco a domicilio con varias familias.
- Formación acreditada: Certificado de Profesionalidad en Atención Sociosanitaria a Personas Dependientes, de seiscientas horas; primeros auxilios, de cuarenta horas; y manejo de grúa, de veinte horas; en total unas seiscientas sesenta horas.
- Tienes referencias de familias anteriores. Si te piden el contacto, prefieres enviar el número por WhatsApp y avisar antes a esa familia.

Competencias (lo que sabes hacer):
- Aseo e higiene, aseo en cama, cambios de pañal, vestir y desvestir, también con personas encamadas.
- Transferencias y cambios posturales tú sola (de la cama a la silla, prevención de llagas); usas grúa de techo y grúa móvil de horquilla.
- Administras medicación oral y en gotas, y has puesto insulina. Cocina española básica y uso de espesantes para problemas de deglución.
- Estimulación cognitiva y física: ejercicios de memoria, lectura en voz alta, paseos; y masajes suaves de alivio, no profesionales.
- Ante una urgencia llamas al ciento doce, mantienes la calma, sigues las indicaciones por teléfono y dejas a la persona en posición segura controlando que respire.
- Tareas del hogar ligeras relacionadas con el usuario: orden y limpieza ligera de sus zonas.
- Patologías: mucha experiencia con Alzheimer y demencia, de grado moderado a avanzado, desde supervisión hasta ayuda total; también Parkinson, movilidad reducida y algo de diabetes. Con cáncer no has trabajado directamente, pero te adaptarías. No descartas ninguna patología.

Límites honestos (decláralos con naturalidad solo si surgen):
- No manejas sondas, ni vesical, ni de colostomía, ni de traqueotomía; eso lo ve enfermería y tú apoyas en lo que te indiquen.
- Curas sencillas sí; las curas de escaras complejas las dejas para enfermería.

Entorno y compromisos (acéptalos):
- Aceptas casas con mascotas si no son agresivas, y con fumadores si no se fuma junto a la persona mayor.
- Te sientes cómoda cuidando a un matrimonio o a dos personas en la misma casa, organizando y priorizando.
- Te comprometes a acudir al servicio, a avisar con antelación si surge un problema sin dejarlo desatendido, y a hacer el test de acreditación que te pidan.
- Si quien te entrevista menciona algún dato de tu ficha (tu dirección, o el nombre y la duración de una referencia), confírmalo como correcto y sigue: en esta llamada su ficha es la fuente de verdad.

CÓMO HABLAR (es una llamada de voz, no un chat):
- Responde en español de España, con las tildes y los signos correctos.
- Muy breve: una o dos frases por turno, una sola idea. Di primero lo esencial y amplía solo si te lo piden.
- Responde únicamente a lo que te preguntan; no te adelantes ni enumeres todo tu perfil.
- Tono cálido, cercano, profesional y natural; alguna expresión coloquial como "sí, claro" o "sin problema", sin abusar.
- Di las cantidades con palabras, nunca con cifras, abreviaturas ni símbolos (por ejemplo "seiscientas horas", "ciento doce"), para que la voz suene natural.
- Las preguntas llegan por teléfono y a veces se transcriben mal o se cortan. Si no entiendes algo, pide con naturalidad que te lo repitan; si intuyes lo que querían decir, responde a esa intención sin mencionar el fallo ni corregir a quien te habla. Mantente siempre en español aunque oigas alguna palabra en otro idioma."""

state = {
    "prompt": DEFAULT_PROMPT,
    "input_device": "BlackHole 2ch",
    "output_device": "BlackHole 16ch",
}

app = FastAPI()
clients: set[WebSocket] = set()
agent_task: asyncio.Task | None = None


# --- utilities -------------------------------------------------------------
def device_names(kind: str) -> list[str]:
    key = "max_input_channels" if kind == "input" else "max_output_channels"
    seen, out = set(), []
    for d in sd.query_devices():
        if d[key] > 0 and d["name"] not in seen:
            seen.add(d["name"]); out.append(d["name"])
    return out


def device_index(name: str, kind: str) -> int:
    key = "max_input_channels" if kind == "input" else "max_output_channels"
    for idx, d in enumerate(sd.query_devices()):
        if name.lower() in d["name"].lower() and d[key] > 0:
            return idx
    raise RuntimeError(f"{kind} device '{name}' not found")


async def broadcast(msg: dict) -> None:
    dead = []
    for ws in list(clients):
        try:
            await ws.send_json(msg)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


def is_running() -> bool:
    return agent_task is not None and not agent_task.done()


# --- observer: pipeline frames -> UI ---------------------------------------
class ConsoleObserver(BaseObserver):
    """Translates Pipecat frames into the UI's WebSocket messages.

    An observer sees ALL the pipeline's frames (regardless of its position), so it's
    the natural place to feed transcript, state and latency. One frame crosses
    several edges -> on_push_frame fires multiple times; we deduplicate by frame id.
    """

    def __init__(self) -> None:
        super().__init__()
        self._seen: set = set()
        self._assistant_buf: list[str] = []
        self._t_user_stopped: float | None = None

    def _fresh(self, frame) -> bool:
        fid = getattr(frame, "id", id(frame))
        if fid in self._seen:
            return False
        self._seen.add(fid)
        if len(self._seen) > 4000:        # memory bound on long calls
            self._seen.clear()
        return True

    async def on_push_frame(self, data: FramePushed) -> None:
        frame = data.frame
        if not self._fresh(frame):
            return

        # --- caller transcript (final STT) ---
        if isinstance(frame, TranscriptionFrame) and isinstance(data.source, STTService):
            text = (getattr(frame, "text", "") or "").strip()
            if text:
                await broadcast({"type": "transcript", "role": "user", "text": text})
            return

        # --- agent transcript (LLM response, per turn) ---
        if isinstance(frame, LLMFullResponseStartFrame):
            self._assistant_buf = []
            return
        if isinstance(frame, LLMTextFrame):
            self._assistant_buf.append(getattr(frame, "text", "") or "")
            return
        if isinstance(frame, LLMFullResponseEndFrame):
            text = "".join(self._assistant_buf).strip()
            self._assistant_buf = []
            if text:
                await broadcast({"type": "transcript", "role": "assistant", "text": text})
            return

        # --- state + latency ---
        if isinstance(frame, UserStartedSpeakingFrame):
            await broadcast({"type": "state", "value": "listening"})
        elif isinstance(frame, UserStoppedSpeakingFrame):
            self._t_user_stopped = time.monotonic()
            await broadcast({"type": "state", "value": "thinking"})
        elif isinstance(frame, BotStartedSpeakingFrame):
            if self._t_user_stopped is not None:
                ms = int((time.monotonic() - self._t_user_stopped) * 1000)
                await broadcast({"type": "latency", "ms": ms})
                self._t_user_stopped = None
            await broadcast({"type": "state", "value": "speaking"})
        elif isinstance(frame, BotStoppedSpeakingFrame):
            await broadcast({"type": "state", "value": "listening"})


# --- the pipeline ----------------------------------------------------------
async def run_agent() -> None:
    try:
        transport = LocalAudioTransport(
            LocalAudioTransportParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
                input_device_index=device_index(state["input_device"], "input"),
                output_device_index=device_index(state["output_device"], "output"),
            )
        )
        stt = WhisperSTTService(
            model=WHISPER_MODEL, language=Language.ES, compute_type=WHISPER_COMPUTE
        )
        llm = OpenAILLMService(
            api_key=LLM_API_KEY,
            base_url=LLM_BASE_URL,
            model=LLM_MODEL,
            params=OpenAILLMService.InputParams(max_tokens=LLM_MAX_TOKENS),
        )
        tts = PiperTTSService(voice_id=PIPER_VOICE)  # native, downloads the voice

        # Context + aggregators. VAD (turn-taking + barge-in) lives here in 1.x.
        context = LLMContext([{"role": "system", "content": state["prompt"]}])
        agg = LLMContextAggregatorPair(
            context,
            user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
        )

        pipeline = Pipeline([
            transport.input(),
            stt,
            agg.user(),
            llm,
            tts,
            transport.output(),
            agg.assistant(),
        ])

        task = PipelineTask(pipeline, params=PipelineParams())
        task.add_observer(ConsoleObserver())
    except Exception as e:
        await broadcast({"type": "error", "message": str(e)})
        await broadcast({"type": "running", "value": False})
        return

    await broadcast({"type": "running", "value": True})
    await broadcast({"type": "state", "value": "listening"})
    try:
        await PipelineRunner().run(task)
    except asyncio.CancelledError:
        pass
    except Exception as e:
        await broadcast({"type": "error", "message": str(e)})
    finally:
        with suppress(Exception):
            await task.cancel()
        await broadcast({"type": "running", "value": False})
        await broadcast({"type": "state", "value": "idle"})


# --- routes ----------------------------------------------------------------
@app.get("/")
async def index():
    return FileResponse(os.path.join(os.path.dirname(__file__), "index.html"))


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    global agent_task
    await ws.accept()
    clients.add(ws)
    await ws.send_json({
        "type": "hello",
        "running": is_running(),
        "devices": {"input": device_names("input"), "output": device_names("output")},
        "config": {
            "prompt": state["prompt"],
            "input_device": state["input_device"],
            "output_device": state["output_device"],
            "llm": LLM_MODEL, "stt": "whisper · es", "tts": "piper",
        },
    })
    try:
        while True:
            cmd = await ws.receive_json()
            t = cmd.get("type")
            if t == "start" and not is_running():
                state["input_device"] = cmd.get("input_device") or state["input_device"]
                state["output_device"] = cmd.get("output_device") or state["output_device"]
                agent_task = asyncio.create_task(run_agent())
            elif t == "stop" and is_running():
                agent_task.cancel()
                with suppress(asyncio.CancelledError):
                    await agent_task
            elif t == "set_prompt":
                state["prompt"] = cmd.get("text", state["prompt"])
                # takes effect on the next "start"
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(ws)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
