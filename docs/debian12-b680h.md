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
