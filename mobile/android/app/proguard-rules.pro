# R8 rules for the app module. Capacitor and its plugins ship their own
# consumer rules (every @CapacitorPlugin, every Plugin subclass, the
# Cordova bridge); these cover what is ours.

# The app's classes are small and named in logs and crash reports, so they
# are kept as they are; the size win is in shrinking the libraries.
-keep class com.opendungeonmaster.app.** { *; }

# Readable stack traces from the field.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# The WebView's JavaScript interfaces are looked up by name.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# The scanner plugin's library (com.outsystems.plugins.barcode) annotates its
# models for Gson without depending on it; the annotations are never read at
# runtime, and R8 would otherwise refuse the missing class.
-dontwarn com.google.gson.annotations.SerializedName
