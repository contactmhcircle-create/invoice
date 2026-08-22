package com.captainmode.app.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.foundation.clickable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.captainmode.app.data.ConfigRepository
import com.captainmode.app.engine.ChimePlayer
import com.captainmode.app.engine.GeoResult
import com.captainmode.app.engine.WeatherClient
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(nav: NavController) {
    val context = LocalContext.current
    val config by ConfigRepository.config.collectAsState()
    val scope = rememberCoroutineScope()

    var editAirline by remember { mutableStateOf(false) }
    var editCaptain by remember { mutableStateOf(false) }
    var editQuietStart by remember { mutableStateOf(false) }
    var editQuietEnd by remember { mutableStateOf(false) }
    var editRushMorning by remember { mutableStateOf(false) }
    var editRushEvening by remember { mutableStateOf(false) }
    var searchCity by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
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
            SectionHeader("Airline")
            SettingsCard {
                ClickableRow(
                    title = "Airline name",
                    subtitle = "\"${config.airlineName}\" — used as {airline}",
                    onClick = { editAirline = true }
                ) { Text("Edit") }
                ClickableRow(
                    title = "Captain's name",
                    subtitle = "\"${config.captainName}\" — used as {captain}",
                    onClick = { editCaptain = true }
                ) { Text("Edit") }
                SwitchRow(
                    title = "24-hour time",
                    checked = config.use24hTime,
                    onChecked = { on -> ConfigRepository.update { it.copy(use24hTime = on) } }
                )
                SwitchRow(
                    title = "Fahrenheit",
                    subtitle = "Otherwise Celsius",
                    checked = config.useFahrenheit,
                    onChecked = { on -> ConfigRepository.update { it.copy(useFahrenheit = on) } }
                )
            }

            SectionHeader("Weather")
            SettingsCard {
                SwitchRow(
                    title = "Weather in announcements",
                    subtitle = "Live conditions via Open-Meteo (free, no account)",
                    checked = config.weatherEnabled,
                    onChecked = { on -> ConfigRepository.update { it.copy(weatherEnabled = on) } }
                )
                if (config.weatherEnabled) {
                    SwitchRow(
                        title = "Use phone location",
                        subtitle = "Needs the location permission from pre-flight checks",
                        checked = config.useDeviceLocation,
                        onChecked = { on ->
                            ConfigRepository.update { it.copy(useDeviceLocation = on) }
                        }
                    )
                    ClickableRow(
                        title = "Fallback city",
                        subtitle = config.manualLocationName
                            ?: "Not set — used when phone location is unavailable",
                        onClick = { searchCity = true }
                    ) { Text("Set") }
                }
            }

            SectionHeader("Chime")
            SettingsCard {
                SwitchRow(
                    title = "Cabin chime before announcement",
                    checked = config.chime.enabled,
                    onChecked = { on ->
                        ConfigRepository.update { it.copy(chime = it.chime.copy(enabled = on)) }
                    }
                )
                if (config.chime.enabled) {
                    listOf(
                        "single" to "Single tone",
                        "double" to "Classic ding-dong",
                        "triple" to "Triple chime"
                    ).forEach { (style, label) ->
                        ClickableRow(
                            title = label,
                            subtitle = if (config.chime.style == style) "Selected" else null,
                            onClick = {
                                ConfigRepository.update {
                                    it.copy(chime = it.chime.copy(style = style, customUri = null))
                                }
                            }
                        ) { if (config.chime.style == style) Text("✓") else Text("Use") }
                    }
                    Button(
                        onClick = { scope.launch { ChimePlayer.play(context, config.chime) } },
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 8.dp)
                    ) { Text("Preview chime") }
                }
            }

            SectionHeader("Schedules")
            SettingsCard {
                SwitchRow(
                    title = "Quiet hours",
                    subtitle = "No announcements between " +
                            "${formatMinutes(config.quietStartMinute)} and " +
                            "${formatMinutes(config.quietEndMinute)}",
                    checked = config.quietHoursEnabled,
                    onChecked = { on ->
                        ConfigRepository.update { it.copy(quietHoursEnabled = on) }
                    }
                )
                if (config.quietHoursEnabled) {
                    ClickableRow(
                        title = "Quiet from",
                        subtitle = formatMinutes(config.quietStartMinute),
                        onClick = { editQuietStart = true }
                    ) { Text("Edit") }
                    ClickableRow(
                        title = "Quiet until",
                        subtitle = formatMinutes(config.quietEndMinute),
                        onClick = { editQuietEnd = true }
                    ) { Text("Edit") }
                }
                SwitchRow(
                    title = "Rush-hour traffic lines",
                    subtitle = "Adds a traffic remark on weekdays in these windows",
                    checked = config.rushHourEnabled,
                    onChecked = { on -> ConfigRepository.update { it.copy(rushHourEnabled = on) } }
                )
                if (config.rushHourEnabled) {
                    ClickableRow(
                        title = "Morning window",
                        subtitle = "${formatMinutes(config.rushMorningStart)} – " +
                                formatMinutes(config.rushMorningEnd),
                        onClick = { editRushMorning = true }
                    ) { Text("Edit") }
                    ClickableRow(
                        title = "Evening window",
                        subtitle = "${formatMinutes(config.rushEveningStart)} – " +
                                formatMinutes(config.rushEveningEnd),
                        onClick = { editRushEvening = true }
                    ) { Text("Edit") }
                }
            }

            SectionHeader("Behaviour")
            SettingsCard {
                SwitchRow(
                    title = "Arrival announcement",
                    subtitle = "Sign-off on the phone speaker when you disconnect",
                    checked = config.announceOnDisconnect,
                    onChecked = { on ->
                        ConfigRepository.update { it.copy(announceOnDisconnect = on) }
                    }
                )
                SwitchRow(
                    title = "Announce unknown devices",
                    subtitle = "Also greet Bluetooth devices you haven't added as cars",
                    checked = config.announceUnknownDevices,
                    onChecked = { on ->
                        ConfigRepository.update { it.copy(announceUnknownDevices = on) }
                    }
                )
            }

            SectionHeader("Setup")
            SettingsCard {
                ClickableRow(
                    title = "Pre-flight checks",
                    subtitle = "Review permissions and battery exemption",
                    onClick = { nav.navigate("onboarding") }
                ) { Text("Open") }
            }
            Spacer(Modifier.height(32.dp))
        }
    }

    if (editAirline) {
        TextEditDialog(
            title = "Airline name",
            initial = config.airlineName,
            onDismiss = { editAirline = false },
            onConfirm = { v ->
                if (v.isNotBlank()) ConfigRepository.update { it.copy(airlineName = v.trim()) }
                editAirline = false
            }
        )
    }
    if (editCaptain) {
        TextEditDialog(
            title = "Captain's name",
            initial = config.captainName,
            onDismiss = { editCaptain = false },
            onConfirm = { v ->
                if (v.isNotBlank()) ConfigRepository.update { it.copy(captainName = v.trim()) }
                editCaptain = false
            }
        )
    }

    if (editQuietStart) {
        TimeDialog("Quiet from", config.quietStartMinute, { editQuietStart = false }) { m ->
            ConfigRepository.update { it.copy(quietStartMinute = m) }
            editQuietStart = false
        }
    }
    if (editQuietEnd) {
        TimeDialog("Quiet until", config.quietEndMinute, { editQuietEnd = false }) { m ->
            ConfigRepository.update { it.copy(quietEndMinute = m) }
            editQuietEnd = false
        }
    }
    if (editRushMorning) {
        TimeRangeDialog(
            "Morning rush window",
            config.rushMorningStart,
            config.rushMorningEnd,
            { editRushMorning = false }
        ) { s, e ->
            ConfigRepository.update { it.copy(rushMorningStart = s, rushMorningEnd = e) }
            editRushMorning = false
        }
    }
    if (editRushEvening) {
        TimeRangeDialog(
            "Evening rush window",
            config.rushEveningStart,
            config.rushEveningEnd,
            { editRushEvening = false }
        ) { s, e ->
            ConfigRepository.update { it.copy(rushEveningStart = s, rushEveningEnd = e) }
            editRushEvening = false
        }
    }

    if (searchCity) {
        CitySearchDialog(
            onDismiss = { searchCity = false },
            onPick = { r ->
                ConfigRepository.update {
                    it.copy(
                        manualLat = r.lat,
                        manualLon = r.lon,
                        manualLocationName = listOf(r.name, r.region)
                            .filter { s -> s.isNotBlank() }
                            .joinToString(", ")
                    )
                }
                searchCity = false
            }
        )
    }
}

