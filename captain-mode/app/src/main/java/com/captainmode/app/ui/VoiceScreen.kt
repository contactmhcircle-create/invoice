package com.captainmode.app.ui

import android.speech.tts.Voice
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.captainmode.app.data.ConfigRepository
import com.captainmode.app.data.VoiceConfig
import com.captainmode.app.engine.TtsSpeaker
import kotlinx.coroutines.launch
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VoiceScreen(nav: NavController, carId: String?) {
    val context = LocalContext.current
    val config by ConfigRepository.config.collectAsState()
    val car = carId?.let { id -> config.cars.firstOrNull { it.id == id } }
    val current: VoiceConfig = if (car != null) car.voiceOverride ?: config.voice else config.voice

    fun save(next: VoiceConfig) {
        if (car != null) {
            ConfigRepository.updateCar(car.id) { it.copy(voiceOverride = next) }
        } else {
            ConfigRepository.update { it.copy(voice = next) }
        }
    }

    val scope = rememberCoroutineScope()
    val speaker = remember { TtsSpeaker(context) }
    var ready by remember { mutableStateOf(false) }
    var voices by remember { mutableStateOf<List<Voice>>(emptyList()) }
    var showAllLanguages by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        ready = speaker.init()
        if (ready) voices = speaker.voices()
    }
    DisposableEffect(Unit) {
        onDispose { speaker.release() }
    }

    val defaultLang = Locale.getDefault().language
    val shownVoices = if (showAllLanguages) voices
    else voices.filter { it.locale.language == defaultLang }.ifEmpty { voices }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(if (car != null) "Voice — ${car.spokenName}" else "Captain's voice")
                },
                navigationIcon = {
                    IconButton(onClick = { nav.popBackStack() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .padding(padding)
                .padding(horizontal = 16.dp)
        ) {
            item {
                SectionHeader("Delivery")
                SettingsCard {
                    SliderRow(
                        title = "Pitch",
                        valueLabel = "%.2f".format(current.pitch),
                        value = current.pitch,
                        range = 0.5f..1.5f,
                        onChangeFinished = { save(current.copy(pitch = it)) }
                    )
                    SliderRow(
                        title = "Speed",
                        valueLabel = "%.2f".format(current.rate),
                        value = current.rate,
                        range = 0.5f..1.5f,
                        onChangeFinished = { save(current.copy(rate = it)) }
                    )
                    Text(
                        "Tip: real cabin announcements are slightly slow and calm — " +
                                "around 0.90 speed sounds most authentic.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)
                    )
                }
                Spacer(Modifier.height(12.dp))
                Button(
                    onClick = {
                        scope.launch {
                            if (ready) {
                                speaker.applyConfig(current)
                                speaker.speak(
                                    "Ladies and gentlemen, this is your Captain speaking. " +
                                            "We are expecting a smooth ride today."
                                )
                            }
                        }
                    },
                    enabled = ready,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Icon(Icons.Filled.PlayArrow, contentDescription = null)
                    Text("  Preview voice")
                }

                SectionHeader("Voice")
                SettingsCard {
                    SwitchRow(
                        title = "Show all languages",
                        checked = showAllLanguages,
                        onChecked = { showAllLanguages = it }
                    )
                }
                Spacer(Modifier.height(6.dp))
                SettingsCard {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { save(current.copy(voiceName = null)) }
                            .padding(horizontal = 16.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        RadioButton(
                            selected = current.voiceName == null,
                            onClick = { save(current.copy(voiceName = null)) }
                        )
                        Text("System default voice")
                    }
                }
                if (!ready) {
                    Text(
                        "Starting speech engine…",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(8.dp)
                    )
                }
            }
            items(shownVoices, key = { it.name }) { voice ->
                SettingsCard {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { save(current.copy(voiceName = voice.name)) }
                            .padding(horizontal = 16.dp, vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        RadioButton(
                            selected = current.voiceName == voice.name,
                            onClick = { save(current.copy(voiceName = voice.name)) }
                        )
                        Column {
                            Text(voice.name, style = MaterialTheme.typography.bodyMedium)
                            Text(
                                voice.locale.displayName,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }
                Spacer(Modifier.height(4.dp))
            }
            item { Spacer(Modifier.height(32.dp)) }
        }
    }
}
