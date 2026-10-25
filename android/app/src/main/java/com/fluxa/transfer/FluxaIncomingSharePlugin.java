package com.fluxa.transfer;

import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Explicit ACTION_SEND / ACTION_SEND_MULTIPLE target. This is an app-private,
 * bounded LOCAL inbox, not a background sender: no remote bytes move until the
 * user reviews an item and chooses a presently verified peer in the WebView.
 *
 * Content URI grants from other apps are temporary. Copy with a 64 KiB buffer
 * before leaving the share Activity; never persist foreign URIs, expose file
 * paths to JS, or load a shared file as a single base64 message. A failed or
 * interrupted import is not published. Recipients must still approve content.
 */
@CapacitorPlugin(name = "FluxaIncomingShare")
public class FluxaIncomingSharePlugin extends Plugin {
    private static final int CHUNK = 64 * 1024;
    private static final int MAX_FILES = 32;
    private static final int MAX_ITEMS = 20;
    private static final long MAX_FILE_BYTES = 512L * 1024 * 1024;
    private static final long MAX_INBOX_BYTES = 1024L * 1024 * 1024;
    private static final int MAX_TEXT_BYTES = 16 * 1024;
    private static final String ID_PATTERN = "[0-9a-f]{32}";
    private final ExecutorService imports = Executors.newSingleThreadExecutor();
    private final ExecutorService reads = Executors.newFixedThreadPool(2);

    @Override
    protected void handleOnDestroy() {
        imports.shutdownNow();
        reads.shutdownNow();
    }

