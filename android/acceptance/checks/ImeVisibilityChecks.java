package local.waarp.android.acceptance;

/** Host-only scalar fixtures derived from the reviewed AOSP dump format. */
public final class ImeVisibilityChecks {
    private static int checks;
    private static final String HEADER = "WINDOW MANAGER WINDOWS (dumpsys window windows)\n";
    private static final String FOOTER = "  mSystemBooted=true mDisplayEnabled=true\n";

    private static String window(int index, String kind, boolean visible, boolean surface, String shown) {
        return "  Window #" + index + " Window{abc u0 " + (kind.equals("INPUT_METHOD") ? "InputMethod" : "local.waarp.android") + "}:\n" +
                "    mAttrs={(0,0)(fillxwrap) ty=" + kind + " fmt=TRANSPARENT}\n" +
                "    mHasSurface=" + surface + " isReadyForDisplay()=" + visible + "\n" +
                (shown == null ? "" : "      Surface: shown=" + shown + " layer=0 alpha=1.0\n") +
                "    isVisible=" + visible + "\n";
    }
    private static void check(boolean value, String name) {
        checks++;
        if (!value) throw new AssertionError(name);
    }
    private static void state(String dump, ImeVisibility.State expected, String name) {
        check(ImeVisibility.windowManagerState(dump) == expected, name);
    }
    public static void main(String[] args) {
        String hidden = HEADER + window(0, "INPUT_METHOD", false, true, "false") + FOOTER;
        state(hidden, ImeVisibility.State.HIDDEN, "retained IME window has an unshown surface");
        state(HEADER + window(0, "INPUT_METHOD", false, false, null) + FOOTER, ImeVisibility.State.HIDDEN, "IME surface destroyed");
        state(HEADER + window(0, "INPUT_METHOD", true, true, "true") + FOOTER, ImeVisibility.State.VISIBLE, "shown IME remains visible");
        state(HEADER + window(0, "BASE_APPLICATION", true, true, "true") + FOOTER, ImeVisibility.State.HIDDEN, "complete dump has no IME");
        state(HEADER + window(0, "INPUT_METHOD", false, true, "false") + window(1, "INPUT_METHOD", true, true, "true") + FOOTER,
                ImeVisibility.State.VISIBLE, "a second visible IME cannot be ignored");
        state(HEADER + window(0, "INPUT_METHOD", false, true, "false") + window(1, "INPUT_METHOD_DIALOG", true, true, "true") + FOOTER,
                ImeVisibility.State.VISIBLE, "a visible input-method dialog cannot be ignored");
        state(hidden.replace(FOOTER, ""), ImeVisibility.State.UNKNOWN, "truncated dump cannot prove absence");
        state(hidden.replace("    isVisible=false\n", ""), ImeVisibility.State.UNKNOWN, "missing visibility cannot prove absence");
        state(hidden.replace("    isVisible=false\n", "    isVisible=false\n    isVisible=true\n"), ImeVisibility.State.UNKNOWN, "duplicate visibility is ambiguous");
        state(hidden.replace("ty=INPUT_METHOD", "type=2011"), ImeVisibility.State.UNKNOWN, "unsupported type format is not absence");
        state(HEADER + window(0, "INPUT_METHOD", false, false, "true") + FOOTER, ImeVisibility.State.UNKNOWN, "contradictory surface state");
        state(hidden + "DUMP TIMEOUT\n", ImeVisibility.State.UNKNOWN, "server timeout cannot prove absence");
        state(null, ImeVisibility.State.UNKNOWN, "no dump cannot prove absence");

        ImeVisibility.Readiness sequence = new ImeVisibility.Readiness(0);
        check(sequence.observe(0, 7, ImeVisibility.State.VISIBLE) == ImeVisibility.Action.BACK, "one Back for observed visible IME");
        check(sequence.observe(100, 7, ImeVisibility.State.VISIBLE) == ImeVisibility.Action.WAIT, "never send another Back");
        check(sequence.observe(200, 7, ImeVisibility.State.UNKNOWN) == ImeVisibility.Action.WAIT, "null root/unknown cannot complete");
        check(sequence.observe(400, 7, ImeVisibility.State.HIDDEN) == ImeVisibility.Action.WAIT, "hidden must settle");
        check(sequence.observe(649, 7, ImeVisibility.State.HIDDEN) == ImeVisibility.Action.WAIT, "249ms is insufficient");
        check(sequence.observe(650, 7, ImeVisibility.State.HIDDEN) == ImeVisibility.Action.DONE, "250ms stable hidden completes");
        check(sequence.backIssued, "Back remains recorded");

        ImeVisibility.Readiness absent = new ImeVisibility.Readiness(10);
        check(absent.observe(10, 8, ImeVisibility.State.HIDDEN) == ImeVisibility.Action.WAIT, "already hidden starts settling");
        check(absent.observe(260, 8, ImeVisibility.State.HIDDEN) == ImeVisibility.Action.DONE && !absent.backIssued,
                "do not dismiss an already keyboard-free form");

        ImeVisibility.State disappeared = ImeVisibility.afterWindowManager(ImeVisibility.State.VISIBLE, false, 0, true);
        ImeVisibility.Readiness removal = new ImeVisibility.Readiness(0);
        check(removal.observe(0, 8, disappeared) == ImeVisibility.Action.WAIT && !removal.backIssued,
                "fresh IME absence overrides stale visible WM evidence without Back");
        check(removal.observe(250, 8, disappeared) == ImeVisibility.Action.DONE && !removal.backIssued,
                "IME removed during WM observation settles without dismissing the form");
        check(ImeVisibility.afterWindowManager(ImeVisibility.State.HIDDEN, true, 1, true) == ImeVisibility.State.VISIBLE,
                "fresh visible root overrides an earlier hidden surface");
        check(ImeVisibility.afterWindowManager(ImeVisibility.State.HIDDEN, false, 0, false) == ImeVisibility.State.UNKNOWN,
                "a changed focused form invalidates WM evidence");

        ImeVisibility.Readiness focus = new ImeVisibility.Readiness(0);
        focus.observe(0, 9, ImeVisibility.State.HIDDEN);
        check(focus.observe(240, -1, ImeVisibility.State.HIDDEN) == ImeVisibility.Action.WAIT, "lost target focus cannot pass");
        check(focus.observe(300, 9, ImeVisibility.State.HIDDEN) == ImeVisibility.Action.WAIT, "focus loss resets settling");
        check(focus.observe(550, 9, ImeVisibility.State.HIDDEN) == ImeVisibility.Action.DONE, "restored same owner settles again");
        check(focus.observe(600, 10, ImeVisibility.State.HIDDEN) == ImeVisibility.Action.REJECT_FOCUS, "changed modal identity is rejected");

        ImeVisibility.Readiness deadline = new ImeVisibility.Readiness(0);
        check(deadline.observe(4999, 7, ImeVisibility.State.UNKNOWN) == ImeVisibility.Action.WAIT, "unknown stays unresolved");
        check(deadline.observe(5000, 7, ImeVisibility.State.HIDDEN) == ImeVisibility.Action.TIMEOUT, "five-second deadline cannot be extended by hidden result");
        System.out.println("IME scalar/readiness checks: " + checks + " assertions passed; no Android app or emulator executed.");
    }
}
