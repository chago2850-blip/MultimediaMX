/*
 * MultimediaMX — biblioteca de medios y servidor local para Android
 * Copyright (C) 2026 Santiago Miguel <chago2850@gmail.com>
 *
 * Este programa es software libre: puede redistribuirlo y/o modificarlo bajo los
 * términos de la Licencia Pública General GNU, versión 3 o (a su elección)
 * cualquier versión posterior. Se distribuye SIN NINGUNA GARANTÍA.
 */
package mx.multimediamx.player;

import android.Manifest;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(
    name = "MediaLibrary",
    permissions = {
        @Permission(alias = "audio", strings = { "android.permission.READ_MEDIA_AUDIO" }),
        @Permission(alias = "video", strings = { "android.permission.READ_MEDIA_VIDEO" }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE })
    }
)
public class MediaLibraryPlugin extends Plugin {

    private ServerSocket server;
    private String token;
    private final ExecutorService pool = Executors.newCachedThreadPool();

    // ------------------------------------------------------------------ permisos
    private String[] aliases() {
        return Build.VERSION.SDK_INT >= 33 ? new String[] { "audio", "video" } : new String[] { "storage" };
    }

    private JSObject permissionStatus() {
        JSObject r = new JSObject();
        if (Build.VERSION.SDK_INT >= 33) {
            r.put("audio", getPermissionState("audio").toString());
            r.put("video", getPermissionState("video").toString());
        } else {
            String s = getPermissionState("storage").toString();
            r.put("audio", s);
            r.put("video", s);
        }
        return r;
    }

    @PluginMethod
    public void requestAccess(PluginCall call) {
        boolean all = true;
        for (String a : aliases()) if (getPermissionState(a) != PermissionState.GRANTED) all = false;
        if (all) { call.resolve(permissionStatus()); return; }
        requestPermissionForAliases(aliases(), call, "accessCallback");
    }

    @PermissionCallback
    private void accessCallback(PluginCall call) {
        call.resolve(permissionStatus());
    }

    // ------------------------------------------------------------------ biblioteca
    @PluginMethod
    public void scan(PluginCall call) {
        pool.execute(() -> {
            JSArray items = new JSArray();
            try {
                query(items, MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, false);
                query(items, MediaStore.Video.Media.EXTERNAL_CONTENT_URI, true);
                JSObject ret = new JSObject();
                ret.put("items", items);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("No se pudo leer la biblioteca: " + e.getMessage());
            }
        });
    }

    @SuppressWarnings("deprecation")
    private void query(JSArray out, Uri uri, boolean video) {
        String[] projection = video
            ? new String[] { MediaStore.MediaColumns.DATA, MediaStore.MediaColumns.TITLE, MediaStore.Video.VideoColumns.DURATION, MediaStore.MediaColumns.MIME_TYPE }
            : new String[] { MediaStore.MediaColumns.DATA, MediaStore.MediaColumns.TITLE, MediaStore.Audio.AudioColumns.ARTIST, MediaStore.Audio.AudioColumns.ALBUM, MediaStore.Audio.AudioColumns.DURATION, MediaStore.MediaColumns.MIME_TYPE };
        String selection = video ? null : MediaStore.Audio.AudioColumns.IS_MUSIC + " != 0";
        try (Cursor c = getContext().getContentResolver().query(uri, projection, selection, null, MediaStore.MediaColumns.DATE_ADDED + " DESC")) {
            if (c == null) return;
            while (c.moveToNext()) {
                String path = c.getString(0);
                if (path == null || !new File(path).exists()) continue;
                JSObject o = new JSObject();
                o.put("path", path);
                o.put("title", c.getString(1));
                if (video) {
                    o.put("duration", c.getLong(2));
                    o.put("mime", c.getString(3));
                } else {
                    o.put("artist", c.getString(2));
                    o.put("album", c.getString(3));
                    o.put("duration", c.getLong(4));
                    o.put("mime", c.getString(5));
                }
                o.put("isVideo", video);
                out.put(o);
            }
        }
    }

    // ------------------------------------------------------------------ servidor local con soporte de Range
    @PluginMethod
    public void server(PluginCall call) {
        try {
            ensureServer();
            JSObject r = new JSObject();
            r.put("port", server.getLocalPort());
            r.put("token", token);
            call.resolve(r);
        } catch (IOException e) {
            call.reject("No se pudo iniciar el servidor local: " + e.getMessage());
        }
    }

