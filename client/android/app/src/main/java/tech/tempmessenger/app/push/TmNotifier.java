package tech.tempmessenger.app.push;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.util.Locale;
import tech.tempmessenger.app.MainActivity;
import tech.tempmessenger.app.R;

/**
 * Уведомления приложения. В них нет ни текста сообщения, ни имени: только «Новое сообщение»,
 * «Входящий звонок» или «Пропущенный звонок» — как и в версии для браузера (sw.js).
 * Тексты — из res/values*: на языке, выбранном в приложении (TmPush.setLanguage), иначе на языке телефона.
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

    private static final String PREFS = "tm";
    private static final String PREF_LANG = "lang";

    private TmNotifier() {}

    /** Запомнить язык приложения: уведомления по пушу показываются, когда страницы ещё нет */
    static void setLanguage(Context c, String lang) {
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(PREF_LANG, lang).apply();
        ensureChannels(c); // названия каналов в настройках телефона — тоже на новом языке
    }

    /** Контекст с языком, выбранным в приложении; не выбран — как есть (язык телефона) */
    static Context localized(Context c) {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String lang = p.getString(PREF_LANG, null);
        if (lang == null || lang.isEmpty()) return c;
        Configuration conf = new Configuration(c.getResources().getConfiguration());
        conf.setLocale(Locale.forLanguageTag(lang));
        return c.createConfigurationContext(conf);
    }

    static void ensureChannels(Context c) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null) return;
        Context l = localized(c);

        // Повторное создание канала лишь обновляет его название и описание — настройки человека не трогаются
        NotificationChannel messages = new NotificationChannel(CH_MESSAGES, l.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH);
        messages.setDescription(l.getString(R.string.channel_messages_desc));
        nm.createNotificationChannel(messages);

        NotificationChannel calls = new NotificationChannel(CH_CALLS, l.getString(R.string.channel_calls), NotificationManager.IMPORTANCE_HIGH);
        calls.setDescription(l.getString(R.string.channel_calls_desc));
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

        NotificationChannel missed = new NotificationChannel(CH_MISSED, l.getString(R.string.channel_missed), NotificationManager.IMPORTANCE_DEFAULT);
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
        Context l = localized(c);
        try {
            switch (kind) {
                case "call": {
                    Notification n = base(c, CH_CALLS)
                        .setContentTitle(l.getString(R.string.notify_call))
                        .setContentText(l.getString(R.string.notify_call_body))
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
                    nm.notify(ID_MISSED, base(c, CH_MISSED).setContentTitle(l.getString(R.string.notify_missed)).build());
                    break;
                default:
                    nm.notify(
                        ID_MESSAGE,
                        base(c, CH_MESSAGES)
                            .setContentTitle("Temp Messenger")
                            .setContentText(l.getString(R.string.notify_message))
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
