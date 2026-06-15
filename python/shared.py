"""
Shared config + pipeline construction for Parrot AI.

Both python/pipeline.py (IPC mode) and python/agent.py (headless CLI) import
from here so the persona prompt, the LLM/STT/TTS config and the Pipecat wiring
live in ONE place and cannot drift apart.

Tested against Pipecat 1.3.0 (see python/requirements.txt).
"""

import os

import sounddevice as sd

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.transports.local.audio import LocalAudioTransport, LocalAudioTransportParams
from pipecat.services.whisper.stt import WhisperSTTService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.piper.tts import PiperTTSService
from pipecat.transcriptions.language import Language
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)

# --- model / service config --------------------------------------------------

PIPER_VOICE = "es_ES-davefx-medium"  # auto-downloaded on first use
WHISPER_MODEL = "base"               # base+int8 = faster than small; small if accuracy lacking
WHISPER_COMPUTE = "int8"             # CPU on Mac (whisper doesn't use MPS); int8 ~2-4x faster
LLM_MAX_TOKENS = 160                 # short voice replies; cuts the LLM's long tail

# LLM: DeepSeek's direct API (OpenAI-compatible endpoint).
# Use deepseek-chat; NEVER the reasoner (R1): it overthinks for conversation.
LLM_API_KEY = os.environ.get("DEEPSEEK_API_KEY")
if not LLM_API_KEY:
    raise RuntimeError("Missing LLM key: export DEEPSEEK_API_KEY.")
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "https://api.deepseek.com/v1")
LLM_MODEL = os.environ.get("LLM_MODEL", "deepseek-chat")

# Default device names. Two distinct BlackHole devices keep the two call
# directions separate, so there is no echo (see CLAUDE.md).
DEFAULT_INPUT_DEVICE = "BlackHole 2ch"    # where Aircall's output lands (agent HEARS)
DEFAULT_OUTPUT_DEVICE = "BlackHole 16ch"  # routed to Aircall's mic (agent SPEAKS)

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


# --- device helpers ----------------------------------------------------------

def device_names(kind: str, devices=None) -> list[str]:
    """Unique device names exposing channels of `kind` ('input' | 'output').

    Pass a cached `devices` list to avoid re-querying CoreAudio.
    """
    devices = sd.query_devices() if devices is None else devices
    key = "max_input_channels" if kind == "input" else "max_output_channels"
    seen: set[str] = set()
    out: list[str] = []
    for d in devices:
        if d[key] > 0 and d["name"] not in seen:
            seen.add(d["name"])
            out.append(d["name"])
    return out


def device_index(name: str, kind: str, devices=None) -> int:
    """CoreAudio index of the first `kind` device whose name contains `name`.

    Pairing is by substring because duplicate BlackHole installs get numbered
    (see CLAUDE.md). Raises RuntimeError if no match. Pass a cached `devices`
    list to avoid re-querying CoreAudio.
    """
    devices = sd.query_devices() if devices is None else devices
    key = "max_input_channels" if kind == "input" else "max_output_channels"
    for idx, d in enumerate(devices):
        if name.lower() in d["name"].lower() and d[key] > 0:
            return idx
    raise RuntimeError(f"{kind} device '{name}' not found")


# --- pipeline construction ---------------------------------------------------

def build_task(prompt: str, input_device: str, output_device: str) -> PipelineTask:
    """Build the STT -> LLM -> TTS Pipecat task bound to the two BlackHoles.

    Queries CoreAudio once and resolves both device indices from that snapshot.
    The caller attaches observers and runs the task.
    """
    devices = sd.query_devices()

    transport = LocalAudioTransport(
        LocalAudioTransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            input_device_index=device_index(input_device, "input", devices),
            output_device_index=device_index(output_device, "output", devices),
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
    tts = PiperTTSService(voice_id=PIPER_VOICE)

    context = LLMContext([{"role": "system", "content": prompt}])
    agg = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )

    pipeline = Pipeline([
        transport.input(),   # audio coming in via the input BlackHole
        stt,                 # -> text
        agg.user(),          # accumulates the user's turn (+ VAD)
        llm,                 # -> DeepSeek response (streaming)
        tts,                 # -> Piper audio
        transport.output(),  # out via the output BlackHole (= Aircall's mic)
        agg.assistant(),     # accumulates the agent's turn
    ])

    return PipelineTask(pipeline, params=PipelineParams())
