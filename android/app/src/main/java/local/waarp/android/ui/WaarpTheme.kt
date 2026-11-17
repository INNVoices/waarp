package local.waarp.android.ui

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

internal val WaarpOrange = Color(0xFFE48562)
internal val WaarpGreen = Color(0xFF9CC8AC)
internal val WaarpMuted = Color(0xFFABA49D)
internal val WaarpWarning = Color(0xFFE5C47C)

private val Colors = darkColorScheme(
    primary = WaarpOrange,
    onPrimary = Color(0xFF251109),
    primaryContainer = Color(0xFF543326),
    onPrimaryContainer = Color(0xFFFFDCCB),
    secondary = Color(0xFFACBEC8),
    onSecondary = Color(0xFF162026),
    secondaryContainer = Color(0xFF303C42),
    onSecondaryContainer = Color(0xFFD7E5EC),
    tertiary = WaarpGreen,
    background = Color(0xFF141311),
    onBackground = Color(0xFFEDE8E2),
    surface = Color(0xFF1D1B18),
    onSurface = Color(0xFFEDE8E2),
    surfaceVariant = Color(0xFF2A2723),
    onSurfaceVariant = WaarpMuted,
    outline = Color(0xFF5C554E),
    outlineVariant = Color(0xFF3A3530),
    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
    errorContainer = Color(0xFF512522),
    onErrorContainer = Color(0xFFFFDAD5),
)

@Composable
fun WaarpTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = Colors,
        typography = Typography(),
        shapes = Shapes(
            extraSmall = RoundedCornerShape(6.dp),
            small = RoundedCornerShape(10.dp),
            medium = RoundedCornerShape(16.dp),
            large = RoundedCornerShape(22.dp),
            extraLarge = RoundedCornerShape(28.dp),
        ),
        content = content,
    )
}
