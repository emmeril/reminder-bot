# Deployment Debian 12 pada STB B680H

Target: ARM64/Cortex-A53, RAM terbatas, dashboard tetap menjadi pusat pengelolaan.

## Pra-pemeriksaan

Sebelum mengubah host, catat output `uname -a`, `free -h`, `df -h`, `node --version`,
dan status process manager. Buat backup melalui dashboard dan salin
`database/reminder_bot.sqlite`, file WAL/SHM saat aplikasi berhenti,
`database/baileys_auth.sqlite`, `.env`, serta `templates/`.

Jangan memasang image atau kernel generik secara otomatis pada B680H. Kompatibilitas
Wi-Fi, eMMC, dan bootloader bergantung pada image Debian/vendor yang dipakai.

## Resource profile

- Jalankan satu backend Node (`instances: 1`, fork mode) dengan batas heap 256 MB.
- Pertahankan cron existing satu menit; jangan membuat scheduler kedua.
- Gunakan SQLite WAL existing dan simpan database pada eMMC/media yang sehat.
- Batasi log dengan PM2 logrotate atau retensi journald.
- Hindari container tambahan pada host dengan RAM terbatas.

## Pilih satu process manager

### PM2

```bash
pm2 start ecosystem.config.cjs --only reminder-bot
pm2 save
pm2 startup
```

### systemd

Salin `deploy/systemd/reminder-bot.service` ke `/etc/systemd/system/`, sesuaikan
`User`, `Group`, `WorkingDirectory`, dan `EnvironmentFile`, lalu jalankan:

```bash
systemctl daemon-reload
systemctl enable --now reminder-bot.service
```

Jangan sekaligus menjalankan backend melalui PM2 dan systemd.

## Verifikasi startup

1. Pastikan hanya satu PID backend mendengarkan port dashboard.
2. Buka `/transport` dan pindai QR Baileys bila sesi belum tertaut.
3. Jalankan Test Connection, lalu kirim satu pesan test ke nomor operator.
4. Buat satu reminder dan verifikasi Activity Log sampai status terkirim.

## Rollback

1. Deploy commit versi sebelumnya tanpa menghapus database.
2. Jika database perlu dipulihkan, hentikan backend lalu pulihkan satu set SQLite
   `.sqlite`, `-wal`, dan `-shm` yang konsisten dari backup.
3. Mulai satu instance backend dan verifikasi reminder, Sent History, Telegram,
   MikroTik, backup, dan autentikasi.
