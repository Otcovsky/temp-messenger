package tech.tempmessenger.app.push;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import tech.tempmessenger.app.MainActivity;
import tech.tempmessenger.app.R;

/**
 * Уведомления приложения. В них нет ни текста сообщения, ни имени: только «Новое сообщение»,
 * «Входящий звонок» или «Пропущенный звонок» — как и в версии для браузера (sw.js).
 */
public final class TmNotifier {

    static final String CH_MESSAGES = "messages";
    static final String CH_CALLS = "calls";
    static final String CH_MISSED = "missed";

    static final int ID_MESSAGE = 1;
    static final int ID_CALL = 2;
    static final int ID_MISSED = 3;

    /** Сколько звонит входящий: дольше вызов всё равно не длится */
    static final long CALL_TIMEOUT_MS = 45_000;

    /** Приложение на экране: тогда оно само покажет, что нужно, и уведомления не нужны */
    static volatile boolean foreground = false;
    /** До этого момента уведомление показывается и при открытом приложении — идёт проверка */
    static volatile long testUntil = 0;

    private TmNotifier() {}

    static void ensureChannels(Context c) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;

        NotificationChannel messages = new NotificationChannel(CH_MESSAGES, "Сообщения", NotificationManager.IMPORTANCE_HIGH);
        messages.setDescription("Новые сообщения");
        nm.createNotificationChannel(messages);

        NotificationChannel calls = new NotificationChannel(CH_CALLS, "Входящие звонки", NotificationManager.IMPORTANCE_HIGH);
        calls.setDescription("Звонок с мелодией, пока не ответите");
        calls.setSound(
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
            new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
        );
        calls.enableVibration(true);
        calls.setVibrationPattern(new long[] { 0, 600, 200, 600, 200, 600, 1200 });
        nm.createNotificationChannel(calls);

        NotificationChannel missed = new NotificationChannel(CH_MISSED, "Пропущенные звонки", NotificationManager.IMPORTANCE_DEFAULT);
        nm.createNotificationChannel(missed);
    }

    static boolean testing() {
        return System.currentTimeMillis() <= testUntil;
    }

    private static PendingIntent openApp(Context c) {
        Intent i = new Intent(c, MainActivity.class)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static NotificationCompat.Builder base(Context c, String channel) {
        return new NotificationCompat.Builder(c, channel)
            .setSmallIcon(R.drawable.ic_stat_tm)
            .setColor(0xFF2F6FED)
            .setContentIntent(openApp(c))
            .setAutoCancel(true)
            // Содержимого в уведомлении нет, так что на экране блокировки его можно показывать целиком
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC);
    }

    /** kind: msg — сообщение, call — звонок, stop — звонок закончился, missed (или end) — пропущенный */
    static void show(Context c, String kind) {
        ensureChannels(c);
        NotificationManagerCompat nm = NotificationManagerCompat.from(c);
        if (!nm.areNotificationsEnabled()) return;
        try {
            switch (kind) {
                case "call": {
                    Notification n = base(c, CH_CALLS)
                        .setContentTitle("Входящий звонок")
                        .setContentText("Нажмите, чтобы ответить")
                        .setCategory(NotificationCompat.CATEGORY_CALL)
                        .setPriority(NotificationCompat.PRIORITY_MAX)
                        .setOnlyAlertOnce(true)
                        .setTimeoutAfter(testing() ? 10_000 : CALL_TIMEOUT_MS)
                        .build();
                    n.flags |= Notification.FLAG_INSISTENT; // мелодия повторяется, пока не ответят
                    nm.notify(ID_CALL, n);
                    break;
                }
                case "stop":
                    nm.cancel(ID_CALL);
                    break;
                case "end":
                case "missed":
                    nm.cancel(ID_CALL);
                    nm.notify(ID_MISSED, base(c, CH_MISSED).setContentTitle("Пропущенный звонок").build());
                    break;
                default:
                    nm.notify(
                        ID_MESSAGE,
                        base(c, CH_MESSAGES)
                            .setContentTitle("Temp Messenger")
                            .setContentText("Новое сообщение")
                            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                            .setPriority(NotificationCompat.PRIORITY_HIGH)
                            .build()
                    );
            }
        } catch (SecurityException e) {
            // Разрешение на уведомления отозвали — показывать нечего
        }
    }

    static void clearAll(Context c) {
        NotificationManagerCompat.from(c).cancelAll();
    }
}
