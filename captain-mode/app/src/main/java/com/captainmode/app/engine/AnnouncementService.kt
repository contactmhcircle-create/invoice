package com.captainmode.app.engine

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.Uri
import android.os.BatteryManager
import android.os.IBinder
import android.os.SystemClock
import com.captainmode.app.CaptainApp
import com.captainmode.app.R
import com.captainmode.app.data.AppConfig
import com.captainmode.app.data.CarProfile
import com.captainmode.app.data.ConfigRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.time.LocalDateTime
import java.util.concurrent.atomic.AtomicInteger

class AnnouncementService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val active = AtomicInteger(0)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(
            NOTIFICATION_ID,
            buildNotification(),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        )

        val event = intent?.getStringExtra(EXTRA_EVENT)
        if (event == null) {
            stopIfIdle()
            return START_NOT_STICKY
        }
        val mac = intent.getStringExtra(EXTRA_MAC) ?: ""
        val name = intent.getStringExtra(EXTRA_NAME) ?: ""
        val testCarId = intent.getStringExtra(EXTRA_TEST_CAR_ID)

        if (event != EVENT_TEST && isDuplicate(mac, event)) {
            stopIfIdle()
            return START_NOT_STICKY
        }

        active.incrementAndGet()
        scope.launch {
            try {
                handle(event, mac, name, testCarId)
            } finally {
                if (active.decrementAndGet() <= 0) stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun stopIfIdle() {
        if (active.get() <= 0) stopSelf()
    }

    private suspend fun handle(event: String, mac: String, btName: String, testCarId: String?) {
        val config = ConfigRepository.get(this)
        if (!config.masterEnabled && event != EVENT_TEST) return
        if (config.quietHoursEnabled && event != EVENT_TEST && inQuietHours(config)) return

        val car: CarProfile? = when (event) {
            EVENT_TEST -> config.cars.firstOrNull { it.id == testCarId } ?: config.cars.firstOrNull()
            else -> config.cars.firstOrNull { it.mac.equals(mac, ignoreCase = true) }
        }

        if (event != EVENT_TEST) {
            if (car == null && !config.announceUnknownDevices) return
            if (car != null && !car.enabled) return
        }

        when (event) {
            EVENT_CONNECTED, EVENT_TEST -> announceConnect(config, car, isTest = event == EVENT_TEST)
            EVENT_DISCONNECTED -> announceDisconnect(config, car)
        }
    }

    private suspend fun announceConnect(config: AppConfig, car: CarProfile?, isTest: Boolean) {
        val weatherJob = scope.async { WeatherClient.fetchForConfig(this@AnnouncementService, config) }

        val delaySec = if (isTest) 0.5f else (car?.delaySeconds ?: 3.5f)
        delay((delaySec * 1000).toLong())

        val weather = withTimeoutOrNull(7000) { weatherJob.await() }
        val battery = batteryPercent()
        val result = Composer.composeConnect(config, car, weather, LocalDateTime.now(), battery)
        ConfigRepository.update { it.copy(recentPicks = result.updatedPicks) }

        withAudioSession(car) {
            ChimePlayer.play(this, config.chime)
            val customUri = car?.customAudioUri
            if (customUri != null) {
                ChimePlayer.playUri(this, Uri.parse(customUri))
            } else if (result.text.isNotBlank()) {
                speak(config, car, result.text)
            }
        }
    }

    private suspend fun announceDisconnect(config: AppConfig, car: CarProfile?) {
        if (!config.announceOnDisconnect) return
        // Give audio routing a moment to fall back to the phone speaker.
        delay(1500)
        val result = Composer.composeDisconnect(config, car, LocalDateTime.now())
        ConfigRepository.update { it.copy(recentPicks = result.updatedPicks) }
        if (result.text.isBlank()) return
        withAudioSession(car = null) {
            speak(config, car, result.text)
        }
    }

    private suspend fun speak(config: AppConfig, car: CarProfile?, text: String) {
        val speaker = TtsSpeaker(this)
        try {
            if (!speaker.init()) return
            speaker.applyConfig(car?.voiceOverride ?: config.voice)
            speaker.speak(text)
        } finally {
            speaker.release()
        }
    }

    private suspend fun withAudioSession(car: CarProfile?, block: suspend () -> Unit) {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .build()
        am.requestAudioFocus(focusRequest)

        val volumePercent = car?.volumePercent
        var previousVolume: Int? = null
        if (volumePercent != null) {
            previousVolume = am.getStreamVolume(AudioManager.STREAM_MUSIC)
            val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
            try {
                am.setStreamVolume(
                    AudioManager.STREAM_MUSIC,
                    (max * volumePercent / 100).coerceIn(1, max),
                    0
                )
            } catch (_: SecurityException) {
                previousVolume = null
            }
        }

        try {
            block()
        } finally {
            if (previousVolume != null) {
                try {
                    am.setStreamVolume(AudioManager.STREAM_MUSIC, previousVolume, 0)
                } catch (_: SecurityException) {
                }
            }
            am.abandonAudioFocusRequest(focusRequest)
        }
    }

    private fun batteryPercent(): Int? {
        val bm = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val pct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return if (pct in 1..100) pct else null
    }

    private fun inQuietHours(config: AppConfig): Boolean {
        val now = LocalDateTime.now()
        val m = now.hour * 60 + now.minute
        val start = config.quietStartMinute
        val end = config.quietEndMinute
        return if (start <= end) m in start..end else m >= start || m <= end
    }

    private fun buildNotification(): Notification =
        Notification.Builder(this, CaptainApp.CHANNEL_ANNOUNCEMENTS)
            .setSmallIcon(R.drawable.ic_stat_flight)
            .setContentTitle("Captain Mode")
            .setContentText("Cabin announcement in progress")
            .build()

    companion object {
        const val EXTRA_EVENT = "event"
        const val EXTRA_MAC = "mac"
        const val EXTRA_NAME = "name"
        const val EXTRA_TEST_CAR_ID = "test_car_id"
        const val EVENT_CONNECTED = "connected"
        const val EVENT_DISCONNECTED = "disconnected"
        const val EVENT_TEST = "test"
        private const val NOTIFICATION_ID = 41

        private const val DEDUPE_WINDOW_MS = 20_000L
        private val lastHandled = HashMap<String, Long>()

        @Synchronized
        private fun isDuplicate(mac: String, event: String): Boolean {
            val key = "$mac/$event"
            val now = SystemClock.elapsedRealtime()
            val last = lastHandled[key]
            if (last != null && now - last < DEDUPE_WINDOW_MS) return true
            lastHandled[key] = now
            return false
        }

        fun test(context: Context, carId: String?) {
            val intent = Intent(context, AnnouncementService::class.java)
                .putExtra(EXTRA_EVENT, EVENT_TEST)
                .putExtra(EXTRA_TEST_CAR_ID, carId)
            context.startForegroundService(intent)
        }
    }
}
