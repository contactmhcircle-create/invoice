package com.captainmode.app.engine

import com.captainmode.app.data.AppConfig
import com.captainmode.app.data.CarProfile
import com.captainmode.app.data.PhraseLibrary
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale
import kotlin.math.roundToInt
import kotlin.random.Random

/**
 * Assembles a full cabin announcement from the phrase library:
 * [attention] [welcome] [weather report] [ride forecast by condition] [traffic if rush hour] [sign-off],
 * unless a special script's day/time rules match, in which case that script is used whole.
 */
object Composer {

    data class Result(val text: String, val updatedPicks: Map<String, Int>)

    fun composeConnect(
        config: AppConfig,
        car: CarProfile?,
        weather: WeatherInfo?,
        now: LocalDateTime,
        batteryPct: Int?
    ): Result {
        val library = effectiveLibrary(config, car)
        val picks = config.recentPicks.toMutableMap()
        val vars = buildVars(config, car, weather, now, batteryPct)

        val special = matchingSpecial(library, now, picks)
        val raw = special ?: buildString {
            append(pick("attention", library.attention, picks) ?: "")
            appendPart(pick("welcome", library.welcome, picks))
            if (weather != null) {
                appendPart(pick("weatherReport", library.weatherReport, picks))
                val ridePool = library.rideForecast[weather.condition].orEmpty()
                appendPart(pick("ride_${weather.condition}", ridePool, picks))
            }
            if (config.rushHourEnabled && isRushHour(config, now)) {
                appendPart(pick("traffic", library.traffic, picks))
            }
            appendPart(pick("signOff", library.signOff, picks))
        }

        return Result(substituteAndClean(raw, vars), picks)
    }

    fun composeDisconnect(
        config: AppConfig,
        car: CarProfile?,
        now: LocalDateTime
    ): Result {
        val library = effectiveLibrary(config, car)
        val picks = config.recentPicks.toMutableMap()
        val vars = buildVars(config, car, weather = null, now = now, batteryPct = null)
        val raw = pick("disconnect", library.disconnect, picks) ?: ""
        return Result(substituteAndClean(raw, vars), picks)
    }

    private fun StringBuilder.appendPart(part: String?) {
        if (!part.isNullOrBlank()) {
            if (isNotEmpty()) append(' ')
            append(part)
        }
    }

    private fun effectiveLibrary(config: AppConfig, car: CarProfile?): PhraseLibrary =
        if (car != null && car.useCustomPhrases && car.customLibrary != null) car.customLibrary
        else config.library

    private fun matchingSpecial(
        library: PhraseLibrary,
        now: LocalDateTime,
        picks: MutableMap<String, Int>
    ): String? {
        val minute = now.hour * 60 + now.minute
        val day = now.dayOfWeek.value // Monday=1..Sunday=7
        val candidates = library.specials.filter { s ->
            if (!s.enabled) return@filter false
            if (s.days.isNotEmpty() && day !in s.days) return@filter false
            val start = s.startMinute
            val end = s.endMinute
            if (start == null || end == null) true
            else if (start <= end) minute in start..end
            else minute >= start || minute <= end // crosses midnight
        }
        if (candidates.isEmpty()) return null
        val idx = pickIndex("specials", candidates.size, picks)
        return candidates[idx].text
    }

    private fun pick(slotKey: String, pool: List<String>, picks: MutableMap<String, Int>): String? {
        if (pool.isEmpty()) return null
        val idx = pickIndex(slotKey, pool.size, picks)
        return pool[idx]
    }

    private fun pickIndex(slotKey: String, size: Int, picks: MutableMap<String, Int>): Int {
        if (size == 1) {
            picks[slotKey] = 0
            return 0
        }
        val last = picks[slotKey]
        var idx = Random.nextInt(size)
        if (idx == last) idx = (idx + 1 + Random.nextInt(size - 1)) % size
        picks[slotKey] = idx
        return idx
    }

    private fun isRushHour(config: AppConfig, now: LocalDateTime): Boolean {
        if (now.dayOfWeek.value > 5) return false
        val m = now.hour * 60 + now.minute
        return m in config.rushMorningStart..config.rushMorningEnd ||
                m in config.rushEveningStart..config.rushEveningEnd
    }

    fun buildVars(
        config: AppConfig,
        car: CarProfile?,
        weather: WeatherInfo?,
        now: LocalDateTime,
        batteryPct: Int?
    ): Map<String, String?> {
        val daypart = when (now.hour) {
            in 5..11 -> "morning"
            in 12..16 -> "afternoon"
            else -> "evening"
        }
        val timeFmt = if (config.use24hTime) DateTimeFormatter.ofPattern("H:mm")
        else DateTimeFormatter.ofPattern("h:mm a")
        val temp = weather?.let {
            val t = if (config.useFahrenheit) it.tempC * 9.0 / 5.0 + 32.0 else it.tempC
            t.roundToInt().toString()
        }
        return mapOf(
            "greeting" to "Good $daypart",
            "daypart" to daypart,
            "airline" to (car?.airlineOverride?.takeIf { it.isNotBlank() } ?: config.airlineName),
            "captain" to config.captainName,
            "car" to (car?.spokenName?.takeIf { it.isNotBlank() } ?: "your vehicle"),
            "time" to now.format(timeFmt),
            "day" to now.dayOfWeek.getDisplayName(TextStyle.FULL, Locale.ENGLISH),
            "date" to now.format(DateTimeFormatter.ofPattern("MMMM d")),
            "battery" to batteryPct?.toString(),
            "temp" to temp,
            "weather" to weather?.description
        )
    }

    /**
     * Substitutes {variables}; any sentence still containing an unresolved
     * placeholder afterwards (e.g. weather unavailable) is dropped whole,
     * so the announcement degrades gracefully instead of reading errors aloud.
     */
    fun substituteAndClean(template: String, vars: Map<String, String?>): String {
        var text = template
        for ((key, value) in vars) {
            if (value != null) text = text.replace("{$key}", value)
        }
        val sentences = text.split(Regex("(?<=[.!?])\\s+"))
        return sentences
            .filter { !it.contains('{') }
            .joinToString(" ")
            .trim()
    }
}
