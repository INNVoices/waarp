# Android Chameleon / Sticky Entry — feasibility and design note

**Project:** Waarp Android (`local.waarp.android`)  
**Date:** 2026-11-18  
**Status:** Research / concept only. **No implementation, approval, or release claim.**  
**Scope:** Android UI entry and discoverability only; no VPN protocol, routing, service, or desktop changes.

## 1. Requested experience

The user wants a separate *Chameleon* mode, not merely a transparent icon:

1. Waarp need not appear as a conventional launcher app.
2. The user can deliberately associate a recognizable element or interaction in **another installed app** with opening Waarp.
3. The other app needs no APK modification, plugin, cooperation, or explicit integration.
4. Waarp opens as a genuine Android application with its own routes, tunnels, UI and VPN controls; returning from it should restore the previous app's normal task flow.
5. This should remain optional and reversible. Normal Waarp behavior must not depend on its being enabled.

For example, the user might choose a particular control in a third-party app as a recognizable trigger. This is a **user-configured cross-app entry point**, not actual execution inside the other app's process. Never imply that an official/government app endorses or contains Waarp.

**Threat model:** limit casual discoverability on the launcher and provide a less conspicuous voluntary entry route. **Not** concealment from Android Settings, system administrators, a full device inspection, forensic tools, or VPN indicators. Do not advertise guaranteed invisibility or protection from lawful/device-level inspection.

## 2. Feasibility matrix

| Proposal | Stock Android without root | Actual boundary |
| --- | --- | --- |
| Hide or switch a launcher entry via an owned activity/alias | Potentially feasible; OEM/launcher test required | Hides an entry point, **not** the installed package or VPN service |
| Neutral, owner-controlled cover screen with deliberate unlock gesture | Feasible | This is still Waarp, not another vendor's application |
| Open Waarp when a chosen text/accessible UI element is clicked in another app | **Conditional**: explicit Accessibility enablement, available events, OS/activity-launch limitations | Works only where the target emits an observable suitable event; does not intercept/replace that button's action |
| Bind any pixel/coordinate of any app reliably, even custom games or protected UI | **Not generally feasible** | Coordinates/layout change; secure/custom views may expose no useful accessibility events |
| Seamlessly embed Waarp as a real sub-app inside arbitrary unchanged APKs | **No general stock Android API** | App/process sandbox and activity ownership remain separate |
| Hide an active `VpnService` from the OS, settings and all system surfaces | **No** | Android owns VPN consent, service lifecycle and user-visible network state |
| Install Waarp into Android 15 Private Space and keep VPN running while the space is locked | **No** | Locking stops the private profile and its apps |

**Analogy, not a dependency:** MacroDroid's documented *UI Click* trigger detects selected click or long-click events in chosen apps through Accessibility, without modifying those apps. It also expressly notes unsupported click detection for some apps. This proves a limited *trigger* design, not the stronger claim of arbitrary in-app embedding or invisibility.

## 3. Candidate modes

### A. Neutral entry / own cover (recommended first research candidate)

An optional owned entry screen, with a user-chosen neutral appearance and deliberate unlock action, can open the ordinary Waarp interface. A launcher alias may be configurable where the tested OS permits it.

- Do not imitate third-party brands, government apps, security dialogs or system identity.
- Keep an easy, documented, authenticated way to restore the normal launcher entry.
- Never disable the only practical recovery/control path.
- Clarify visibility: installed apps, permissions, VPN state and system settings remain discoverable.
- Treat launcher behavior and activity/task restoration as OEM-specific acceptance cases.

This offers a more predictable and supportable entry path than cross-app observation.

### B. Sticky entry from a third-party app (research spike only)

User flow: select a **specific installed app** → choose a supported, identifiable accessibility element/event (for example a labeled long click) → verify a local preview → explicitly arm the trigger → trigger opens Waarp via a supported Android foreground-entry path → Back returns to the prior app when normal task semantics permit it.

Technical hypothesis: a narrowly scoped, user-enabled `AccessibilityService` receives `AccessibilityEvent` click/long-click events for the selected package. Matching may use stable package identity and the visible node's text/content description or available view metadata. This is **observation**, not injecting a button into the third-party process.

Limits to record before any implementation:

- Accessibility must be enabled by the user in system settings. It is highly privileged and should be avoided if a narrower, reliable API can satisfy the use case.
- Some applications use custom rendering, secured controls or omit useful events; event IDs and labels can change on localization or update.
- A tap on the original third-party control can still execute that control's original action. Waarp must not hijack, suppress, or rewrite it.
- Pixel-only selection or arbitrary-coordinate click capture is not equivalent to reliable click-event recognition.
- Android 10+ background activity launch restrictions affect whether/when the observer may present a new Activity; do not assume an unrestricted silent launch. If direct foreground entry is disallowed, an explicit user-action fallback is needed.
- Permission revocation, target uninstall/update, target app moving to another profile, screen-off/lock state and service death must fail safely: **disable the entry**, not change the VPN.
- No broad monitoring of every app by default; no capture, logging, remote transmission or storage of texts from unrelated applications, passwords or screens.
- Google Play's Accessibility and deceptive-behavior rules may make a marketed *concealment / interface mimicry* feature unsuitable for Play distribution. A clearly disclosed, narrowly scoped feature still requires policy review and platform consent; no approval is presumed.

### C. Independent supported fallback paths

