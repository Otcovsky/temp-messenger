package tech.tempmessenger.app.push;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Ключ, которым сервер шифрует пометку в пуше («сообщение» / «звонок»), чтобы её не видел Google.
 * Создаётся на устройстве один раз и уходит на сервер вместе с токеном FCM (см. server/app/fcm.py).
 * Хранится в настройках приложения, которые не попадают в резервные копии (allowBackup=false).
 */
final class TmPushKeys {

    private static final String PREFS = "tm_push";
    private static final String KEY = "key";
    private static final int B64 = Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP;

    private TmPushKeys() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Ключ в base64url; создаётся при первом обращении */
    static synchronized String key(Context c) {
        String k = prefs(c).getString(KEY, null);
        if (k == null) {
            byte[] raw = new byte[32];
            new SecureRandom().nextBytes(raw);
            k = Base64.encodeToString(raw, B64);
            prefs(c).edit().putString(KEY, k).apply();
        }
        return k;
    }

    /** Расшифровать пометку: base64url(nonce 12 байт ‖ шифротекст). null — не вышло. */
    static String open(Context c, String sealed) {
        try {
            byte[] raw = Base64.decode(sealed, B64);
            byte[] k = Base64.decode(key(c), B64);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(k, "AES"), new GCMParameterSpec(128, raw, 0, 12));
            byte[] plain = cipher.doFinal(raw, 12, raw.length - 12);
            return new String(plain, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }
}
