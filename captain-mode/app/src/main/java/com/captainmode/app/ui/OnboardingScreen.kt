package com.captainmode.app.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.captainmode.app.data.ConfigRepository

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OnboardingScreen(nav: NavController) {
    val context = LocalContext.current
    val resumeTick = rememberResumeTick()
    var refresh by remember { mutableIntStateOf(0) }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { refresh++ }

    fun granted(permission: String): Boolean =
        context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    val btOk = remember(resumeTick, refresh) { granted(Manifest.permission.BLUETOOTH_CONNECT) }
    val notifOk = remember(resumeTick, refresh) { granted(Manifest.permission.POST_NOTIFICATIONS) }
    val locOk = remember(resumeTick, refresh) {
        granted(Manifest.permission.ACCESS_COARSE_LOCATION) ||
                granted(Manifest.permission.ACCESS_FINE_LOCATION)
    }
    val batteryOk = remember(resumeTick, refresh) { isIgnoringBatteryOptimizations(context) }

    Scaffold(
        topBar = { TopAppBar(title = { Text("Pre-flight checks") }) }
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .padding(horizontal = 16.dp)
                .verticalScroll(rememberScrollState())
        ) {
            Text(
                "Before the Captain can take the intercom, Android needs a few clearances. " +
                        "The battery exemption matters most — Samsung otherwise grounds " +
                        "background apps, and your announcements with them.",
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(vertical = 12.dp)
            )

            CheckItem(
                done = btOk,
                title = "Bluetooth access",
                subtitle = "Required to detect when your phone connects to the car",
                buttonLabel = "Grant"
            ) {
                permissionLauncher.launch(arrayOf(Manifest.permission.BLUETOOTH_CONNECT))
            }

            CheckItem(
                done = notifOk,
                title = "Notifications",
                subtitle = "Required by Android while an announcement is playing",
                buttonLabel = "Grant"
            ) {
                permissionLauncher.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
            }

            CheckItem(
                done = batteryOk,
                title = "Unrestricted battery",
                subtitle = "Stops One UI from killing Captain Mode in the background",
                buttonLabel = "Exempt"
            ) {
                try {
                    context.startActivity(
                        Intent(
                            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                            Uri.parse("package:${context.packageName}")
                        )
                    )
                } catch (_: Exception) {
                    context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                }
            }

            CheckItem(
                done = locOk,
                title = "Location (optional)",
                subtitle = "Only used to fetch local weather for the announcement",
                buttonLabel = "Grant"
            ) {
                permissionLauncher.launch(
                    arrayOf(
                        Manifest.permission.ACCESS_COARSE_LOCATION,
                        Manifest.permission.ACCESS_FINE_LOCATION
                    )
                )
            }

            Spacer(Modifier.height(24.dp))
            Button(
                onClick = {
                    ConfigRepository.update { it.copy(onboarded = true) }
                    nav.navigate("home") { popUpTo(0) { inclusive = true } }
                },
                enabled = btOk,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(if (btOk) "Enter the cockpit" else "Grant Bluetooth access first")
            }
            Spacer(Modifier.height(32.dp))
        }
    }
}

@Composable
private fun CheckItem(
    done: Boolean,
    title: String,
    subtitle: String,
    buttonLabel: String,
    onGrant: () -> Unit
) {
    SettingsCard {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector = if (done) Icons.Filled.CheckCircle
                else Icons.Filled.RadioButtonUnchecked,
                contentDescription = null,
                tint = if (done) MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.onSurfaceVariant
            )
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 12.dp)
            ) {
                Text(title, style = MaterialTheme.typography.bodyLarge)
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            if (!done) {
                OutlinedButton(onClick = onGrant) { Text(buttonLabel) }
            }
        }
    }
    Spacer(Modifier.height(8.dp))
}
