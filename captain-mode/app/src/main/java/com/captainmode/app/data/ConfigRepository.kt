package com.captainmode.app.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json

private val Context.dataStore by preferencesDataStore(name = "captain_config")

object ConfigRepository {

    private val KEY_CONFIG = stringPreferencesKey("config_json")

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private lateinit var appContext: Context
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val writeMutex = Mutex()

    private val _config = MutableStateFlow(defaultConfig())
    val config: StateFlow<AppConfig> get() = _config

    @Volatile
    private var initialized = false

    private fun defaultConfig() = AppConfig(library = DefaultPhrases.library)

    fun init(context: Context) {
        if (initialized) return
        synchronized(this) {
            if (initialized) return
            appContext = context.applicationContext
            val stored = runBlocking {
                appContext.dataStore.data.first()[KEY_CONFIG]
            }
            _config.value = stored?.let {
                runCatching { json.decodeFromString<AppConfig>(it) }.getOrNull()
            } ?: defaultConfig()
            initialized = true
        }
    }

    /** Synchronous read for service/receiver paths; initializes if needed. */
    fun get(context: Context): AppConfig {
        init(context)
        return _config.value
    }

    fun update(transform: (AppConfig) -> AppConfig) {
        scope.launch {
            writeMutex.withLock {
                val next = transform(_config.value)
                _config.value = next
                appContext.dataStore.edit { prefs ->
                    prefs[KEY_CONFIG] = json.encodeToString(AppConfig.serializer(), next)
                }
            }
        }
    }

    fun updateCar(carId: String, transform: (CarProfile) -> CarProfile) {
        update { cfg ->
            cfg.copy(cars = cfg.cars.map { if (it.id == carId) transform(it) else it })
        }
    }
}
