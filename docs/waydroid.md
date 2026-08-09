# WhatsApp Android via Waydroid

AndroidProvider tidak menganggap WhatsApp memiliki REST API. Alurnya adalah:

`reminder-bot -> 127.0.0.1 bridge -> Appium UiAutomator2 -> Waydroid -> WhatsApp Android`

Bridge hanya mengembalikan sukses setelah accessibility tree menampilkan teks pada elemen bubble `message_text`. Jika selector berubah, Appium tidak siap, atau konfirmasi tidak terlihat, bridge mengembalikan `ANDROID_PROVIDER_UNAVAILABLE` atau `ANDROID_SEND_UNCONFIRMED`; reminder tetap berada di antrean/retry.

## Dependency Debian 12

- Kernel ARM64 dengan binder/binderfs dan ashmem/memfd yang kompatibel dengan Waydroid.
- Waydroid dan image Android ARM64 yang cocok dengan perangkat.
- Node.js 20+, `adb`, Java runtime yang didukung Appium, dan Appium 2.
- Driver Appium UiAutomator2: `appium driver install uiautomator2`.
- WhatsApp Android yang dipasang secara sah dari sumber tepercaya dan login normal.

Jangan menjalankan installer otomatis tanpa memeriksa kernel, repository APT, ruang disk, dan backup. Prosedur Waydroid berbeda antar image/vendor B680H; ikuti dokumentasi Waydroid untuk Debian dan kernel yang benar-benar terpasang.

## Inisialisasi aman

1. Backup database dan `.env` reminder-bot.
2. Verifikasi arsitektur dengan `uname -m`; target dokumen ini `aarch64`.
3. Verifikasi binder dengan `ls /dev/binderfs` atau konfigurasi kernel vendor.
4. Instal dan inisialisasi Waydroid secara manual, lalu pastikan `waydroid status` menunjukkan container dan session running.
5. Aktifkan ADB Waydroid dan catat serial dari `adb devices`. Isi `ANDROID_ADB_SERIAL` bila ada lebih dari satu device.
6. Instal WhatsApp, login, nonaktifkan battery optimization untuk WhatsApp bila diperlukan, lalu buka aplikasinya.
7. Instal Appium 2 dan driver UiAutomator2. Jalankan Appium hanya pada `127.0.0.1:4723`.
8. Salin `.env.example` ke `.env`, isi token bridge yang panjang, lalu pilih `WHATSAPP_PROVIDER=android` setelah semua health check siap.

## Menjalankan bridge

```bash
npm run start:bridge
curl -H "Authorization: Bearer $ANDROID_BRIDGE_TOKEN" http://127.0.0.1:3030/v1/status
```

Untuk systemd, salin unit dari `deploy/systemd/`. Unit bridge dapat mengelola Appium dengan `ANDROID_BRIDGE_MANAGE_APPIUM=true`. Jika Appium sudah dikelola service lain, set nilainya `false` agar tidak ada dua instance Appium.

`ANDROID_AUTO_START_WHATSAPP=true` meminta bridge meluncurkan package WhatsApp melalui ADB bila Waydroid dan package sudah tersedia. Ini tidak memulai session grafis Waydroid; session/compositor harus dikonfigurasi sebagai bagian deployment host dan diverifikasi setelah reboot.

## WhatsApp dan selector

Bridge memakai deep link `wa.me`, tombol accessibility `Send`/`Kirim`, dan resource id yang mengandung `message_text`. UI WhatsApp dapat berubah tanpa pemberitahuan. Sesuaikan `ANDROID_SEND_XPATH` hanya setelah memeriksa Appium Inspector. Jangan melonggarkan konfirmasi menjadi selalu sukses; kegagalan selector harus tetap menghasilkan unconfirmed.

## Troubleshooting

- `waydroid=stopped`: mulai container/session dan periksa binder/kernel.
- `whatsappInstalled=false`: periksa `adb shell pm path com.whatsapp`.
- `whatsappRunning=false`: buka WhatsApp dan periksa `adb shell pidof com.whatsapp`.
- `appium=disconnected`: periksa Java, Appium, driver UiAutomator2, port 4723, dan serial ADB.
- `ANDROID_SEND_UNCONFIRMED`: periksa bahasa UI, selector tombol, resource id bubble, dialog permission/update, dan koneksi internet Android.
- Jangan menandai reminder secara manual sebagai sent untuk menyembunyikan error bridge; perbaiki health/selector lalu biarkan scheduler retry.

## Batasan

UI automation lebih rapuh daripada API resmi dan dapat rusak setelah update WhatsApp/Android. Solusi ini tidak menyediakan bypass ban, rate-limit, CAPTCHA, permission, atau mekanisme keamanan WhatsApp. Gunakan concurrency 1 dan reminder yang sah dalam volume normal.
