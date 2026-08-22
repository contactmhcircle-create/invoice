package com.captainmode.app.engine

import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothProfile
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

class BluetoothReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val device: BluetoothDevice? =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
            }
        val mac = device?.address ?: return
        val name = try {
            device.name
        } catch (_: SecurityException) {
            null
        }

        val event = when (intent.action) {
            BluetoothDevice.ACTION_ACL_CONNECTED -> AnnouncementService.EVENT_CONNECTED
            "android.bluetooth.a2dp.profile.action.CONNECTION_STATE_CHANGED" -> {
                val state = intent.getIntExtra(BluetoothProfile.EXTRA_STATE, -1)
                if (state == BluetoothProfile.STATE_CONNECTED) AnnouncementService.EVENT_CONNECTED
                else return
            }
            BluetoothDevice.ACTION_ACL_DISCONNECTED -> AnnouncementService.EVENT_DISCONNECTED
            else -> return
        }

        val svc = Intent(context, AnnouncementService::class.java)
            .putExtra(AnnouncementService.EXTRA_EVENT, event)
            .putExtra(AnnouncementService.EXTRA_MAC, mac)
            .putExtra(AnnouncementService.EXTRA_NAME, name ?: "")
        try {
            context.startForegroundService(svc)
        } catch (_: Exception) {
            // Background start not allowed (e.g. permission revoked) — nothing to announce.
        }
    }
}
