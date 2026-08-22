package com.captainmode.app.engine

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import com.captainmode.app.data.AppConfig
import com.captainmode.app.data.Condition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

data class WeatherInfo(
    val tempC: Double,
    val condition: Condition,
    val description: String
)

data class GeoResult(
    val name: String,
    val region: String,
    val lat: Double,
    val lon: Double
)

object WeatherClient {

    suspend fun fetchForConfig(context: Context, config: AppConfig): WeatherInfo? {
        if (!config.weatherEnabled) return null
        val loc = resolveLocation(context, config) ?: return null
        return fetch(loc.first, loc.second)
    }

    private fun resolveLocation(context: Context, config: AppConfig): Pair<Double, Double>? {
        if (config.useDeviceLocation && hasLocationPermission(context)) {
            val lm = context.getSystemService(LocationManager::class.java)
            val providers = listOf(
                LocationManager.PASSIVE_PROVIDER,
                LocationManager.NETWORK_PROVIDER,
                LocationManager.GPS_PROVIDER
            )
            for (p in providers) {
                try {
                    val l = lm.getLastKnownLocation(p)
                    if (l != null) return l.latitude to l.longitude
                } catch (_: SecurityException) {
                } catch (_: IllegalArgumentException) {
                }
            }
        }
        val lat = config.manualLat
        val lon = config.manualLon
        if (lat != null && lon != null) return lat to lon
        return null
    }

    fun hasLocationPermission(context: Context): Boolean =
        context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED ||
        context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED

    suspend fun fetch(lat: Double, lon: Double): WeatherInfo? = withContext(Dispatchers.IO) {
        try {
            val url = "https://api.open-meteo.com/v1/forecast" +
                    "?latitude=$lat&longitude=$lon" +
                    "&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto"
            val body = httpGet(url) ?: return@withContext null
            val root = Json.parseToJsonElement(body).jsonObject
            val current = root["current"]?.jsonObject ?: return@withContext null
            val temp = current["temperature_2m"]?.jsonPrimitive?.doubleOrNull
                ?: return@withContext null
            val code = current["weather_code"]?.jsonPrimitive?.intOrNull ?: 0
            val wind = current["wind_speed_10m"]?.jsonPrimitive?.doubleOrNull ?: 0.0
            val (condition, description) = interpret(code, wind)
            WeatherInfo(tempC = temp, condition = condition, description = description)
        } catch (_: Exception) {
            null
        }
    }

    suspend fun searchCity(query: String): List<GeoResult> = withContext(Dispatchers.IO) {
        try {
            val q = URLEncoder.encode(query, "UTF-8")
            val url = "https://geocoding-api.open-meteo.com/v1/search?name=$q&count=6"
            val body = httpGet(url) ?: return@withContext emptyList()
            val root = Json.parseToJsonElement(body).jsonObject
            val results = root["results"]?.jsonArray ?: return@withContext emptyList()
            results.mapNotNull { el ->
                val o = el.jsonObject
                val name = o["name"]?.jsonPrimitive?.content ?: return@mapNotNull null
                val lat = o["latitude"]?.jsonPrimitive?.doubleOrNull ?: return@mapNotNull null
                val lon = o["longitude"]?.jsonPrimitive?.doubleOrNull ?: return@mapNotNull null
                val region = listOfNotNull(
                    o["admin1"]?.jsonPrimitive?.content,
                    o["country"]?.jsonPrimitive?.content
                ).joinToString(", ")
                GeoResult(name, region, lat, lon)
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun httpGet(urlStr: String): String? {
        val conn = URL(urlStr).openConnection() as HttpURLConnection
        return try {
            conn.connectTimeout = 5000
            conn.readTimeout = 5000
            if (conn.responseCode != 200) null
            else conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }

    private fun interpret(code: Int, windKmh: Double): Pair<Condition, String> {
        val base: Pair<Condition, String> = when (code) {
            0 -> Condition.CLEAR to "clear skies"
            1 -> Condition.CLEAR to "mostly clear skies"
            2 -> Condition.CLOUDS to "partly cloudy skies"
            3 -> Condition.CLOUDS to "overcast skies"
            45, 48 -> Condition.FOG to "fog and reduced visibility"
            51, 53, 55, 56, 57 -> Condition.RAIN to "light drizzle"
            61, 63, 66 -> Condition.RAIN to "light rain"
            65, 67 -> Condition.RAIN to "heavy rain"
            80, 81 -> Condition.RAIN to "scattered showers"
            82 -> Condition.RAIN to "heavy showers"
            71, 73, 75, 77, 85, 86 -> Condition.SNOW to "snowfall"
            95 -> Condition.STORM to "thunderstorms"
            96, 99 -> Condition.STORM to "thunderstorms with hail"
            else -> Condition.CLOUDS to "changeable skies"
        }
        // Strong wind overrides calm-weather categories
        return if (windKmh >= 29 && (base.first == Condition.CLEAR || base.first == Condition.CLOUDS)) {
            Condition.WIND to "${base.second} with gusty winds"
        } else base
    }
}