Investigate documented, recoverable options such as a user-created shortcut, explicit tile/notification interaction or a normal secure in-app gesture, rather than requiring Accessibility to remain enabled. Evaluate each against background launch, user-gesture and notification policies. No hidden remote entry point or externally invokable mutation command.

### D. Out of scope

Root/Xposed/system-package injection, patching another app, bypassing Android system indicators, intercepting touches within arbitrary protected applications, abusing overlays to impersonate trusted controls, and relying on Accessibility to defeat OS privacy/security controls. These cannot be presented as general no-root product features.

## 4. Waarp-specific non-negotiable runtime invariants

The existing Android app is native Kotlin/Compose (Android 10+), with `WaarpApplication` owning the repository/controller and a real Android `VpnService` running independently of visible Activity. Current architecture and lifecycle semantics are documented in [ANDROID.md](ANDROID.md) and [the TUN/UI ownership audit](TUN-OWNERSHIP-AND-UI-2026-11-18.md).

**UI visibility / launcher aliases / cover screens / sticky-entry events are presentation concerns, not VPN commands.**

1. **No automatic TUN/VPN ON, OFF, restart, re-establish, rebuild or route mutation** when entering/exiting Chameleon, enabling/disabling its trigger, changing icon/alias, entering from another app, going Back, locking the screen, or losing Accessibility permission.
2. Only the existing explicit user ON/OFF action (or documented, separately configured system Always-on VPN and lifecycle handling) governs VPN state. Never bind service lifecycle to the Chameleon Activity.
3. Preserve live session identity and existing route/connection state on UI entry/exit. Never instantiate a second VPN/native engine as a side effect.
4. Failed or stale trigger matches must be inert. No silent Direct fallback, new tunnel selection, or unannounced reconfiguration.
5. Settings, app removal, permission revocation, notifications and system VPN controls remain accessible and behave according to Android. Chameleon must not disable their visibility or revocability.
6. Treat the Android system consent dialog and foreground service notification as required system/UX boundaries. No false claim of total stealth.
7. Never collect a third-party app's secrets or UI contents for a `where to open Waarp` shortcut; keep only the minimum opt-in local matcher configuration if eventually approved.

**Regression gate:** with the VPN ON, repeatedly open/close the cover and invoke or disable a sticky trigger. The existing core/service/TUN must remain in its prior state; no new consent, unexpected state transition or interruption caused by the Chameleon feature. Repeat while VPN OFF; observation alone must not turn it ON.

## 5. Research and acceptance plan — not implementation authorization

1. **Platform proof:** create an isolated prototype, outside the production VPN path, on API 29 / 35 / 36 and physical vendor devices; measure which intended UI click/long-click events are actually observable.
2. **Entry reliability:** validate localized text changes, updates, recents/task return, locked screen, denied Accessibility, revoked permission, service death, background-launch restrictions, target uninstall and OEM differences.
3. **Permissions/policy review:** document exactly what data the service could see, why it is necessary, what is not stored, disclosure/consent wording and whether the desired feature can be distributed through Google Play. This is a separate approval gate.
4. **Noninterference:** reuse existing Android ON/OFF acceptance, ensure neutral/sticky UI actions never hit service control methods, and verify live-session continuity. No assumption that an emulator pass proves physical-device behavior.
5. **Recoverability:** users can disable all concealment in one ordinary settings path; ensure a failsafe path always exists if the shortcut or chosen target disappears.
6. **Product decision:** decide after proofs between (A) neutral entry only, (B) narrow opt-in sticky mode, or (C) no Chameleon release. Keep capability claims conditional until verified.

**Exit criteria for this document:** the idea and technical/policy boundaries are recorded for later discussion. No tasks assigned, no UI approved, no code changed, no APK built, no QA pass claimed.

## 6. Primary sources and examples

- [Android Developers — VPN / VpnService](https://developer.android.com/develop/connectivity/vpn): system consent, service lifecycle, foreground/user-visible status, Always-on.
- [Android Developers — VpnService API](https://developer.android.com/reference/android/net/VpnService): service interface and OS control.
- [Android Developers — Accessibility service](https://developer.android.com/guide/topics/ui/accessibility/views/service): user-enabled event observation and event scoping.
- [Android Developers — AccessibilityEvent](https://developer.android.com/reference/android/view/accessibility/AccessibilityEvent): `TYPE_VIEW_CLICKED` / `TYPE_VIEW_LONG_CLICKED`.
- [Android Developers — PackageManager](https://developer.android.com/reference/android/content/pm/PackageManager): owned component enable/disable controls, not package invisibility.
- [Android Developers — background activity launch restrictions](https://developer.android.com/guide/components/activities/secure-bal): Android 10+ foreground-entry restrictions.
- [Android Developers — Android 15 Private Space](https://developer.android.com/about/versions/15/features): locked private profile stops apps.
- [Google Play — AccessibilityService API](https://support.google.com/googleplay/android-developer/answer/10964491?hl=en): disclosure, user consent and allowed automation.
- [Google Play — deceptive behavior](https://support.google.com/googleplay/android-developer/answer/17006354?hl=en): restrictions on misleading, hidden or undocumented app behavior.
- [MacroDroid Wiki — UI Click trigger](https://macrodroidforum.com/wiki/index.php/Trigger%3A_UI_Click): comparative example of user-configured app/text click observation and its limitations.

---

**Decision pending:** no change to Android runtime or codebase until the owner explicitly asks for implementation. This document is a feasibility note, not a promise that an arbitrary third-party app can host Waarp.
