# Deployment Debian 12 pada STB B680H

Target: ARM64/Cortex-A53, RAM terbatas, dashboard existing tetap satu-satunya pusat pengelolaan.

## Pra-pemeriksaan

Sebelum mengubah host, catat output `uname -a`, `free -h`, `df -h`, `waydroid status`, `adb devices`, `node --version`, dan status PM2/systemd. Buat backup melalui dashboard dan salin `database/reminder_bot.sqlite`, file WAL/SHM saat aplikasi berhenti, `database/baileys_auth.sqlite`, `.env`, serta `templates/`.

Jangan memasang image/kernel generik secara otomatis pada B680H. Kompatibilitas binder, GPU, Wi-Fi, eMMC, dan bootloader bergantung pada image Debian/vendor yang dipakai.

## Resource profile

- Gunakan satu backend Node (`instances: 1`, fork mode), satu queue worker, dan `--max-old-space-size=256`.
- Pertahankan cron existing satu menit; jangan membuat scheduler kedua.
- Gunakan SQLite WAL existing dan simpan database pada eMMC/media yang sehat.
- Batasi log dengan PM2 logrotate atau journald retention; ActivityLog aplikasi sendiri dibatasi.
- Waydroid: hentikan aplikasi Android yang tidak perlu, nonaktifkan sync/background app non-esensial, gunakan resolusi rendah, dan sisakan ruang disk untuk image/cache.
- Jangan menambahkan Docker untuk backend, bridge, Appium, atau Waydroid.

## Pilih satu process manager

### PM2 existing

```bash
pm2 start ecosystem.config.cjs --only reminder-bot
pm2 start ecosystem.config.cjs --only whatsapp-bridge
pm2 save
pm2 startup
```

Untuk Baileys-only, jalankan hanya `reminder-bot`. Jangan sekaligus mengaktifkan unit systemd backend.

### systemd

Salin unit dari `deploy/systemd/` ke `/etc/systemd/system/`, sesuaikan `User`, `Group`, `WorkingDirectory`, dan `EnvironmentFile`, lalu jalankan `systemctl daemon-reload`. Urutannya:

`network-online -> waydroid-container -> whatsapp-bridge -> reminder-bot`

Unit reminder-bot memakai `Wants`, bukan `Requires`, sehingga backend/dashboard tetap hidup jika bridge belum siap. AndroidProvider akan unavailable dan reminder tetap pending.

Nama unit container Waydroid dapat berbeda. Bila host tidak memakai `waydroid-container.service`, sesuaikan baris `Wants`/`After` dengan unit yang benar; jangan membuat unit container kedua.

Untuk mode headless, tersedia tiga unit tambahan:

`waydroid-weston -> waydroid-session -> waydroid-headless-ready`

Unit readiness menunggu `sys.boot_completed=1`, memperbaiki tabel route Android
`eth0` bila kosong, menyambungkan ADB yang sudah diotorisasi, mempertahankan display
awake, lalu baru mengizinkan bridge berjalan. Sesuaikan `/opt/reminder-bot` pada unit
dengan lokasi deployment sebenarnya.

User service harus memiliki akses ke session Waydroid dan ADB yang sama. Jika Waydroid berjalan pada user desktop lain, sesuaikan unit bridge ke user tersebut atau konfigurasi ADB dengan permission yang tepat; jangan memberi akses root tanpa kebutuhan.

## Startup verification

1. Reboot host.
2. Pastikan hanya satu PID backend mendengarkan port dashboard.
3. Buka dashboard dan periksa provider/status.
4. Panggil `GET /api/whatsapp/status` menggunakan sesi login atau `X-API-Key`.
5. Jalankan Test Connection, lalu kirim satu pesan test ke nomor milik operator.
6. Buat satu reminder beberapa menit ke depan dan verifikasi urutan Activity Log: queued, processing/retry bila perlu, sent setelah confirmation.

## Rollback

