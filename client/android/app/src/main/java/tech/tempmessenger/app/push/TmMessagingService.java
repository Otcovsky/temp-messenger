package tech.tempmessenger.app.push;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import org.json.JSONObject;

/**
 * Пуш от Firebase. Приходит, даже когда приложение закрыто: Android запускает только этот
 * сервис, без WebView. Сообщения здесь не читаются — их заберёт приложение, когда его откроют.
 */
public class TmMessagingService extends FirebaseMessagingService {

    @Override
    public void onMessageReceived(RemoteMessage message) {
        String kind = "msg";
        String sealed = message.getData().get("p");
        if (sealed != null) {
            String plain = TmPushKeys.open(this, sealed);
            if (plain != null) {
                try {
                    kind = new JSONObject(plain).optString("k", "msg");
                } catch (Exception ignored) {
                    // не разобрали — считаем обычным сообщением
                }
            }
        }
        // Приложение на экране: оно и так на связи и всё покажет само (кроме пробного пуша)
        if (TmNotifier.foreground && !TmNotifier.testing()) return;
        TmNotifier.show(this, kind);
    }

    @Override
    public void onNewToken(String token) {
        // Новый токен приложение отправит серверу при следующем подключении (TmPush.register)
    }
}
