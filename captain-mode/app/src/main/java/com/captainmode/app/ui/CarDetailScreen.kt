package com.captainmode.app.ui

import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.captainmode.app.data.ConfigRepository
import com.captainmode.app.data.VoiceConfig
import com.captainmode.app.engine.AnnouncementService

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CarDetailScreen(nav: NavController, carId: String) {
    val context = LocalContext.current
    val config by ConfigRepository.config.collectAsState()
    val car = config.cars.firstOrNull { it.id == carId }

    LaunchedEffect(car == null) {
        if (car == null) nav.popBackStack()
    }
    if (car == null) return

    var editName by remember { mutableStateOf(false) }
    var editAirline by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }

    val audioPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri != null) {
            try {
                context.contentResolver.takePersistableUriPermission(
                    uri, Intent.FLAG_GRANT_READ_URI_PERMISSION
                )
            } catch (_: SecurityException) {
            }
            val display = uri.lastPathSegment?.substringAfterLast('/') ?: "Custom audio"
            ConfigRepository.updateCar(carId) {
                it.copy(customAudioUri = uri.toString(), customAudioName = display)
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(car.spokenName) },
                navigationIcon = {
                    IconButton(onClick = { nav.popBackStack() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
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
            SectionHeader("Identity")
            SettingsCard {
                ClickableRow(
                    title = "Spoken name",
                    subtitle = "\"${car.spokenName}\" — how the Captain refers to this car ({car})",
                    onClick = { editName = true }
                ) { Text("Edit") }
                ClickableRow(
                    title = "Airline name for this car",
                    subtitle = car.airlineOverride?.takeIf { it.isNotBlank() }
                        ?: "Using default: ${config.airlineName}",
                    onClick = { editAirline = true }
                ) { Text("Edit") }
                SwitchRow(
                    title = "Announcements for this car",
                    checked = car.enabled,
                    onChecked = { on -> ConfigRepository.updateCar(carId) { it.copy(enabled = on) } }
                )
            }

            SectionHeader("Timing & volume")
            SettingsCard {
                SliderRow(
                    title = "Extra delay before speaking",
                    valueLabel = "${"%.1f".format(car.delaySeconds)} s",
                    value = car.delaySeconds,
                    range = 0f..20f,
                    steps = 39,
                    onChangeFinished = { v ->
                        ConfigRepository.updateCar(carId) { it.copy(delaySeconds = v) }
                    }
                )
                Text(
                    "Applied after the car's audio system is up (see Settings → Car audio). " +
                            "If the first words still get cut off, increase this.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)
                )
                SwitchRow(
                    title = "Set media volume for announcement",
                    subtitle = "Restores your previous volume afterwards",
                    checked = car.volumePercent != null,
                    onChecked = { on ->
                        ConfigRepository.updateCar(carId) {
                            it.copy(volumePercent = if (on) 70 else null)
                        }
                    }
                )
                if (car.volumePercent != null) {
                    SliderRow(
                        title = "Announcement volume",
                        valueLabel = "${car.volumePercent}%",
                        value = car.volumePercent.toFloat(),
                        range = 10f..100f,
                        onChangeFinished = { v ->
                            ConfigRepository.updateCar(carId) { it.copy(volumePercent = v.toInt()) }
                        }
                    )
                }
            }

            SectionHeader("Voice & script for this car")
            SettingsCard {
                SwitchRow(
                    title = "Custom voice for this car",
                    subtitle = "Otherwise the global Captain's voice is used",
                    checked = car.voiceOverride != null,
                    onChecked = { on ->
                        ConfigRepository.updateCar(carId) {
                            it.copy(voiceOverride = if (on) config.voice else null)
                        }
                    }
                )
                if (car.voiceOverride != null) {
                    ClickableRow(
                        title = "Configure this car's voice",
                        onClick = { nav.navigate("voice/$carId") }
                    ) { Text("Open") }
                }
                SwitchRow(
                    title = "Custom phrases for this car",
                    subtitle = "Starts as a copy of the global scripts",
                    checked = car.useCustomPhrases,
                    onChecked = { on ->
                        ConfigRepository.updateCar(carId) {
                            it.copy(
                                useCustomPhrases = on,
                                customLibrary = if (on) (it.customLibrary ?: config.library)
                                else it.customLibrary
                            )
                        }
                    }
                )
                if (car.useCustomPhrases) {
                    ClickableRow(
                        title = "Edit this car's phrases",
                        onClick = { nav.navigate("phrases/$carId") }
                    ) { Text("Open") }
                }
            }

            SectionHeader("Custom recording")
            SettingsCard {
                Text(
                    "Play your own audio file instead of the spoken announcement — " +
                            "for example an AI-generated pilot voice. The chime still plays first.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                )
                if (car.customAudioUri == null) {
                    OutlinedButton(
                        onClick = { audioPicker.launch(arrayOf("audio/*")) },
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 8.dp)
                    ) { Text("Choose audio file") }
                } else {
                    ClickableRow(
                        title = "Custom audio active",
                        subtitle = car.customAudioName ?: "Audio file",
                        onClick = {
                            ConfigRepository.updateCar(carId) {
                                it.copy(customAudioUri = null, customAudioName = null)
                            }
                        }
                    ) { Text("Remove") }
                }
            }

            Spacer(Modifier.height(16.dp))
            Button(
                onClick = { AnnouncementService.test(context, carId) },
                modifier = Modifier.fillMaxWidth()
            ) { Text("Test this car's announcement") }

            Spacer(Modifier.height(8.dp))
            OutlinedButton(
                onClick = { confirmDelete = true },
                modifier = Modifier.fillMaxWidth()
            ) { Text("Remove car", color = MaterialTheme.colorScheme.error) }
            Spacer(Modifier.height(32.dp))
        }
    }

    if (editName) {
        TextEditDialog(
            title = "Spoken name",
            initial = car.spokenName,
            onDismiss = { editName = false },
            onConfirm = { name ->
                if (name.isNotBlank()) {
                    ConfigRepository.updateCar(carId) { it.copy(spokenName = name.trim()) }
                }
                editName = false
            }
        )
    }

    if (editAirline) {
        TextEditDialog(
            title = "Airline name for this car",
            initial = car.airlineOverride ?: "",
            placeholder = "Leave empty to use the default",
            onDismiss = { editAirline = false },
            onConfirm = { name ->
                ConfigRepository.updateCar(carId) {
                    it.copy(airlineOverride = name.trim().takeIf { n -> n.isNotEmpty() })
                }
                editAirline = false
            }
        )
    }

    if (confirmDelete) {
        ConfirmDialog(
            title = "Remove ${car.spokenName}?",
            message = "This car's profile and custom settings will be deleted.",
            onDismiss = { confirmDelete = false },
            onConfirm = {
                confirmDelete = false
                ConfigRepository.update { cfg ->
                    cfg.copy(cars = cfg.cars.filterNot { it.id == carId })
                }
            }
        )
    }
}
