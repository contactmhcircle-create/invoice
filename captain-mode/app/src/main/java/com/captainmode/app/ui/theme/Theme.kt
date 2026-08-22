package com.captainmode.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Amber = Color(0xFFFFD166)
private val DeepNavy = Color(0xFF0B1B33)
private val Night = Color(0xFF081222)
private val SkyBlue = Color(0xFF3E7CB1)

private val DarkColors = darkColorScheme(
    primary = Amber,
    onPrimary = DeepNavy,
    secondary = SkyBlue,
    onSecondary = Color.White,
    background = Night,
    onBackground = Color(0xFFE8EDF5),
    surface = DeepNavy,
    onSurface = Color(0xFFE8EDF5),
    surfaceVariant = Color(0xFF152A4A),
    onSurfaceVariant = Color(0xFFB9C4D6),
    primaryContainer = Color(0xFF2A3B5C),
    onPrimaryContainer = Amber,
    error = Color(0xFFFF6B6B)
)

private val LightColors = lightColorScheme(
    primary = Color(0xFF1F4E79),
    onPrimary = Color.White,
    secondary = SkyBlue,
    onSecondary = Color.White,
    background = Color(0xFFF6F8FB),
    onBackground = Color(0xFF14213D),
    surface = Color.White,
    onSurface = Color(0xFF14213D),
    surfaceVariant = Color(0xFFE7ECF4),
    onSurfaceVariant = Color(0xFF4A5A73),
    primaryContainer = Color(0xFFD8E4F2),
    onPrimaryContainer = Color(0xFF1F4E79),
    error = Color(0xFFC03535)
)

@Composable
fun CaptainTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        content = content
    )
}
