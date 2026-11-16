package local.waarp.android.acceptance;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Instrumentation;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Rect;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import androidx.test.uiautomator.By;
import androidx.test.uiautomator.Direction;
import androidx.test.uiautomator.StaleObjectException;
import androidx.test.uiautomator.UiDevice;
import androidx.test.uiautomator.UiObject2;
import java.util.ArrayList;
import java.util.ArrayDeque;
import java.util.Comparator;
import java.util.List;

/** Public accessibility labels only: no Compose test tags or production calls. */
final class ReleaseUi {
    static final String TARGET = "local.waarp.android";
    static final String PROBE_LABEL = "Waarp Acceptance Probe";
    final UiDevice device;
    private final Instrumentation instrumentation;

    ReleaseUi(Instrumentation instrumentation) {
        this.instrumentation = instrumentation;
        device = UiDevice.getInstance(instrumentation);
        AccessibilityServiceInfo info = instrumentation.getUiAutomation().getServiceInfo();
        info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
        instrumentation.getUiAutomation().setServiceInfo(info);
    }

    void launchTarget() {
        Intent intent = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                .setComponent(new ComponentName(TARGET, TARGET + ".MainActivity"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        instrumentation.getContext().startActivity(intent);
        waitText("Главная", 20000);
        allowNotificationPrompt();
    }

    void launchProbe() {
        instrumentation.getContext().startActivity(new Intent(instrumentation.getContext(), ProbeActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        long deadline = SystemClock.elapsedRealtime() + 10000;
        while (SystemClock.elapsedRealtime() < deadline) {
            if (device.hasObject(By.pkg(instrumentation.getContext().getPackageName()).textContains(PROBE_LABEL))) return;
            SystemClock.sleep(100);
        }
        throw new AssertionError("probe_activity_not_foreground");
    }

    void navigate(String label) {
        // A selected Compose navigation item exposes selected=true but no
        // accessibility click action. Re-entering the current tab is complete
        // only when that actual selection is observed, not merely its label.
        long deadline = SystemClock.elapsedRealtime() + 15000, unchangedSince = 0;
        Rect previous = null;
        UiObject2 target = null;
        while (SystemClock.elapsedRealtime() < deadline) {
            allowNotificationPrompt();
            UiObject2 node = navigationItem(label);
            if (node != null && node.isEnabled()) {
                Rect bounds = node.getVisibleBounds();
                if (bounds.equals(previous)) {
                    if (SystemClock.elapsedRealtime() - unchangedSince >= 250) { target = node; break; }
                } else { previous = bounds; unchangedSince = SystemClock.elapsedRealtime(); }
            } else { previous = null; unchangedSince = 0; }
            SystemClock.sleep(80);
        }
        TrafficProbe.require(target != null, "navigation_not_ready:" + label);
        if (target.isSelected()) return;
        target.click(); // at most one navigation action
        deadline = SystemClock.elapsedRealtime() + 15000;
        while (SystemClock.elapsedRealtime() < deadline) {
            UiObject2 node = navigationItem(label);
            if (node != null && node.isEnabled() && node.isSelected()) return;
            SystemClock.sleep(80);
        }
        throw new AssertionError("navigation_not_selected:" + label);
    }

    void importProfile(String name, String configuration) {
        navigate("Туннели");
        click("Добавить туннель");
        waitText("Название (необязательно)", 10000);
        int formWindow = activeWindow().id;
        setField("Название (необязательно)", name);
        setField("Конфигурация или ссылка", configuration);
        click("Импортировать");
        waitWindowClosed(formWindow, 30000);
        waitText(name, 30000);
    }

    void addSelectedAppRoute(String profileName) {
        navigate("Маршруты"); click("Добавить маршрут");
        waitText("Приложение", 10000);
        int formWindow = activeWindow().id;
        setField("Название или пакет", instrumentation.getContext().getPackageName());
        click(PROBE_LABEL);
        click("Основной путь"); click(profileName);
        click("Сохранить маршрут");
        waitWindowClosed(formWindow, 30000);
        waitText(PROBE_LABEL, 20000);
    }

    void configureFixtureRouting(String profileName) {
        clickDescription("Настройки");
        // Compose exposes the visible title and the switch description as
        // separate nodes. The description itself is a non-checkable child;
        // resolve its actionable parent and wait for the screen transition.
        UiObject2 lan = ready("Локальная сеть напрямую", true, false, 15000);
        TrafficProbe.require(lan != null && lan.isCheckable(), "lan_setting_missing");
        if (lan.isChecked()) lan.click();
        long deadline = SystemClock.elapsedRealtime() + 30000;
        boolean saved = false;
        while (SystemClock.elapsedRealtime() < deadline) {
            lan = find("Локальная сеть напрямую", true, false);
            if (lan != null && lan.isCheckable() && lan.isEnabled() && !lan.isChecked()) { saved = true; break; }
            SystemClock.sleep(100);
        }
        TrafficProbe.require(saved, "lan_setting_not_disabled");
        click("Путь общего DNS");
        click(profileName);
        deadline = SystemClock.elapsedRealtime() + 30000;
        saved = false;
        while (SystemClock.elapsedRealtime() < deadline) {
            UiObject2 path = find("Путь общего DNS", true, false);
            if (path != null && path.isEnabled() && (profileName.equals(path.getText()) ||
                    (path.getText() != null && path.getText().contains(profileName)) || path.findObject(By.text(profileName)) != null)) {
                saved = true; break;
            }
            SystemClock.sleep(100);
        }
        TrafficProbe.require(saved, "common_dns_setting_not_saved");
        clickDescription("Назад");
        waitText("Главная", 10000);
    }

    void startVpn(TrafficProbe probe) {
        navigate("Главная"); click("Включить");
        long deadline = SystemClock.elapsedRealtime() + 30000;
        while (SystemClock.elapsedRealtime() < deadline) {
            allowNotificationPrompt();
            UiObject2 consent = device.findObject(By.pkg("com.android.vpndialogs").res("android:id/button1"));
            if (consent != null && consent.isEnabled()) consent.click();
            if (probe.vpnActive() && hasText("Выключить")) return;
            SystemClock.sleep(150);
        }
        throw new AssertionError("vpn_start_ui_or_network_timeout");
    }

    void stopVpn(TrafficProbe probe) {
        navigate("Главная"); click("Выключить");
        long deadline = SystemClock.elapsedRealtime() + 20000;
        while (SystemClock.elapsedRealtime() < deadline) {
            if (!probe.vpnActive() && hasText("Включить")) return;
            SystemClock.sleep(100);
        }
        throw new AssertionError("vpn_stop_ui_or_network_timeout");
    }

    void rename(String oldName, String newName) {
        navigate("Туннели"); click(oldName); click("Переименовать");
        waitText("Название туннеля", 10000);
        int formWindow = activeWindow().id;
        setField("Название", newName); click("Сохранить");
        waitWindowClosed(formWindow, 30000); waitText(newName, 15000);
    }

    void deleteAssignedProfile(String name) {
        navigate("Туннели"); click(name); click("Удалить туннель");
        scrollTo("Куда переназначить маршруты");
        int formWindow = activeWindow().id;
        TrafficProbe.require(hasText("Без переназначения"), "delete_default_not_blocked");
        click("Удалить");
        waitWindowClosed(formWindow, 30000);
        waitAbsent(name, 20000);
        navigate("Маршруты");
        waitText("Соединения заблокированы", 20000);
    }

    void deleteRoute() {
        navigate("Маршруты"); click(PROBE_LABEL); click("Удалить маршрут");
        int formWindow = activeWindow().id;
        click("Удалить"); waitWindowClosed(formWindow, 30000);
        waitText("Маршрутов пока нет", 20000);
    }

    void click(String label) {
        scrollTo(label); closeIme();
        ready(label, true, false, 15000).click(); // exactly one mutation
    }

    void clickDescription(String label) {
        long deadline = SystemClock.elapsedRealtime() + 15000;
        while (SystemClock.elapsedRealtime() < deadline) {
            UiObject2 target = find(label, true, false);
            if (target != null && target.isEnabled()) { target.click(); return; }
            SystemClock.sleep(100);
        }
        throw new AssertionError("description_not_clickable:" + label);
    }

    void setField(String label, String value) {
        scrollTo(label);
        UiObject2 field = null;
        long deadline = SystemClock.elapsedRealtime() + 10000;
        while (SystemClock.elapsedRealtime() < deadline && field == null) {
            field = editableField(label);
            if (field != null && !field.isEnabled()) field = null;
            if (field == null) SystemClock.sleep(100);
        }
        TrafficProbe.require(field != null && field.isEnabled(), "editable_field_missing:" + label);
        field.click(); field.setText(value); // exactly one edit
        closeIme();
        // The secret field is intentionally masked. The later cryptographic
        // round trip verifies its exact configuration without exposing it here.
        if (!label.contains("Конфигурация")) {
            // ACTION_SET_TEXT returns before Compose publishes its updated
            // accessibility tree. Re-resolve the field; never repeat the edit.
            deadline = SystemClock.elapsedRealtime() + 10000;
            while (SystemClock.elapsedRealtime() < deadline) {
                UiObject2 updated = editableField(label);
                if (updated != null && value.equals(updated.getText())) return;
                SystemClock.sleep(80);
            }
            throw new AssertionError("field_edit_not_applied:" + label);
        }
    }

    private UiObject2 editableField(String label) {
        try {
            UiObject2 labelNode = find(label, false, false);
            if (labelNode == null) return null;
            Rect labelBounds = labelNode.getVisibleBounds();
            WindowSnapshot active = activeWindow();
            for (UiObject2 candidate : device.findObjects(By.pkg(TARGET).clazz("android.widget.EditText"))) {
                if (!active.contains(candidate)) continue;
                Rect bounds = candidate.getVisibleBounds();
                if (bounds.height() > 0 && bounds.left <= labelBounds.centerX() && bounds.right >= labelBounds.centerX() &&
                        bounds.top - 60 <= labelBounds.centerY() && bounds.bottom >= labelBounds.centerY()) return candidate;
            }
            return null;
        } catch (StaleObjectException ignored) { return null; }
    }

    private UiObject2 navigationItem(String label) {
        try {
            UiObject2 candidate = find(label, false, true);
            for (int depth = 0; candidate != null && depth < 8; depth++, candidate = candidate.getParent()) {
                Rect bounds = candidate.getVisibleBounds();
                if ((candidate.isSelected() || candidate.isClickable()) && bounds.height() > 0 &&
                        bounds.height() < device.getDisplayHeight() * 0.8) return candidate;
            }
            return null;
        } catch (StaleObjectException ignored) { return null; }
    }

    void closeIme() {
        if (!imeVisible()) return;
        device.pressBack();
        long deadline = SystemClock.elapsedRealtime() + 5000;
        while (imeVisible() && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(100);
        TrafficProbe.require(!imeVisible(), "ime_did_not_close");
    }

    private boolean imeVisible() {
        for (AccessibilityWindowInfo window : instrumentation.getUiAutomation().getWindows()) {
            if (window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) return true;
        }
        return false;
    }

    void scrollTo(String label) {
        for (int attempt = 0; attempt < 9; attempt++) {
            if (find(label, false, false) != null) return;
            List<UiObject2> scrollables = device.findObjects(By.pkg(TARGET).scrollable(true));
            WindowSnapshot active = activeWindow();
            scrollables.removeIf(node -> !active.contains(node));
            scrollables.sort(Comparator.comparingInt((UiObject2 node) -> node.getVisibleBounds().height()).reversed());
            if (!scrollables.isEmpty()) scrollables.get(0).scroll(Direction.DOWN, 0.65f);
            else device.swipe(device.getDisplayWidth() / 2, device.getDisplayHeight() * 3 / 4,
                    device.getDisplayWidth() / 2, device.getDisplayHeight() / 3, 28);
            SystemClock.sleep(150);
        }
        throw new AssertionError("text_not_found_after_scroll:" + label);
    }

    boolean hasText(String label) { return find(label, false, false) != null; }
    void waitText(String label, long timeout) { ready(label, false, false, timeout); }
    void waitAbsent(String label, long timeout) {
        long deadline = SystemClock.elapsedRealtime() + timeout;
        while (SystemClock.elapsedRealtime() < deadline) {
            if (!hasText(label)) return;
            SystemClock.sleep(100);
        }
        throw new AssertionError("text_did_not_disappear:" + label);
    }

    private UiObject2 ready(String label, boolean action, boolean bottom, long timeout) {
        long deadline = SystemClock.elapsedRealtime() + timeout, unchangedSince = 0;
        Rect previous = null;
        while (SystemClock.elapsedRealtime() < deadline) {
            allowNotificationPrompt();
            UiObject2 node = find(label, action, bottom);
            if (node != null && (!action || node.isEnabled())) {
                Rect bounds = node.getVisibleBounds();
                if (bounds.equals(previous)) {
                    if (SystemClock.elapsedRealtime() - unchangedSince >= 250) return node;
                } else { previous = bounds; unchangedSince = SystemClock.elapsedRealtime(); }
            } else { previous = null; unchangedSince = 0; }
            SystemClock.sleep(80);
        }
        throw new AssertionError("ui_ready_timeout:" + label);
    }

    private UiObject2 find(String label, boolean action, boolean bottom) {
        List<UiObject2> matches = new ArrayList<>();
        try {
            WindowSnapshot active = activeWindow();
            List<UiObject2> candidates = new ArrayList<>(device.findObjects(By.pkg(TARGET).textContains(label)));
            candidates.addAll(device.findObjects(By.pkg(TARGET).desc(label)));
            for (UiObject2 candidate : candidates) {
                if (!active.contains(candidate)) continue;
                String text = candidate.getText(), description = candidate.getContentDescription();
                boolean exact = label.equals(description);
                if (text != null) for (String line : text.split("\n")) exact |= label.equals(line);
                if (!exact || candidate.getVisibleBounds().isEmpty()) continue;
                UiObject2 selected = action ? clickable(candidate) : candidate;
                if (selected != null) matches.add(selected);
            }
            if (matches.isEmpty()) return null;
            matches.sort(Comparator.comparingInt(node -> node.getVisibleBounds().centerY()));
            return bottom ? matches.get(matches.size() - 1) : matches.get(0);
        } catch (StaleObjectException ignored) { return null; }
    }

    private UiObject2 clickable(UiObject2 candidate) {
        for (int depth = 0; candidate != null && depth < 8; depth++, candidate = candidate.getParent()) {
            Rect bounds = candidate.getVisibleBounds();
            if (candidate.isClickable() && bounds.height() > 0 && bounds.height() < device.getDisplayHeight() * 0.8) return candidate;
        }
        return null;
    }

    private void allowNotificationPrompt() {
        UiObject2 allow = device.findObject(By.res("com.android.permissioncontroller:id/permission_allow_button"));
        if (allow == null) allow = device.findObject(By.res("com.google.android.permissioncontroller:id/permission_allow_button"));
        if (allow != null && allow.isEnabled()) allow.click();
    }

    private void waitWindowClosed(int id, long timeout) {
        TrafficProbe.require(id >= 0, "modal_window_identity_missing");
        long deadline = SystemClock.elapsedRealtime() + timeout;
        while (SystemClock.elapsedRealtime() < deadline) {
            boolean present = false;
            for (AccessibilityWindowInfo window : instrumentation.getUiAutomation().getWindows()) {
                if (window.getId() == id) present = true;
            }
            if (!present) return;
            SystemClock.sleep(100);
        }
        throw new AssertionError("committed_form_did_not_close");
    }

    /** Distinguish identical labels in an Activity and its ModalBottomSheet
     * window using public accessibility evidence, without test-only tags. */
    private WindowSnapshot activeWindow() {
        AccessibilityWindowInfo top = null;
        for (AccessibilityWindowInfo window : instrumentation.getUiAutomation().getWindows()) {
            AccessibilityNodeInfo root = window.getRoot();
            if (root == null) continue;
            boolean target = TARGET.contentEquals(root.getPackageName() == null ? "" : root.getPackageName());
            root.recycle();
            if (target && (window.isActive() || window.isFocused()) &&
                    (top == null || window.getLayer() > top.getLayer())) top = window;
        }
        WindowSnapshot snapshot = new WindowSnapshot(top == null ? -1 : top.getId());
        AccessibilityNodeInfo root = top == null ? null : top.getRoot();
        if (root == null) return snapshot;
        ArrayDeque<AccessibilityNodeInfo> queue = new ArrayDeque<>(); queue.add(root);
        while (!queue.isEmpty()) {
            AccessibilityNodeInfo node = queue.removeFirst();
            if (node.isVisibleToUser()) {
                Rect bounds = new Rect(); node.getBoundsInScreen(bounds);
                snapshot.nodes.add(new NodeIdentity(bounds, String.valueOf(node.getClassName()), String.valueOf(node.getText()), String.valueOf(node.getContentDescription())));
            }
            for (int i = 0; i < node.getChildCount(); i++) {
                AccessibilityNodeInfo child = node.getChild(i); if (child != null) queue.add(child);
            }
            node.recycle();
        }
        return snapshot;
    }

    private static final class NodeIdentity {
        final Rect bounds; final String type, text, description;
        NodeIdentity(Rect bounds, String type, String text, String description) {
            this.bounds = bounds; this.type = type; this.text = text; this.description = description;
        }
    }

    private static final class WindowSnapshot {
        final int id; final List<NodeIdentity> nodes = new ArrayList<>();
        WindowSnapshot(int id) { this.id = id; }
        boolean contains(UiObject2 node) {
            Rect bounds = node.getVisibleBounds();
            for (NodeIdentity expected : nodes) {
                if (expected.bounds.contains(bounds) && !bounds.isEmpty() && expected.type.equals(node.getClassName()) &&
                        expected.text.equals(String.valueOf(node.getText())) && expected.description.equals(String.valueOf(node.getContentDescription()))) return true;
            }
            return false;
        }
    }
}