    private synchronized void ensureServer() throws IOException {
        if (server != null && !server.isClosed()) return;
        byte[] b = new byte[16];
        new SecureRandom().nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x));
        token = sb.toString();
        server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        Thread t = new Thread(() -> {
            while (!server.isClosed()) {
                try {
                    Socket s = server.accept();
                    pool.execute(() -> handle(s));
                } catch (IOException ignored) {
                    // servidor cerrado
                }
            }
        }, "mmx-media-server");
        t.setDaemon(true);
        t.start();
    }

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("mp3", "audio/mpeg"); MIME.put("flac", "audio/flac"); MIME.put("ogg", "audio/ogg"); MIME.put("oga", "audio/ogg");
        MIME.put("opus", "audio/ogg"); MIME.put("m4a", "audio/mp4"); MIME.put("aac", "audio/aac"); MIME.put("wav", "audio/wav");
        MIME.put("amr", "audio/amr"); MIME.put("mid", "audio/midi"); MIME.put("mp4", "video/mp4"); MIME.put("m4v", "video/mp4");
        MIME.put("mkv", "video/x-matroska"); MIME.put("webm", "video/webm"); MIME.put("3gp", "video/3gpp"); MIME.put("mov", "video/mp4");
        MIME.put("ts", "video/mp2t"); MIME.put("lrc", "text/plain; charset=utf-8"); MIME.put("srt", "text/plain; charset=utf-8");
        MIME.put("vtt", "text/vtt; charset=utf-8"); MIME.put("m3u", "audio/x-mpegurl"); MIME.put("m3u8", "audio/x-mpegurl");
    }

    private void handle(Socket socket) {
        try (Socket s = socket) {
            s.setSoTimeout(20000);
            BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.ISO_8859_1));
            String line = in.readLine();
            if (line == null) return;
            String[] parts = line.split(" ");
            if (parts.length < 2) return;
            String method = parts[0];
            String target = parts[1];
            String range = null;
            String h;
            while ((h = in.readLine()) != null && !h.isEmpty()) {
                int i = h.indexOf(':');
                if (i > 0 && h.substring(0, i).trim().equalsIgnoreCase("range")) range = h.substring(i + 1).trim();
            }
            OutputStream out = s.getOutputStream();
            if (method.equals("OPTIONS")) { head(out, 204, "No Content", null, -1, null); return; }

            Map<String, String> q = new HashMap<>();
            int qi = target.indexOf('?');
            if (qi >= 0) {
                for (String kv : target.substring(qi + 1).split("&")) {
                    int e = kv.indexOf('=');
                    if (e > 0) q.put(kv.substring(0, e), URLDecoder.decode(kv.substring(e + 1), "UTF-8"));
                }
            }
            if (!token.equals(q.get("k")) || q.get("p") == null) { head(out, 403, "Forbidden", null, 0, null); return; }
            File f = new File(q.get("p"));
            if (!f.isFile() || !f.canRead()) { head(out, 404, "Not Found", null, 0, null); return; }

            String name = f.getName();
            String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
            String type = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";
            long size = f.length();
            long start = 0, end = size - 1;
            boolean partial = false;
            if (range != null && range.startsWith("bytes=")) {
                String[] r = range.substring(6).split(",")[0].split("-", -1);
                try {
                    if (r[0].isEmpty()) { start = Math.max(0, size - Long.parseLong(r[1])); }
                    else { start = Long.parseLong(r[0]); if (r.length > 1 && !r[1].isEmpty()) end = Math.min(Long.parseLong(r[1]), size - 1); }
                    partial = true;
                } catch (NumberFormatException ignored) { start = 0; end = size - 1; }
                if (start >= size) { head(out, 416, "Range Not Satisfiable", type, 0, "bytes */" + size); return; }
            }
            long len = end - start + 1;
            head(out, partial ? 206 : 200, partial ? "Partial Content" : "OK", type, len, partial ? "bytes " + start + "-" + end + "/" + size : null);
            if (method.equals("HEAD")) return;
            try (RandomAccessFile raf = new RandomAccessFile(f, "r")) {
                raf.seek(start);
                byte[] buf = new byte[64 * 1024];
                long left = len;
                while (left > 0) {
                    int n = raf.read(buf, 0, (int) Math.min(buf.length, left));
                    if (n < 0) break;
                    out.write(buf, 0, n);
                    left -= n;
                }
                out.flush();
            }
        } catch (IOException ignored) {
            // el reproductor cerró la conexión (búsqueda o cambio de pista)
        }
    }

    private static void head(OutputStream out, int code, String reason, String type, long len, String contentRange) throws IOException {
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP/1.1 ").append(code).append(' ').append(reason).append("\r\n");
        sb.append("Access-Control-Allow-Origin: *\r\n");
        sb.append("Access-Control-Allow-Headers: Range\r\n");
        sb.append("Accept-Ranges: bytes\r\n");
        sb.append("Cache-Control: no-store\r\n");
        sb.append("Connection: close\r\n");
        if (type != null) sb.append("Content-Type: ").append(type).append("\r\n");
        if (len >= 0) sb.append("Content-Length: ").append(len).append("\r\n");
        if (contentRange != null) sb.append("Content-Range: ").append(contentRange).append("\r\n");
        sb.append("\r\n");
        out.write(sb.toString().getBytes(StandardCharsets.ISO_8859_1));
    }

    @Override
    protected void handleOnDestroy() {
        try { if (server != null) server.close(); } catch (IOException ignored) { }
        pool.shutdownNow();
        super.handleOnDestroy();
    }
}
