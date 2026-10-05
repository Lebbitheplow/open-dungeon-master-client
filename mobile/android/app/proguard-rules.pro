# R8 rules for the app module. Capacitor ships consumer rules for the
# plugins (every @CapacitorPlugin, every Plugin subclass, the Cordova
# bridge); these cover what is ours, and what those rules leave out.

# The app's classes are small and named in logs and crash reports, so they
# are kept as they are; the size win is in shrinking the libraries.
-keep class com.opendungeonmaster.app.** { *; }

# Capacitor's rules keep the plugins but not the bridge that runs them, and
# the bridge reads each plugin's @CapacitorPlugin by reflection and holds it
# in a field (PluginHandle). No class in the app implements an annotation, so
# R8 decided that field could only ever be null, dropped it, and compiled
# every permission call in Plugin (checkPermissions, requestPermissions and
# the four beside them) into "throw null". Asking for notifications, the
# camera, the microphone or Bluetooth closed the app, and signing in to a
# server asks for notifications. The bridge and its annotations stay whole.
-keep class com.getcapacitor.** { *; }

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
