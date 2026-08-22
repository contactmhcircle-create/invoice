package com.captainmode.app.ui

import android.Manifest
import android.bluetooth.BluetoothManager
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.DirectionsCar
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.captainmode.app.data.CarProfile
import com.captainmode.app.data.ConfigRepository
import java.util.UUID

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CarsScreen(nav: NavController) {
    val context = LocalContext.current
    val config by ConfigRepository.config.collectAsState()
    var showAdd by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Your fleet") },
                navigationIcon = {
                    IconButton(onClick = { nav.popBackStack() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(onClick = { showAdd = true }) {
                Icon(Icons.Filled.Add, contentDescription = null)
                Text("  Add car")
            }
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .padding(padding)
                .padding(horizontal = 16.dp)
        ) {
            if (config.cars.isEmpty()) {
                item {
                    Text(
                        "No cars yet. Pair your phone with the car at least once, " +
                                "then add it here from your paired devices.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 24.dp)
                    )
                }
            }
            items(config.cars, key = { it.id }) { car ->
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 6.dp)
                        .clickable { nav.navigate("car/${car.id}") },
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.surfaceVariant
                    )
                ) {
                    Row(
                        modifier = Modifier.padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(Icons.Filled.DirectionsCar, contentDescription = null)
                        Column(
                            modifier = Modifier
                                .weight(1f)
                                .padding(horizontal = 12.dp)
                        ) {
                            Text(car.spokenName, style = MaterialTheme.typography.titleMedium)
                            Text(
                                "${car.btName} · ${car.mac}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Switch(
                            checked = car.enabled,
                            onCheckedChange = { on ->
                                ConfigRepository.updateCar(car.id) { it.copy(enabled = on) }
                            }
                        )
                    }
                }
            }
            item { Spacer(Modifier.height(88.dp)) }
        }
    }

    if (showAdd) {
        AddCarDialog(
            existingMacs = config.cars.map { it.mac.uppercase() }.toSet(),
            onDismiss = { showAdd = false },
            onAdd = { mac, name ->
                val profile = CarProfile(
                    id = UUID.randomUUID().toString(),
                    mac = mac,
                    btName = name,
                    spokenName = name
                )
                ConfigRepository.update { it.copy(cars = it.cars + profile) }
                showAdd = false
            }
        )
    }
}

@Composable
private fun AddCarDialog(
    existingMacs: Set<String>,
    onDismiss: () -> Unit,
    onAdd: (mac: String, name: String) -> Unit
) {
    val context = LocalContext.current
    var refresh by remember { mutableStateOf(0) }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { refresh++ }

    val hasPermission = remember(refresh) {
        context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) ==
                PackageManager.PERMISSION_GRANTED
    }

    val devices = remember(refresh) {
        if (!hasPermission) emptyList()
        else try {
            val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
            adapter?.bondedDevices
                ?.mapNotNull { d ->
                    val mac = d.address ?: return@mapNotNull null
                    val name = try {
                        d.name
                    } catch (_: SecurityException) {
                        null
                    } ?: mac
                    mac to name
                }
                ?.filter { it.first.uppercase() !in existingMacs }
                ?.sortedBy { it.second.lowercase() }
                ?: emptyList()
        } catch (_: SecurityException) {
            emptyList()
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add from paired devices") },
        text = {
            Column {
                if (!hasPermission) {
                    Text("Bluetooth permission is needed to list your paired devices.")
                    Spacer(Modifier.height(8.dp))
                    TextButton(onClick = {
                        permissionLauncher.launch(Manifest.permission.BLUETOOTH_CONNECT)
                    }) { Text("Grant Bluetooth access") }
                } else if (devices.isEmpty()) {
                    Text(
                        "No new paired devices found. Pair your phone with the car first, " +
                                "then come back here."
                    )
                } else {
                    LazyColumn {
                        items(devices) { (mac, name) ->
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { onAdd(mac, name) }
                                    .padding(vertical = 10.dp)
                            ) {
                                Text(name, style = MaterialTheme.typography.bodyLarge)
                                Text(
                                    mac,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        }
    )
}
