plugins { id("com.android.test") }

android {
    namespace = "local.waarp.android.acceptance"
    compileSdk = 36
    buildToolsVersion = "35.0.0"
    defaultConfig {
        minSdk = 29
        targetSdk = 36
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    // An independent, self-instrumenting APK drives the actual minified app via
    // accessibility. It never loads the production app's classes or test hooks.
    targetProjectPath = ":app"
    experimentalProperties["android.experimental.self-instrumenting"] = true
    buildTypes {
        maybeCreate("release").apply {
            isDebuggable = true
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    // Share the unmodified, attributed scalar multiplication implementation,
    // not production application/controller classes or a native VPN library.
    sourceSets.getByName("main").java.srcDir("../app/src/main/java/local/waarp/android/core/crypto")
    lint { abortOnError = true }
}

androidComponents.beforeVariants(androidComponents.selector().all()) { variant ->
    variant.enable = variant.buildType == "release"
}

dependencies {
    implementation("androidx.test:runner:1.7.0")
    implementation("androidx.test.ext:junit:1.3.0")
    implementation("androidx.test.uiautomator:uiautomator:2.3.0")
    implementation("junit:junit:4.13.2")
}
