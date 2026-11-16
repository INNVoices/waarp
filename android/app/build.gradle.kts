import groovy.json.JsonSlurper
import groovy.json.JsonOutput
import java.security.MessageDigest
import org.gradle.api.artifacts.component.ModuleComponentIdentifier
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val enginePinFile = layout.projectDirectory.file("src/main/res/raw/engine_integrity.json").asFile
val enginePin = JsonSlurper().parse(enginePinFile) as Map<*, *>
val coreAar = layout.projectDirectory.file("libs/libbox.aar").asFile
val packagedAbis = (enginePin["packagedAbis"] as List<*>).map { it.toString() }
check(packagedAbis.toSet() == setOf("arm64-v8a", "armeabi-v7a", "x86_64")) {
    "Update both the explicit APK ABI splits and the native integrity pin together."
}
val signingNames = listOf("WAARP_ANDROID_KEYSTORE", "WAARP_ANDROID_STORE_PASSWORD", "WAARP_ANDROID_KEY_ALIAS", "WAARP_ANDROID_KEY_PASSWORD")
val signingValues = signingNames.map { providers.environmentVariable(it).orNull?.takeIf(String::isNotBlank) }
check(signingValues.all { it == null } || signingValues.all { !it.isNullOrBlank() }) {
    "Configure all four WAARP_ANDROID signing environment variables, or none."
}

android {
    namespace = "local.waarp.android"
    compileSdk = 36
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "local.waarp.android"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.5.0-alpha.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        testInstrumentationRunnerArguments["clearPackageData"] = "true"
        buildConfigField("String", "ENGINE_VERSION", "\"${enginePin["version"]}\"")
        buildConfigField("String", "ENGINE_SHA256", "\"${enginePin["sha256"]}\"")
    }

    signingConfigs {
        if (signingValues.all { it != null }) {
            create("externalRelease") {
                storeFile = file(signingValues[0]!!)
                storePassword = signingValues[1]
                keyAlias = signingValues[2]
                keyPassword = signingValues[3]
                enableV1Signing = false
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (signingValues.all { it != null }) signingConfig = signingConfigs.getByName("externalRelease")
        }
    }

    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64")
            isUniversalApk = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        jniLibs {
            useLegacyPackaging = false
            // The release AAR is already stripped. Preserve its audited ELF bytes.
            keepDebugSymbols += "**/libbox.so"
        }
        resources.excludes += setOf("META-INF/AL2.0", "META-INF/LGPL2.1")
    }
    testOptions {
        animationsDisabled = true
        unitTests.isReturnDefaultValues = false
    }
    lint {
        abortOnError = true
        checkReleaseBuilds = true
    }
}

kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_17) } }

val verifyCoreAar by tasks.registering {
    group = "verification"
    description = "Require the audited Android engine AAR before any build."
    inputs.file(enginePinFile)
    inputs.file(coreAar)
    doLast {
        check(coreAar.isFile) { "Missing libbox.aar; run node scripts/android-core.mjs fetch from the repository root." }
        check(coreAar.length() == (enginePin["bytes"] as Number).toLong()) { "Engine AAR size does not match the pin." }
        val digest = MessageDigest.getInstance("SHA-256")
        coreAar.inputStream().use { stream ->
            val buffer = ByteArray(1024 * 1024)
            while (true) {
                val size = stream.read(buffer)
                if (size < 0) break
                digest.update(buffer, 0, size)
            }
        }
        val sha = digest.digest().joinToString("") { "%02x".format(it) }
        check(sha == enginePin["sha256"]) { "Engine AAR SHA-256 does not match the pin." }
    }
}
tasks.named("preBuild").configure { dependsOn(verifyCoreAar) }

val generatedLegalAssets = layout.buildDirectory.dir("generated/waarpLegalAssets")
val releaseComponents = providers.provider {
    configurations.getByName("releaseRuntimeClasspath").incoming.resolutionResult.allComponents
        .mapNotNull { (it.id as? ModuleComponentIdentifier)?.let { id -> "${id.group}:${id.module}:${id.version}" } }
        .sorted()
}
val generateRuntimeDependencyNotice by tasks.registering {
    group = "verification"
    description = "Package the exact resolved Maven runtime component inventory."
    inputs.property("components", releaseComponents)
    outputs.dir(generatedLegalAssets)
    doLast {
        val destination = generatedLegalAssets.get().file("licenses/Maven-runtime-components.json").asFile
        destination.parentFile.mkdirs()
        destination.writeText(JsonOutput.prettyPrint(JsonOutput.toJson(mapOf(
            "schemaVersion" to 1,
            "configuration" to "releaseRuntimeClasspath",
            "scope" to "Resolved Maven components, including dependency platforms. Native engine inventory is in Libbox-buildinfo.txt.",
            "components" to releaseComponents.get()
        ))) + "\n")
    }
}
android.sourceSets.getByName("main").assets.srcDir(generatedLegalAssets)
tasks.matching { it.name == "mergeDebugAssets" || it.name == "mergeReleaseAssets" }.configureEach {
    dependsOn(generateRuntimeDependencyNotice)
}

dependencies {
    implementation(files(coreAar))
    implementation(platform("androidx.compose:compose-bom:2025.11.01"))
    androidTestImplementation(platform("androidx.compose:compose-bom:2025.11.01"))
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("com.google.zxing:core:3.5.3")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:rules:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
}
