package local.waarp.android.acceptance;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Scalar-only interpretation of WindowManager evidence; never retains editor text. */
final class ImeVisibility {
    enum State { VISIBLE, HIDDEN, UNKNOWN }
    enum Action { WAIT, BACK, DONE, REJECT_FOCUS, TIMEOUT }

    private static final Pattern WINDOW = Pattern.compile("(?m)^  Window #[0-9]+ Window\\{[^\\r\\n]+\\}: *$");
    private static final Pattern TYPE = Pattern.compile("\\bty=([A-Z0-9_]+)\\b");
    private static final Pattern VISIBLE = Pattern.compile("(?m)^ +isVisible=(true|false) *$");
    private static final Pattern HAS_SURFACE = Pattern.compile("(?m)^ +mHasSurface=(true|false)(?: |$)");
    private static final Pattern SHOWN = Pattern.compile("(?m)^ +Surface: shown=(true|false)(?: |$)");
    private static final Pattern COMPLETE = Pattern.compile("(?m)^  mSystemBooted=true mDisplayEnabled=true(?: |$)");

    private ImeVisibility() { }

    static State afterWindowManager(State state, boolean visible, int windows, boolean sameFocus) {
        if (!sameFocus) return State.UNKNOWN;
        if (visible) return State.VISIBLE;
        // A fresh accessibility snapshot supersedes stale positive WM evidence.
        // Otherwise a keyboard that disappeared during dumpsys could cause Back
        // to dismiss the form. A retained window alone never proves absence.
        return windows == 0 ? State.HIDDEN : state;
    }

    static State windowManagerState(String dump) {
        // Android 10 WindowManagerService.dumpWindowsLocked/WindowState.dump and
        // WindowSurfaceController.dump expose type, visibility and shown surface.
        // A missing/truncated/unsupported dump cannot prove keyboard absence.
        if (dump == null || dump.length() > 262144 ||
                !dump.contains("WINDOW MANAGER WINDOWS (dumpsys window windows)") ||
                !COMPLETE.matcher(dump).find() || dump.contains("DUMP TIMEOUT") ||
                dump.contains("Permission Denial") || dump.contains("Error dumping service")) return State.UNKNOWN;
        Matcher windows = WINDOW.matcher(dump);
        List<Integer> starts = new ArrayList<>(), ends = new ArrayList<>();
        while (windows.find()) { starts.add(windows.start()); ends.add(windows.end()); }
        if (starts.isEmpty() || starts.size() > 128) return State.UNKNOWN;
        boolean visible = false;
        for (int i = 0; i < starts.size(); i++) {
            String body = dump.substring(ends.get(i), i + 1 == starts.size() ? dump.length() : starts.get(i + 1));
            Matcher type = TYPE.matcher(body);
            if (!type.find()) return State.UNKNOWN;
            String kind = type.group(1);
            if (type.find()) return State.UNKNOWN;
            if (!kind.equals("INPUT_METHOD") && !kind.equals("INPUT_METHOD_DIALOG")) continue;
            Boolean isVisible = scalar(body, VISIBLE), hasSurface = scalar(body, HAS_SURFACE), shown = scalar(body, SHOWN);
            if (isVisible == null || hasSurface == null) return State.UNKNOWN;
            if (Boolean.TRUE.equals(isVisible) && Boolean.TRUE.equals(hasSurface) && Boolean.TRUE.equals(shown)) {
                visible = true;
            } else if (!(Boolean.FALSE.equals(isVisible) &&
                    (Boolean.FALSE.equals(hasSurface) && !Boolean.TRUE.equals(shown) ||
                     Boolean.TRUE.equals(hasSurface) && Boolean.FALSE.equals(shown)))) {
                return State.UNKNOWN;
            }
        }
        return visible ? State.VISIBLE : State.HIDDEN;
    }

    private static Boolean scalar(String text, Pattern pattern) {
        Matcher matcher = pattern.matcher(text);
        if (!matcher.find()) return null;
        boolean value = Boolean.parseBoolean(matcher.group(1));
        return matcher.find() ? null : value;
    }

    /** One Back at most; unknown state or lost focus cannot complete the gate. */
    static final class Readiness {
        final long started;
        final long deadline;
        int ownerId = -1;
        boolean backIssued;
        private long hiddenSince = -1;

        Readiness(long now) { started = now; deadline = now + 5000; }

        Action observe(long now, int focusedTargetId, State state) {
            if (now >= deadline) return Action.TIMEOUT;
            if (focusedTargetId < 0) { hiddenSince = -1; return Action.WAIT; }
            if (ownerId < 0) ownerId = focusedTargetId;
            if (focusedTargetId != ownerId) return Action.REJECT_FOCUS;
            if (state == State.HIDDEN) {
                if (hiddenSince < 0) hiddenSince = now;
                return now - hiddenSince >= 250 ? Action.DONE : Action.WAIT;
            }
            hiddenSince = -1;
            if (state == State.VISIBLE && !backIssued) {
                backIssued = true;
                return Action.BACK;
            }
            return Action.WAIT;
        }
    }
}
