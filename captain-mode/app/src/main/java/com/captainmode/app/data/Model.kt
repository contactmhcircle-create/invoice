package com.captainmode.app.data

import kotlinx.serialization.Serializable

@Serializable
enum class Condition { CLEAR, CLOUDS, RAIN, WIND, FOG, SNOW, STORM }

@Serializable
data class VoiceConfig(
    val voiceName: String? = null,
    val pitch: Float = 1.0f,
    val rate: Float = 0.92f
)

@Serializable
data class ChimeConfig(
    val enabled: Boolean = true,
    // "single", "double", "triple"
    val style: String = "double",
    val customUri: String? = null,
    val gapAfterMs: Int = 500
)

@Serializable
data class SpecialScript(
    val id: String,
    val label: String,
    val text: String,
    val enabled: Boolean = true,
    // ISO day numbers, Monday=1..Sunday=7; empty = any day
    val days: List<Int> = emptyList(),
    // minutes since midnight; null = any time
    val startMinute: Int? = null,
    val endMinute: Int? = null
)

@Serializable
data class PhraseLibrary(
    val attention: List<String> = emptyList(),
    val welcome: List<String> = emptyList(),
    val weatherReport: List<String> = emptyList(),
    val rideForecast: Map<Condition, List<String>> = emptyMap(),
    val traffic: List<String> = emptyList(),
    val signOff: List<String> = emptyList(),
    val disconnect: List<String> = emptyList(),
    val specials: List<SpecialScript> = emptyList()
)

@Serializable
data class CarProfile(
    val id: String,
    val mac: String,
    val btName: String,
    val spokenName: String,
    val enabled: Boolean = true,
    val delaySeconds: Float = 3.5f,
    // null = don't touch volume; otherwise 0..100 of max media volume
    val volumePercent: Int? = null,
    val airlineOverride: String? = null,
    // when set, played instead of TTS on connect
    val customAudioUri: String? = null,
    val customAudioName: String? = null,
    val useCustomPhrases: Boolean = false,
    val customLibrary: PhraseLibrary? = null,
    val voiceOverride: VoiceConfig? = null
)

@Serializable
data class AppConfig(
    val onboarded: Boolean = false,
    val masterEnabled: Boolean = true,
    val airlineName: String = "Captain Airways",
    val captainName: String = "Captain",
    val use24hTime: Boolean = false,
    val useFahrenheit: Boolean = false,

    val weatherEnabled: Boolean = true,
    val useDeviceLocation: Boolean = true,
    val manualLat: Double? = null,
    val manualLon: Double? = null,
    val manualLocationName: String? = null,

    val quietHoursEnabled: Boolean = false,
    val quietStartMinute: Int = 23 * 60,
    val quietEndMinute: Int = 6 * 60,

    val rushHourEnabled: Boolean = true,
    val rushMorningStart: Int = 7 * 60 + 30,
    val rushMorningEnd: Int = 9 * 60 + 30,
    val rushEveningStart: Int = 16 * 60 + 30,
    val rushEveningEnd: Int = 19 * 60,

    val announceOnDisconnect: Boolean = false,
    val announceUnknownDevices: Boolean = false,

    // Wait until audio actually routes to Bluetooth before speaking —
    // many head units take 15-20s to boot their audio system after pairing.
    val waitForCarAudio: Boolean = true,
    val carAudioTimeoutSeconds: Int = 45,
    val playOnPhoneIfNoCarAudio: Boolean = false,

    val chime: ChimeConfig = ChimeConfig(),
    val voice: VoiceConfig = VoiceConfig(),
    val library: PhraseLibrary = PhraseLibrary(),
    val cars: List<CarProfile> = emptyList(),

    // slot key -> last pick index, used for no-repeat selection
    val recentPicks: Map<String, Int> = emptyMap()
)
