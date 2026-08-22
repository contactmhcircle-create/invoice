package com.captainmode.app.engine

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.MediaPlayer
import android.net.Uri
import com.captainmode.app.data.ChimeConfig
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.math.PI
import kotlin.math.min
import kotlin.math.sin

/** Plays the airline cabin chime — synthesized in-app, or a user-provided sound file. */
object ChimePlayer {

    private const val SAMPLE_RATE = 44100

    suspend fun play(context: Context, chime: ChimeConfig) {
        if (!chime.enabled) return
        val custom = chime.customUri
        if (custom != null) {
            playUri(context, Uri.parse(custom))
        } else {
            playSynth(chime.style)
        }
        delay(chime.gapAfterMs.toLong().coerceIn(0, 5000))
    }

    private suspend fun playSynth(style: String) {
        val pcm: ShortArray = when (style) {
            "single" -> tones(listOf(784.0 to 900))
            "triple" -> tones(listOf(659.0 to 450, 784.0 to 450, 988.0 to 800))
            else -> tones(listOf(988.0 to 500, 784.0 to 900)) // classic ding-dong
        }
        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setSampleRate(SAMPLE_RATE)
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setTransferMode(AudioTrack.MODE_STATIC)
            .setBufferSizeInBytes(pcm.size * 2)
            .build()
        try {
            track.write(pcm, 0, pcm.size)
            track.play()
            delay(pcm.size * 1000L / SAMPLE_RATE + 100)
        } finally {
            try {
                track.stop()
            } catch (_: IllegalStateException) {
            }
            track.release()
        }
    }

    /** Renders a sequence of (frequencyHz to durationMs) tones with soft attack/decay. */
    private fun tones(notes: List<Pair<Double, Int>>): ShortArray {
        val total = notes.sumOf { it.second } * SAMPLE_RATE / 1000
        val out = ShortArray(total)
        var offset = 0
        for ((freq, durMs) in notes) {
            val n = durMs * SAMPLE_RATE / 1000
            val attack = SAMPLE_RATE / 100 // 10ms
            for (i in 0 until n) {
                val t = i.toDouble() / SAMPLE_RATE
                val attackEnv = min(1.0, i.toDouble() / attack)
                val decayEnv = Math.exp(-3.0 * i / n)
                val sample = sin(2 * PI * freq * t) * attackEnv * decayEnv * 0.6
                val idx = offset + i
                if (idx < out.size) out[idx] = (sample * Short.MAX_VALUE).toInt().toShort()
            }
            offset += n
        }
        return out
    }

    suspend fun playUri(context: Context, uri: Uri) {
        suspendCancellableCoroutine { cont ->
            val mp = MediaPlayer()
            fun finish() {
                try {
                    mp.release()
                } catch (_: Exception) {
                }
                if (cont.isActive) cont.resume(Unit)
            }
            try {
                mp.setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build()
                )
                mp.setDataSource(context, uri)
                mp.setOnCompletionListener { finish() }
                mp.setOnErrorListener { _, _, _ ->
                    finish()
                    true
                }
                mp.prepare()
                mp.start()
                cont.invokeOnCancellation { finish() }
            } catch (_: Exception) {
                finish()
            }
        }
    }
}
