package com.captainmode.app.engine

import android.content.Context
import android.media.AudioAttributes
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import com.captainmode.app.data.VoiceConfig
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.UUID
import kotlin.coroutines.resume

/** One-shot TTS wrapper: init engine, apply voice config, speak, release. */
class TtsSpeaker(private val context: Context) {

    private var tts: TextToSpeech? = null

    suspend fun init(): Boolean = suspendCancellableCoroutine { cont ->
        var engine: TextToSpeech? = null
        engine = TextToSpeech(context) { status ->
            if (status == TextToSpeech.SUCCESS) {
                tts = engine
                if (cont.isActive) cont.resume(true)
            } else {
                if (cont.isActive) cont.resume(false)
            }
        }
        cont.invokeOnCancellation { engine?.shutdown() }
    }

    fun voices(): List<Voice> = try {
        tts?.voices?.filterNotNull()
            ?.filter { !it.isNetworkConnectionRequired }
            ?.sortedWith(compareBy({ it.locale.toLanguageTag() }, { it.name }))
            ?: emptyList()
    } catch (_: Exception) {
        emptyList()
    }

    fun applyConfig(config: VoiceConfig) {
        val engine = tts ?: return
        engine.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()
        )
        engine.setPitch(config.pitch.coerceIn(0.5f, 2.0f))
        engine.setSpeechRate(config.rate.coerceIn(0.5f, 2.0f))
        val wanted = config.voiceName
        if (wanted != null) {
            val match = try {
                engine.voices?.firstOrNull { it.name == wanted }
            } catch (_: Exception) {
                null
            }
            if (match != null) engine.voice = match
        }
    }

    suspend fun speak(text: String): Boolean {
        val engine = tts ?: return false
        if (text.isBlank()) return false
        return suspendCancellableCoroutine { cont ->
            val id = UUID.randomUUID().toString()
            engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {}

                override fun onDone(utteranceId: String?) {
                    if (utteranceId == id && cont.isActive) cont.resume(true)
                }

                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) {
                    if (utteranceId == id && cont.isActive) cont.resume(false)
                }

                override fun onError(utteranceId: String?, errorCode: Int) {
                    if (utteranceId == id && cont.isActive) cont.resume(false)
                }
            })
            val result = engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, id)
            if (result != TextToSpeech.SUCCESS && cont.isActive) cont.resume(false)
            cont.invokeOnCancellation { engine.stop() }
        }
    }

    fun release() {
        try {
            tts?.stop()
            tts?.shutdown()
        } catch (_: Exception) {
        }
        tts = null
    }
}
