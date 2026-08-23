package com.captainmode.app.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Info
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.captainmode.app.data.Condition
import com.captainmode.app.data.ConfigRepository
import com.captainmode.app.data.PhraseLibrary
import com.captainmode.app.data.SpecialScript
import java.util.UUID

private val VARIABLE_DOCS = listOf(
    "{greeting}" to "Good morning / afternoon / evening",
    "{daypart}" to "morning / afternoon / evening",
    "{airline}" to "Your airline name",
    "{captain}" to "The captain's name",
    "{car}" to "This car's spoken name",
    "{time}" to "Current time",
    "{day}" to "Day of the week",
    "{date}" to "Month and day",
    "{temp}" to "Outside temperature (needs weather)",
    "{weather}" to "Weather description (needs weather)",
    "{battery}" to "Phone battery percent"
)

private fun conditionLabel(c: Condition): String = when (c) {
    Condition.CLEAR -> "Clear"
    Condition.CLOUDS -> "Clouds"
    Condition.RAIN -> "Rain"
    Condition.WIND -> "Wind"
    Condition.FOG -> "Fog"
    Condition.SNOW -> "Snow"
    Condition.STORM -> "Storm"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PhraseEditorScreen(nav: NavController, carId: String?) {
    val config by ConfigRepository.config.collectAsState()
    val car = carId?.let { id -> config.cars.firstOrNull { it.id == id } }
    val library: PhraseLibrary =
        if (car != null) car.customLibrary ?: config.library else config.library

    fun save(next: PhraseLibrary) {
        if (car != null) {
            ConfigRepository.updateCar(car.id) { it.copy(customLibrary = next) }
        } else {
            ConfigRepository.update { it.copy(library = next) }
        }
    }

    var showVariables by remember { mutableStateOf(false) }
    var selectedCondition by remember { mutableStateOf(Condition.CLEAR) }
    var editingSpecial by remember { mutableStateOf<SpecialScript?>(null) }
    var addingSpecial by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(if (car != null) "Scripts — ${car.spokenName}" else "Announcement scripts")
                },
                navigationIcon = {
                    IconButton(onClick = { nav.popBackStack() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = { showVariables = true }) {
                        Icon(Icons.Filled.Info, contentDescription = "Variables")
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
            Text(
                "Each announcement is assembled from these parts, with a random pick from " +
                        "every pool so no two flights sound the same. Tap ⓘ for the list of " +
                        "{variables} you can use anywhere.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 12.dp)
            )

            PhrasePoolEditor(
                label = "1 · Attention",
                hint = "\"Ladies and gentlemen, this is your Captain speaking…\"",
                phrases = library.attention,
                onUpdate = { save(library.copy(attention = it)) }
            )
            PhrasePoolEditor(
                label = "2 · Welcome aboard",
                hint = "\"Welcome aboard {airline}…\"",
                phrases = library.welcome,
                onUpdate = { save(library.copy(welcome = it)) }
            )
            PhrasePoolEditor(
                label = "3 · Weather report",
                hint = "Uses {temp} and {weather}; skipped when weather is unavailable.",
                phrases = library.weatherReport,
                onUpdate = { save(library.copy(weatherReport = it)) }
            )

            SectionHeader("4 · Ride forecast — by live weather")
            Text(
                "The Captain picks the pool that matches the actual conditions outside.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 4.dp, bottom = 6.dp)
            )
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
            ) {
                Condition.entries.forEach { condition ->
                    FilterChip(
                        selected = selectedCondition == condition,
                        onClick = { selectedCondition = condition },
                        label = { Text(conditionLabel(condition)) },
                        modifier = Modifier.padding(end = 6.dp)
                    )
                }
            }
            PhrasePoolEditor(
                label = conditionLabel(selectedCondition) + " conditions",
                phrases = library.rideForecast[selectedCondition].orEmpty(),
                onUpdate = { newPool ->
                    save(
                        library.copy(
                            rideForecast = library.rideForecast.toMutableMap()
                                .apply { put(selectedCondition, newPool) }
                        )
                    )
                }
            )

            PhrasePoolEditor(
                label = "5 · Rush-hour traffic",
                hint = "Added on weekdays during your rush-hour windows (see Settings).",
                phrases = library.traffic,
                onUpdate = { save(library.copy(traffic = it)) }
            )
            PhrasePoolEditor(
                label = "6 · Sign-off",
                hint = "\"Cabin crew, prepare for departure.\"",
                phrases = library.signOff,
                onUpdate = { save(library.copy(signOff = it)) }
            )
            PhrasePoolEditor(
                label = "Arrival (disconnect)",
                hint = "Played on the phone speaker when you leave the car, if enabled in Settings.",
                phrases = library.disconnect,
                onUpdate = { save(library.copy(disconnect = it)) }
            )

            SectionHeader("Special scripts")
            Text(
                "A full announcement of its own. When its day/time rules match, it replaces " +
                        "the assembled announcement entirely.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 4.dp, bottom = 6.dp)
            )
            SettingsCard {
                library.specials.forEach { special ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(start = 16.dp, end = 4.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(special.label, style = MaterialTheme.typography.bodyLarge)
                            Text(
                                specialRuleSummary(special),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Switch(
                            checked = special.enabled,
                            onCheckedChange = { on ->
                                save(
                                    library.copy(specials = library.specials.map {
                                        if (it.id == special.id) it.copy(enabled = on) else it
                                    })
                                )
                            }
                        )
                        IconButton(onClick = { editingSpecial = special }) {
                            Icon(Icons.Filled.Edit, contentDescription = "Edit")
                        }
                        IconButton(onClick = {
                            save(
                                library.copy(
                                    specials = library.specials.filterNot { it.id == special.id }
                                )
                            )
                        }) {
                            Icon(
                                Icons.Filled.Delete,
                                contentDescription = "Delete",
                                tint = MaterialTheme.colorScheme.error
                            )
                        }
                    }
                }
                TextButton(
                    onClick = { addingSpecial = true },
                    modifier = Modifier.padding(horizontal = 8.dp)
                ) {
                    Icon(Icons.Filled.Add, contentDescription = null)
                    Text("Add special script")
                }
            }
            Spacer(Modifier.height(32.dp))
        }
    }

    if (showVariables) {
        AlertDialog(
            onDismissRequest = { showVariables = false },
            title = { Text("Variables") },
            text = {
                Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                    Text(
                        "Use these anywhere in a phrase. If a value isn't available " +
                                "(e.g. no weather), the whole sentence is skipped gracefully.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Spacer(Modifier.height(8.dp))
                    VARIABLE_DOCS.forEach { (variable, doc) ->
                        Row(modifier = Modifier.padding(vertical = 3.dp)) {
                            Text(
                                variable,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.width(110.dp)
                            )
                            Text(doc, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { showVariables = false }) { Text("Close") }
            }
        )
    }

    if (addingSpecial || editingSpecial != null) {
        SpecialScriptDialog(
            initial = editingSpecial,
            onDismiss = {
                addingSpecial = false
                editingSpecial = null
            },
            onSave = { updated ->
                val next = if (editingSpecial != null) {
                    library.copy(specials = library.specials.map {
                        if (it.id == updated.id) updated else it
                    })
                } else {
                    library.copy(specials = library.specials + updated)
                }
                save(next)
                addingSpecial = false
                editingSpecial = null
            }
        )
    }
}

private fun specialRuleSummary(s: SpecialScript): String {
    val dayNames = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
    val days = if (s.days.isEmpty()) "Any day"
    else s.days.sorted().joinToString(", ") { dayNames.getOrElse(it - 1) { "?" } }
    val time = if (s.startMinute != null && s.endMinute != null)
        "${formatMinutes(s.startMinute)}–${formatMinutes(s.endMinute)}"
    else "any time"
    return "$days · $time"
}

@Composable
private fun SpecialScriptDialog(
    initial: SpecialScript?,
    onDismiss: () -> Unit,
    onSave: (SpecialScript) -> Unit
) {
    var label by remember { mutableStateOf(initial?.label ?: "") }
    var text by remember { mutableStateOf(initial?.text ?: "") }
    var days by remember { mutableStateOf(initial?.days ?: emptyList()) }
    var startText by remember {
        mutableStateOf(initial?.startMinute?.let { formatMinutes(it) } ?: "")
    }
    var endText by remember {
        mutableStateOf(initial?.endMinute?.let { formatMinutes(it) } ?: "")
    }
    var error by remember { mutableStateOf<String?>(null) }

    val dayNames = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (initial == null) "New special script" else "Edit special script") },
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                OutlinedTextField(
                    value = label,
                    onValueChange = { label = it },
                    label = { Text("Name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    label = { Text("Full announcement (uses {variables})") },
                    minLines = 4,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
                Text("Days (none selected = any day)", style = MaterialTheme.typography.bodySmall)
                Row(modifier = Modifier.horizontalScroll(rememberScrollState())) {
                    dayNames.forEachIndexed { index, name ->
                        val dayNo = index + 1
                        FilterChip(
                            selected = dayNo in days,
                            onClick = {
                                days = if (dayNo in days) days - dayNo else days + dayNo
                            },
                            label = { Text(name) },
                            modifier = Modifier.padding(end = 4.dp)
                        )
                    }
                }
                Spacer(Modifier.height(8.dp))
                Row {
                    OutlinedTextField(
                        value = startText,
                        onValueChange = { startText = it },
                        label = { Text("From (HH:mm)") },
                        singleLine = true,
                        modifier = Modifier.weight(1f)
                    )
                    Spacer(Modifier.width(8.dp))
                    OutlinedTextField(
                        value = endText,
                        onValueChange = { endText = it },
                        label = { Text("To (HH:mm)") },
                        singleLine = true,
                        modifier = Modifier.weight(1f)
                    )
                }
                Text(
                    "Leave both empty for any time. A window like 22:00–05:00 crosses midnight.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                if (error != null) {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        error!!,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                val start = startText.trim().takeIf { it.isNotEmpty() }?.let { parseMinutes(it) }
                val end = endText.trim().takeIf { it.isNotEmpty() }?.let { parseMinutes(it) }
                val startGiven = startText.isNotBlank()
                val endGiven = endText.isNotBlank()
                when {
                    label.isBlank() || text.isBlank() ->
                        error = "Name and announcement text are required."
                    (startGiven && start == null) || (endGiven && end == null) ->
                        error = "Times must look like 07:30."
                    startGiven != endGiven ->
                        error = "Set both times, or leave both empty."
                    else -> onSave(
                        SpecialScript(
                            id = initial?.id ?: UUID.randomUUID().toString(),
                            label = label.trim(),
                            text = text.trim(),
                            enabled = initial?.enabled ?: true,
                            days = days,
                            startMinute = start,
                            endMinute = end
                        )
                    )
                }
            }) { Text("Save") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        }
    )
}