1. Set `WHATSAPP_PROVIDER=baileys` atau pilih Baileys di dashboard.
2. Hentikan hanya `whatsapp-bridge`/Appium/Waydroid bila tidak lagi diperlukan.
3. Deploy commit versi sebelumnya tanpa menghapus database. Metadata provider berada di JSON payload dan diabaikan oleh versi lama.
4. Jika rollback database diperlukan, hentikan backend, simpan database saat ini, lalu pulihkan satu set SQLite `.sqlite`, `-wal`, dan `-shm` yang konsisten dari backup.
5. Mulai satu instance backend dan verifikasi `/transport`, reminder, Sent History, Telegram, MikroTik, backup, dan authentication.

Tidak ada migration destruktif atau tabel existing yang dipindahkan oleh update ini.

## Catatan host B860H yang sudah diverifikasi

Host ARM64 ini menggunakan Armbian/Debian 12 dengan kernel `6.1.182-ophub` dan RAM
sekitar 1.8 GiB. Kernel tidak menyediakan PSI yang dibutuhkan konfigurasi LMKD
cgroup-v2 Android. Boot host berhasil distabilkan dengan cgroup-v1 melalui:

```text
systemd.unified_cgroup_hierarchy=false
```

Sebelum perubahan boot, simpan salinan `/boot/uEnv.txt`. Pada host ini backup berada
di `/boot/uEnv.txt.pre-waydroid-20260809`. Jangan menerapkan parameter ini secara
otomatis pada perangkat lain; verifikasi kernel dan siapkan akses pemulihan serial/eMMC.

Image resmi LineageOS 20/Android 13 ARM64 yang diuji mengalami crash upstream pada
`system_server` thread `android.display` (`ActivityThread.acquireProvider`). Data reset
tidak memperbaikinya. Fallback yang berhasil boot adalah image arsip resmi
LineageOS 18.1/Android 11 ARM64 tanggal 2025-06-28. Image aktif disimpan di
`/root/waydroid-images` dan diakses melalui symlink `/etc/waydroid-extra/images` agar
partisi root sistem yang kecil tidak penuh. OTA sengaja dinonaktifkan pada
`/var/lib/waydroid/waydroid.cfg` supaya image tidak kembali ter-upgrade ke Android 13
yang bermasalah.

Rollback image Android 13 pada host ini tersedia di:

```text
/root/waydroid-images-lineage20-20260403
/root/waydroid-state-lineage20-20260403
```

Android 11 sempat mencatat crash-loop SystemUI pada callback FOD saat boot awal, tetapi
`system_server`, `surfaceflinger`, dan LMKD tetap stabil serta
`sys.boot_completed=1`. Karena binary `input keyevent` dapat hang pada kondisi ini,
deployment memakai display awake, `wm dismiss-keyguard`, dan Appium
`skipUnlock=true`. Jangan menganggap `/status` Appium cukup: verifikasi minimal satu
session UiAutomator2 dan pembacaan source accessibility setelah reboot.

Jika aplikasi Java masih mengalami SIGSEGV pada frame `boot-framework.oat`, uji mode
interpreter dengan backup konfigurasi terlebih dahulu:

```ini
[properties]
dalvik.vm.extra-opts = -Xint
dalvik.vm.usejit = false
```

Workaround ini menghindari sebagian kode OAT/implicit null-check, tetapi membuat Android
lebih lambat. Hapus properti dan pulihkan backup konfigurasi bila tidak memperbaiki crash;
jangan menyatakan provider ready sebelum WhatsApp dan satu session UiAutomator2 stabil.

Pada jaringan yang memaksa paket balasan internet ke `TTL=1`, koneksi host tetap bekerja
tetapi paket akan kedaluwarsa saat diteruskan ke Waydroid. Readiness script menambahkan
satu aturan mangle yang sangat terbatas: hanya paket balasan `ESTABLISHED,RELATED` dengan
TTL 1 untuk koneksi yang berasal dari subnet Waydroid yang dinaikkan satu. Verifikasi
dengan packet capture sebelum mengandalkan workaround ini; jangan menerapkan perubahan
TTL global ke trafik LAN atau internet lainnya.
