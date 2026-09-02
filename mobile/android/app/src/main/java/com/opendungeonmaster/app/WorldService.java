package com.opendungeonmaster.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;

/**
 * Keeps a shared world alive while the host is elsewhere: Android only lets
 * a process keep running in the background under a foreground service with
 * a visible notification. It runs only while the world is shared (a tunnel
 * is up), which is when other people depend on it; playing alone needs no
 * notification. The service owns nothing itself: the server child process
 * lives in {@link WorldRuntime}, the tunnel in {@link ShareTunnel}. "Stop
 * hosting" on the notification ends the share and leaves the world running
 * for the host; swiping the app away stops everything.
 */
public class WorldService extends Service {

    public static final String ACTION_START = "com.opendungeonmaster.app.world.START";
    public static final String ACTION_STOP = "com.opendungeonmaster.app.world.STOP";
    public static final String EXTRA_TEXT = "text";
    private static final String CHANNEL = "odm-world";
    private static final int NOTIFICATION_ID = 4201;

    /** Starts the service, or refreshes its notification text when already running. */
    public static void start(Context context, String text) {
        Intent intent = new Intent(context, WorldService.class).setAction(ACTION_START).putExtra(EXTRA_TEXT, text);
        context.startForegroundService(intent);
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, WorldService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            ShareTunnel.get(this).stop();
            stopSelf();
            return START_NOT_STICKY;
        }
        ensureChannel();
        String text = intent != null ? intent.getStringExtra(EXTRA_TEXT) : null;
        Notification notification = buildNotification(
            text != null && !text.isEmpty() ? text : "Friends can join while this stays on."
        );
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        return START_NOT_STICKY;
    }

    private void ensureChannel() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL,
            "Hosting a world",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Shown while this device shares your Open Dungeon Master world with friends.");
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification(String text) {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(
            this,
            0,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        Intent stopIntent = new Intent(this, WorldService.class).setAction(ACTION_STOP);
        PendingIntent stop = PendingIntent.getService(
            this,
            1,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_world)
            .setContentTitle("Your world is shared")
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(tap)
            .addAction(0, "Stop hosting", stop)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        ShareTunnel.get(this).stop();
        WorldRuntime.get(this).stop();
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        ShareTunnel.get(this).stop();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
