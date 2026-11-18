package tech.tempmessenger.app.push;

import android.Manifest;
import android.os.Build;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

/** Мост к JS (client/src/native.ts): разрешение, токен FCM, локальные уведомления. */
@CapacitorPlugin(
    name = "TmPush",
    permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = TmPushPlugin.NOTIFICATIONS) }
)
public class TmPushPlugin extends Plugin {

    static final String NOTIFICATIONS = "notifications";
    private static final long TEST_WINDOW_MS = 20_000;

    @Override
    public void load() {
        TmNotifier.ensureChannels(getContext());
    }

    @Override
    protected void handleOnResume() {
        TmNotifier.foreground = true;
        TmNotifier.clearAll(getContext()); // человек открыл приложение — уведомления больше не нужны
    }

    @Override
    protected void handleOnPause() {
        TmNotifier.foreground = false;
    }

    private boolean firebaseReady() {
        return !FirebaseApp.getApps(getContext()).isEmpty();
    }

    /** granted | denied | prompt */
    private String permission() {
        boolean enabled = NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return enabled ? "granted" : "denied";
        PermissionState s = getPermissionState(NOTIFICATIONS);
        if (s == PermissionState.GRANTED) return enabled ? "granted" : "denied";
        if (s == PermissionState.DENIED) return "denied";
        return "prompt";
    }

    private JSObject status() {
        JSObject r = new JSObject();
        r.put("available", firebaseReady());
        r.put("permission", permission());
        return r;
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(status());
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState(NOTIFICATIONS) == PermissionState.GRANTED) {
            call.resolve(status());
            return;
        }
        requestPermissionForAlias(NOTIFICATIONS, call, "permissionAnswered");
    }

    @PermissionCallback
    private void permissionAnswered(PluginCall call) {
        call.resolve(status());
    }

    /** Токен FCM и ключ шифрования пометки — их приложение отправляет серверу в push-sub */
    @PluginMethod
    public void register(PluginCall call) {
        if (!firebaseReady()) {
            call.reject("Firebase не настроен в этой сборке");
            return;
        }
        // Токен заводится только после того, как человек включил уведомления (в манифесте автозапуск выключен)
        FirebaseMessaging.getInstance().setAutoInitEnabled(true);
        FirebaseMessaging.getInstance()
            .getToken()
            .addOnCompleteListener(task -> {
                if (!task.isSuccessful() || task.getResult() == null) {
                    Exception e = task.getException();
                    call.reject(e != null && e.getMessage() != null ? e.getMessage() : "нет токена");
                    return;
                }
                JSObject r = new JSObject();
                r.put("token", task.getResult());
                r.put("key", TmPushKeys.key(getContext()));
                call.resolve(r);
            });
    }

    /** Отказаться от токена: Google перестанет доставлять на него пуши */
    @PluginMethod
    public void unregister(PluginCall call) {
        TmNotifier.clearAll(getContext());
        if (!firebaseReady()) {
            call.resolve();
            return;
        }
        FirebaseMessaging.getInstance().setAutoInitEnabled(false);
        FirebaseMessaging.getInstance().deleteToken().addOnCompleteListener(task -> call.resolve());
    }

    /**
     * Уведомление от самого приложения: оно свёрнуто, но ещё на связи и забрало сообщение,
     * так что сервер пуш не пошлёт. Пока приложение на экране, ничего не показывается.
     * kind: msg | call | stop | missed
     */
    @PluginMethod
    public void show(PluginCall call) {
        String kind = call.getString("kind", "msg");
        if ("stop".equals(kind) || !TmNotifier.foreground) TmNotifier.show(getContext(), kind);
        call.resolve();
    }

    /** Следующие 20 секунд пуш покажется и при открытом приложении — для кнопки «Проверить» */
    @PluginMethod
    public void expectTest(PluginCall call) {
        TmNotifier.testUntil = System.currentTimeMillis() + TEST_WINDOW_MS;
        call.resolve();
    }
}
