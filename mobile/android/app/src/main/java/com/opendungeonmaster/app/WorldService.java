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
 * Keeps the phone-hosted world alive while the player is elsewhere: Android
 * only lets a process keep running in the background under a foreground
 * service with a visible notification. The service owns nothing itself; the
 * server child process lives in {@link WorldRuntime}. Swiping the app away
 * stops the world, which is what a host who quits expects.
 */
public class WorldService extends Service {

    public static final String ACTION_START = "com.opendungeonmaster.app.world.START";
    public static final String ACTION_STOP = "com.opendungeonmaster.app.world.STOP";
    private static final String CHANNEL = "odm-world";
    private static final int NOTIFICATION_ID = 4201;

    public static void start(Context context) {
        Intent intent = new Intent(context, WorldService.class).setAction(ACTION_START);
        context.startForegroundService(intent);
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, WorldService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            WorldRuntime.get(this).stop();
            stopSelf();
            return START_NOT_STICKY;
        }
        ensureChannel();
        Notification notification = buildNotification();
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
        channel.setDescription("Shown while this phone runs your Open Dungeon Master world.");
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
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
            .setContentTitle("Your world is running")
            .setContentText("Friends on your Wi-Fi can join while this stays on.")
            .setContentIntent(tap)
            .addAction(0, "Stop hosting", stop)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        WorldRuntime.get(this).stop();
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        WorldRuntime.get(this).stop();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
