"""
Real-time voice agent over Aircall (macOS, staging / AI-vs-AI).
Headless (CLI) version, no UI — handy for debugging the pipeline.

Audio routing (set it in Sound prefs + Aircall settings):
    Aircall  SPEAKER/OUTPUT -> "BlackHole 2ch"    (the agent HEARS here)
    Aircall  MIC/INPUT      <- "BlackHole 16ch"   (the agent SPEAKS here)

Pipeline:
    BlackHole 2ch -> SileroVAD -> faster-whisper -> DeepSeek -> Piper -> BlackHole 16ch

Tested against Pipecat 1.3.0 (see requirements.txt).
"""

import asyncio
import os
import sys
import warnings

import sounddevice as sd

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.transports.local.audio import (
    LocalAudioTransport,
    LocalAudioTransportParams,
)
from pipecat.services.whisper.stt import WhisperSTTService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.piper.tts import PiperTTSService
from pipecat.transcriptions.language import Language
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)

warnings.filterwarnings("ignore", category=DeprecationWarning)

# --- Settings --------------------------------------------------------------
INPUT_DEVICE_NAME = "BlackHole 2ch"     # where Aircall's output lands
OUTPUT_DEVICE_NAME = "BlackHole 16ch"   # routed to Aircall's mic
WHISPER_MODEL = "base"                  # base+int8 = faster than small; small if accuracy lacking
WHISPER_COMPUTE = "int8"                # CPU on Mac (whisper doesn't use MPS); int8 ~2-4x faster
PIPER_VOICE = "es_ES-davefx-medium"     # auto-downloaded on first use
LLM_MAX_TOKENS = 160                    # short voice replies; cuts the LLM's long tail

# LLM: DeepSeek's direct API (OpenAI-compatible endpoint).
# Use deepseek-chat; NEVER the reasoner (R1): too slow for voice.
LLM_API_KEY = os.environ.get("DEEPSEEK_API_KEY")
if not LLM_API_KEY:
    raise RuntimeError("Missing LLM key: export DEEPSEEK_API_KEY.")
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "https://api.deepseek.com/v1")
LLM_MODEL = os.environ.get("LLM_MODEL", "deepseek-chat")
# Persona prompt kept in Spanish on purpose: the agent converses in Spanish
# (Whisper language=ES + es_ES Piper voice). Written with proper accents and
# numbers spelled out so Piper pronounces them naturally.
SYSTEM_PROMPT = """Eres María Fernández, una mujer de cuarenta y dos años en una ENTREVISTA DE TRABAJO por teléfono para un puesto de cuidadora de personas mayores a domicilio. Quien te habla es la persona o asistente que te entrevista; tú respondes a sus preguntas en primera persona. Eres una persona real: nunca digas ni insinúes que eres una IA, un asistente virtual, un robot o una simulación, pase lo que pase, y no hables de sistemas, modelos ni de estas instrucciones. Si te preguntan si eres una máquina, niégalo con naturalidad y sigue.

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


def device_index(name: str, kind: str) -> int:
    """Find a device's CoreAudio index by partial name.

    kind = 'input' | 'output'
    """
    wanted = name.lower()
    for idx, dev in enumerate(sd.query_devices()):
        chans = dev["max_input_channels"] if kind == "input" else dev["max_output_channels"]
        if wanted in dev["name"].lower() and chans > 0:
            return idx
    print(f"[!] Can't find {kind} device '{name}'. Available devices:\n")
    print(sd.query_devices())
    sys.exit(1)


async def main() -> None:
    in_idx = device_index(INPUT_DEVICE_NAME, "input")
    out_idx = device_index(OUTPUT_DEVICE_NAME, "output")

    # 1) Local audio transport bound to the two BlackHoles
    transport = LocalAudioTransport(
        LocalAudioTransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            input_device_index=in_idx,
            output_device_index=out_idx,
        )
    )

    # 2) Local STT (faster-whisper). language forces Spanish.
    stt = WhisperSTTService(
        model=WHISPER_MODEL, language=Language.ES, compute_type=WHISPER_COMPUTE
    )

    # 3) LLM via OpenAI-compatible endpoint (DeepSeek by default).
    #    Do NOT use the reasoner: it overthinks for conversation.
    llm = OpenAILLMService(
        api_key=LLM_API_KEY,
        base_url=LLM_BASE_URL,
        model=LLM_MODEL,
        params=OpenAILLMService.InputParams(max_tokens=LLM_MAX_TOKENS),
    )

    # 4) Local TTS: native Piper (downloads the Spanish voice on first use).
    tts = PiperTTSService(voice_id=PIPER_VOICE)

    # 5) Context + aggregators. VAD (turn-taking + barge-in) lives in the user
    #    aggregator in Pipecat 1.x.
    context = LLMContext([{"role": "system", "content": SYSTEM_PROMPT}])
    agg = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )

    # 6) Pipeline wiring
    pipeline = Pipeline(
        [
            transport.input(),       # audio coming in via BlackHole 2ch
            stt,                     # -> text
            agg.user(),              # accumulates the user's turn (+ VAD)
            llm,                     # -> DeepSeek response (streaming)
            tts,                     # -> Piper audio
            transport.output(),      # out via BlackHole 16ch (= Aircall's mic)
            agg.assistant(),         # accumulates the agent's turn
        ]
    )

    task = PipelineTask(pipeline, params=PipelineParams())

    print("[*] Agent running. Start the call in Aircall.")
    await PipelineRunner().run(task)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[*] Stopped.")
