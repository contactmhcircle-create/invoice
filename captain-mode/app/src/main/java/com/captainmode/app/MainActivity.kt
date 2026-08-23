package com.captainmode.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.collectAsState
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.captainmode.app.data.ConfigRepository
import com.captainmode.app.ui.CarDetailScreen
import com.captainmode.app.ui.CarsScreen
import com.captainmode.app.ui.HomeScreen
import com.captainmode.app.ui.OnboardingScreen
import com.captainmode.app.ui.PhraseEditorScreen
import com.captainmode.app.ui.SettingsScreen
import com.captainmode.app.ui.VoiceScreen
import com.captainmode.app.ui.theme.CaptainTheme

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        ConfigRepository.init(this)
        setContent {
            CaptainTheme {
                AppNav()
            }
        }
    }
}

@Composable
fun AppNav() {
    val nav = rememberNavController()
    val config by ConfigRepository.config.collectAsState()
    val start = remember { if (config.onboarded) "home" else "onboarding" }

    NavHost(navController = nav, startDestination = start) {
        composable("home") { HomeScreen(nav) }
        composable("onboarding") { OnboardingScreen(nav) }
        composable("cars") { CarsScreen(nav) }
        composable(
            "car/{carId}",
            arguments = listOf(navArgument("carId") { type = NavType.StringType })
        ) { entry ->
            CarDetailScreen(nav, entry.arguments?.getString("carId") ?: "")
        }
        composable(
            "phrases/{scope}",
            arguments = listOf(navArgument("scope") { type = NavType.StringType })
        ) { entry ->
            val scope = entry.arguments?.getString("scope") ?: "global"
            PhraseEditorScreen(nav, carId = scope.takeIf { it != "global" })
        }
        composable(
            "voice/{scope}",
            arguments = listOf(navArgument("scope") { type = NavType.StringType })
        ) { entry ->
            val scope = entry.arguments?.getString("scope") ?: "global"
            VoiceScreen(nav, carId = scope.takeIf { it != "global" })
        }
        composable("settings") { SettingsScreen(nav) }
    }
}
