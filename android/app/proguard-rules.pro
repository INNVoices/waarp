# gomobile uses generated JNI bindings and name-based reflection.
# Keep the bridge exactly as required by the pinned AAR's consumer rules.
-keep class go.** { *; }
-keep class io.nekohasekai.** { *; }
-keepclasseswithmembernames class * { native <methods>; }
-keepattributes Signature,InnerClasses,EnclosingMethod