@Composable
private fun TimeDialog(
    title: String,
    initialMinutes: Int,
    onDismiss: () -> Unit,
    onConfirm: (Int) -> Unit
) {
    TextEditDialog(
        title = "$title (HH:mm)",
        initial = formatMinutes(initialMinutes),
        onDismiss = onDismiss,
        onConfirm = { v -> parseMinutes(v)?.let(onConfirm) ?: onDismiss() }
    )
}

@Composable
private fun TimeRangeDialog(
    title: String,
    initialStart: Int,
    initialEnd: Int,
    onDismiss: () -> Unit,
    onConfirm: (Int, Int) -> Unit
) {
    var startText by remember { mutableStateOf(formatMinutes(initialStart)) }
    var endText by remember { mutableStateOf(formatMinutes(initialEnd)) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column {
                OutlinedTextField(
                    value = startText,
                    onValueChange = { startText = it },
                    label = { Text("From (HH:mm)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = endText,
                    onValueChange = { endText = it },
                    label = { Text("To (HH:mm)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            TextButton(onClick = {
                val s = parseMinutes(startText)
                val e = parseMinutes(endText)
                if (s != null && e != null) onConfirm(s, e) else onDismiss()
            }) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    )
}

@Composable
private fun CitySearchDialog(
    onDismiss: () -> Unit,
    onPick: (GeoResult) -> Unit
) {
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    var results by remember { mutableStateOf<List<GeoResult>>(emptyList()) }
    var searching by remember { mutableStateOf(false) }
    var searched by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Fallback city") },
        text = {
            Column {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it },
                    label = { Text("City name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
                TextButton(
                    enabled = query.isNotBlank() && !searching,
                    onClick = {
                        scope.launch {
                            searching = true
                            results = WeatherClient.searchCity(query.trim())
                            searching = false
                            searched = true
                        }
                    }
                ) { Text("Search") }
                if (searching) CircularProgressIndicator(modifier = Modifier.padding(8.dp))
                if (searched && results.isEmpty() && !searching) {
                    Text(
                        "No matches found.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                results.forEach { r ->
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onPick(r) }
                            .padding(vertical = 8.dp)
                    ) {
                        Text(r.name, style = MaterialTheme.typography.bodyLarge)
                        Text(
                            r.region,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } }
    )
}
