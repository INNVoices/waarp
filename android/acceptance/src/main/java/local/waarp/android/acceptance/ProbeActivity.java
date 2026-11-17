package local.waarp.android.acceptance;

import android.app.Activity;
import android.os.Bundle;
import android.widget.TextView;

/** Public launcher for the separate probe UID; contains no production hooks. */
public final class ProbeActivity extends Activity {
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        TextView label = new TextView(this);
        label.setText("Waarp Acceptance Probe\n\nSynthetic DNS and HTTP traffic runs under this application's separate Android UID.");
        label.setTextSize(20);
        label.setPadding(32, 64, 32, 32);
        setContentView(label);
    }
}
