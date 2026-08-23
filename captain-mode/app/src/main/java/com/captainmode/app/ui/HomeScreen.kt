package com.captainmode.app.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.DirectionsCar
import androidx.compose.material.icons.filled.Flight
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.captainmode.app.data.ConfigRepository
import com.captainmode.app.engine.AnnouncementService

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(nav: NavController) {
    val context = LocalContext.current
    val config by ConfigRepository.config.collectAsState()
    val resumeTick = rememberResumeTick()

    val permissionsOk = remember(resumeTick) {
        context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) ==
                PackageManager.PERMISSION_GRANTED &&
                isIgnoringBatteryOptimizations(context)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Filled.Flight, contentDescription = null)
                        Spacer(Modifier.height(0.dp))
                        Text("  Captain Mode")
                    }
                },
                actions = {
                    IconButton(onClick = { nav.navigate("settings") }) {
                        Icon(Icons.Filled.Settings, contentDescription = "Settings")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .padding(horizontal = 16.dp)
                .verticalScroll(rememberScrollState())
        ) {
            if (!permissionsOk) {
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 12.dp),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer
                    )
                ) {
                    Row(
                        modifier = Modifier.padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(
                            Icons.Filled.Warning,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.error
                        )
                        Column(
                            modifier = Modifier
                                .weight(1f)
                                .padding(horizontal = 12.dp)
                        ) {
                            Text(
                                "Pre-flight checks incomplete",
                                style = MaterialTheme.typography.titleSmall
                            )
                            Text(
                                "Permissions are missing — announcements may not fire.",
                                style = MaterialTheme.typography.bodySmall
                            )
                        }
                        OutlinedButton(onClick = { nav.navigate("onboarding") }) { Text("Fix") }
                    }
                }
            }

            SectionHeader("Flight operations")
            SettingsCard {
                SwitchRow(
                    title = "Announcements",
                    subtitle = if (config.masterEnabled) "Armed — the Captain will speak on connect"
                    else "Disarmed — no announcements will play",
                    checked = config.masterEnabled,
                    onChecked = { on -> ConfigRepository.update { it.copy(masterEnabled = on) } }
                )
            }

            SectionHeader("Fleet")
            SettingsCard {
                ClickableRow(
                    title = "Your cars",
                    subtitle = if (config.cars.isEmpty())
                        "No cars configured yet — add your car's Bluetooth"
                    else config.cars.joinToString { it.spokenName },
                    onClick = { nav.navigate("cars") }
                ) {
                    Icon(Icons.Filled.DirectionsCar, contentDescription = null)
                    Text("  Manage")
                }
            }

            SectionHeader("Cabin crew")
            SettingsCard {
                ClickableRow(
                    title = "Announcement scripts",
                    subtitle = "Edit every phrase, add scripts, set day and time rules",
                    onClick = { nav.navigate("phrases/global") }
                ) {
                    Icon(Icons.Filled.Campaign, contentDescription = null)
                    Text("  Edit")
                }
                ClickableRow(
                    title = "Captain's voice",
                    subtitle = "Voice, pitch and speaking speed",
                    onClick = { nav.navigate("voice/global") }
                ) {
                    Icon(Icons.Filled.RecordVoiceOver, contentDescription = null)
                    Text("  Choose")
                }
            }

            SectionHeader("Pre-flight test")
            SettingsCard {
                var expanded by remember { mutableStateOf(false) }
                var selectedCarId by remember { mutableStateOf<String?>(null) }
                val selectedCar = config.cars.firstOrNull { it.id == selectedCarId }
                    ?: config.cars.firstOrNull()

                if (config.cars.size > 1) {
                    ClickableRow(
                        title = "Test as",
                        subtitle = selectedCar?.spokenName ?: "Default",
                        onClick = { expanded = true }
                    ) { Text("Change") }
                    DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                        config.cars.forEach { car ->
                            DropdownMenuItem(
                                text = { Text(car.spokenName) },
                                onClick = {
                                    selectedCarId = car.id
                                    expanded = false
                                }
                            )
                        }
                    }
                }

                Button(
                    onClick = { AnnouncementService.test(context, selectedCar?.id) },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp)
                ) {
                    Icon(Icons.Filled.Campaign, contentDescription = null)
                    Text("  Run pre-flight announcement")
                }
            }

            Spacer(Modifier.height(32.dp))
        }
    }
}