    private File root() throws IOException {
        File root = new File(getContext().getFilesDir(), "fluxa-share-inbox");
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("Could not create private share inbox");
        return root;
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        if (intent == null || (!Intent.ACTION_SEND.equals(intent.getAction()) &&
                !Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction()))) return;
        // Avoid a duplicate import on Activity recreation. MainActivity also
        // replaces the launch Intent after forwarding it to Capacitor.
        imports.execute(() -> {
            try {
                importShare(intent);
                notifyListeners("shareReceived", new JSObject());
            } catch (Exception ex) {
                String message = ex.getMessage() == null ? "Could not import this Android share" : ex.getMessage();
                getContext().getSharedPreferences("fluxa-share", 0).edit().putString("lastError", message).apply();
                notifyListeners("shareReceived", new JSObject());
            }
        });
    }

    static String safeName(String input, int index) {
        String name = input == null ? "" : input.replace('\\', '/');
        name = name.substring(name.lastIndexOf('/') + 1).replaceAll("[\\p{Cntrl}]", " ").trim();
        if (name.equals(".") || name.equals("..") || name.length() == 0) name = "shared-file-" + (index + 1);
        return name.length() > 180 ? name.substring(0, 180) : name;
    }

    private static void deleteTree(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteTree(child);
        }
        file.delete();
    }

    private static void addUri(LinkedHashSet<Uri> uris, Uri uri) throws IOException {
        if (uri == null) return;
        if (!"content".equals(uri.getScheme())) throw new IOException("Only Android content-provider files can be shared");
        uris.add(uri);
        if (uris.size() > MAX_FILES) throw new IOException("Share at most 32 files at a time");
    }

    private static List<Uri> incomingUris(Intent intent) throws IOException {
        LinkedHashSet<Uri> unique = new LinkedHashSet<>();
        try {
            if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
                ArrayList<Uri> streams = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (streams != null) for (Uri uri : streams) addUri(unique, uri);
            } else {
                Uri stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                addUri(unique, stream);
            }
            ClipData clip = intent.getClipData();
            if (clip != null) {
                boolean hasText = !textExtra(intent, Intent.EXTRA_TEXT).isEmpty();
                if (clip.getItemCount() > MAX_FILES) throw new IOException("Share at most 32 files at a time");
                for (int i = 0; i < clip.getItemCount(); i++) {
                    Uri uri = clip.getItemAt(i).getUri();
                    if (uri == null) continue;
                    // Some URL/text shares include an http(s) ClipData URI for
                    // paste previews. It is not a file. Accept the EXTRA_TEXT
                    // rather than rejecting Chrome's Share → Fluxa action.
                    if (("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) &&
                        hasText) continue;
                    addUri(unique, uri);
                }
            }
        } catch (ClassCastException ex) {
            throw new IOException("The shared files could not be read", ex);
        }
        return new ArrayList<>(unique);
    }

    private String displayName(Uri uri, int index) {
        String result = null;
        try (Cursor cursor = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) result = cursor.getString(0);
        } catch (RuntimeException ignored) { /* fallback to a safe generic name */ }
        return safeName(result, index);
    }

    private static String textExtra(Intent intent, String key) {
        CharSequence value = intent.getCharSequenceExtra(key);
        return value == null ? "" : value.toString();
    }

    private long usedBytes(File base) {
        long size = 0;
        File[] folders = base.listFiles();
        if (folders == null) return 0;
        for (File folder : folders) {
            String name = folder.getName();
            if (!name.matches(ID_PATTERN) && !name.matches("\\.pending-" + ID_PATTERN)) continue;
            // A killed process might leave an unpublished partial import. Only
            // remove abandoned work, never an import active in another Activity.
            if (name.startsWith(".pending-") &&
                System.currentTimeMillis() - folder.lastModified() > 24L * 60 * 60 * 1000) {
                deleteTree(folder);
                continue;
            }
            File[] files = folder.listFiles();
            if (files != null) for (File file : files) if (file.isFile()) size += file.length();
        }
        return size;
    }

    private void importShare(Intent intent) throws Exception {
        File base = root();
        File[] items = base.listFiles((parent, name) -> name.matches(ID_PATTERN));
        long used = usedBytes(base);
        if (used >= MAX_INBOX_BYTES) throw new IOException("Fluxa's local share inbox is full (1 GiB). Review or discard older items first");
        String text = textExtra(intent, Intent.EXTRA_TEXT);
        String title = textExtra(intent, Intent.EXTRA_SUBJECT);
        if (text.getBytes(StandardCharsets.UTF_8).length > MAX_TEXT_BYTES) {
            throw new IOException("Shared text exceeds 16 KiB; select a smaller excerpt");
        }
        List<Uri> uris = incomingUris(intent);
        if (text.isEmpty() && uris.isEmpty()) throw new IOException("That app did not provide text or a file to share");
        // Mixed intents become two independent review cards. If a file transfer
        // succeeds but the text share is declined, retrying never resends files.
        boolean mixed = !text.isEmpty() && !uris.isEmpty();
        if (items != null && items.length + (mixed ? 2 : 1) > MAX_ITEMS) {
            throw new IOException("Fluxa's local share inbox is full (20 items). Review or discard older items first");
        }

        String id = UUID.randomUUID().toString().replace("-", "");
        File staging = new File(base, ".pending-" + id);
        File target = new File(base, id);
        if (!staging.mkdir()) throw new IOException("Could not stage Android share");
        try {
            JSONArray files = new JSONArray();
            long total = used;
            for (int i = 0; i < uris.size(); i++) {
                Uri uri = uris.get(i);
                String name = displayName(uri, i);
                String type = getContext().getContentResolver().getType(uri);
                if (type == null || type.length() > 128 || !type.matches("[A-Za-z0-9.+_-]+/[A-Za-z0-9.+_-]+")) type = "application/octet-stream";
                File output = new File(staging, Integer.toString(i));
                long length = 0;
                byte[] buffer = new byte[CHUNK];
                try (InputStream input = getContext().getContentResolver().openInputStream(uri);
                     OutputStream out = new FileOutputStream(output)) {
                    if (input == null) throw new IOException("The other app did not grant access to " + name);
                    int n;
                    while ((n = input.read(buffer)) != -1) {
                        length += n;
                        total += n;
                        if (length > MAX_FILE_BYTES || total > MAX_INBOX_BYTES ||
                            getContext().getFilesDir().getUsableSpace() < CHUNK * 4L) {
                            throw new IOException("Shared files exceed Fluxa's 512 MiB per-file / 1 GiB inbox limit or available storage");
                        }
                        out.write(buffer, 0, n);
                    }
                }
                JSONObject file = new JSONObject();
                file.put("index", i);
                file.put("name", name);
                file.put("mime", type);
                file.put("size", length);
                files.put(file);
            }
            JSONObject item = new JSONObject();
            item.put("id", id);
            item.put("createdAt", System.currentTimeMillis());
            item.put("text", mixed ? "" : text);
            item.put("title", title.length() > 160 ? title.substring(0, 160) : title);
            item.put("files", files);
            writeMetadata(staging, item);
            if (mixed) {
                String textId = UUID.randomUUID().toString().replace("-", "");
                File textStaging = new File(base, ".pending-" + textId);
                if (!textStaging.mkdir()) throw new IOException("Could not stage the shared text");
                try {
                    JSONObject textItem = new JSONObject();
                    textItem.put("id", textId);
                    textItem.put("createdAt", System.currentTimeMillis());
                    textItem.put("text", text);
                    textItem.put("title", title.length() > 160 ? title.substring(0, 160) : title);
                    textItem.put("files", new JSONArray());
                    writeMetadata(textStaging, textItem);
                    if (!staging.renameTo(target)) throw new IOException("Could not save the local files");
                    if (!textStaging.renameTo(new File(base, textId))) {
                        // Do not publish half of an intended file+text share.
                        deleteTree(target);
                        throw new IOException("Could not save the local text share");
                    }
                } finally {
                    if (textStaging.exists()) deleteTree(textStaging);
                }
            } else if (!staging.renameTo(target)) throw new IOException("Could not save the local share");
        } finally {
            if (staging.exists()) deleteTree(staging);
        }
    }

    private static void writeMetadata(File folder, JSONObject item) throws IOException {
        try (OutputStream out = new FileOutputStream(new File(folder, "item.json"))) {
            out.write(item.toString().getBytes(StandardCharsets.UTF_8));
            out.flush();
        }
    }

    @PluginMethod
    public void list(PluginCall call) {
        reads.execute(() -> {
            try {
                JSONArray result = new JSONArray();
                File[] folders = root().listFiles((parent, name) -> name.matches(ID_PATTERN));
                if (folders != null) {
                    List<File> sorted = new ArrayList<>();
                    Collections.addAll(sorted, folders);
                    sorted.sort(Comparator.comparing(File::getName));
                    for (File folder : sorted) {
                        File metadata = new File(folder, "item.json");
                        if (!metadata.isFile() || metadata.length() > MAX_TEXT_BYTES + 8192) continue;
                        try (InputStream in = new FileInputStream(metadata)) {
                            byte[] bytes = new byte[(int) metadata.length()];
                            int at = 0;
                            while (at < bytes.length) {
                                int n = in.read(bytes, at, bytes.length - at);
                                if (n < 0) break;
                                at += n;
                            }
                            if (at == bytes.length) result.put(new JSONObject(new String(bytes, StandardCharsets.UTF_8)));
                        }
                    }
                }
                String error = getContext().getSharedPreferences("fluxa-share", 0).getString("lastError", "");
                getContext().getSharedPreferences("fluxa-share", 0).edit().remove("lastError").apply();
                JSObject response = new JSObject();
                response.put("items", result);
                response.put("error", error);
                call.resolve(response);
            } catch (Exception ex) {
                call.reject("Could not list Android shares: " + ex.getMessage());
            }
        });
    }

    @PluginMethod
    public void readChunk(PluginCall call) {
        reads.execute(() -> {
            String id = call.getString("id", "");
            Integer index = call.getInt("index");
            // JSON numbers below 2^31 are Integer in Capacitor's bridge,
            // including offsets into the bounded 512 MiB staging file.
            Integer offset = call.getInt("offset");
            Integer length = call.getInt("length");
            if (id == null || !id.matches(ID_PATTERN) || index == null || index < 0 || index >= MAX_FILES ||
                offset == null || offset < 0 || length == null || length < 1 || length > CHUNK) {
                call.reject("Invalid shared-file read range");
                return;
            }
            try {
                File file = new File(new File(root(), id), Integer.toString(index));
                if (!file.isFile() || offset > file.length() || length > file.length() - offset) {
                    call.reject("Shared file is missing or its length changed; share it again");
                    return;
                }
                byte[] bytes = new byte[length];
                try (RandomAccessFile input = new RandomAccessFile(file, "r")) {
                    input.seek(offset);
                    input.readFully(bytes);
                }
                JSObject response = new JSObject();
                response.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                call.resolve(response);
            } catch (Exception ex) {
                call.reject("Could not read shared file: " + ex.getMessage());
            }
        });
    }

    @PluginMethod
    public void discard(PluginCall call) {
        reads.execute(() -> {
            String id = call.getString("id", "");
            if (id == null || !id.matches(ID_PATTERN)) {
                call.reject("Invalid share identifier");
                return;
            }
            try {
                File folder = new File(root(), id);
                if (!folder.isDirectory()) throw new IOException("Share no longer exists");
                deleteTree(folder);
                if (folder.exists()) throw new IOException("Could not delete local share");
                call.resolve();
                notifyListeners("shareReceived", new JSObject());
            } catch (Exception ex) {
                call.reject(ex.getMessage());
            }
        });
    }
}
