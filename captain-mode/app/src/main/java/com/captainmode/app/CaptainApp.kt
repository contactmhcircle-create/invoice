package com.captainmode.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import com.captainmode.app.data.ConfigRepository

class CaptainApp : Application() {

    override fun onCreate() {
        super.onCreate()
        ConfigRepository.init(this)

        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ANNOUNCEMENTS,
                "Cabin announcements",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shown briefly while an announcement is playing"
                setShowBadge(false)
            }
        )
    }

    companion object {
        const val CHANNEL_ANNOUNCEMENTS = "announcements"
    }
}
