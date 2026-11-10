# Backup database aplikasi via Telegram

Aplikasi menyimpan backup SQLite lokal secara otomatis setiap hari. Jadwalnya sekarang dapat diatur terpisah dari backup MikroTik di **Pengaturan > Backup**, menggunakan zona waktu bersama yang dipilih di tab tersebut.

Untuk mengirim snapshot database ke Telegram, isi `TELEGRAM_BOT_TOKEN` dan `TELEGRAM_CHAT_IDS` pada server, kemudian aktifkan **Kirim file backup database SQLite ke Telegram** dan simpan pengaturan. Pengiriman default nonaktif. Bot akan mengirim file `.sqlite` ke chat ID yang ditentukan, bukan melalui WhatsApp.

Backup lokal tetap dibuat bila Telegram belum diatur, koneksi terputus, atau pengiriman gagal. Aplikasi mencoba ulang pengiriman sekitar lima menit kemudian menggunakan snapshot lokal hari tersebut. Jika sedikitnya satu chat berhasil menerima, pengiriman tanggal itu dianggap selesai; kesalahan chat lain dicatat di Log Sistem agar tidak mengirim duplikat ke chat yang sudah berhasil.

Cadangan lokal lama mengikuti `DB_BACKUP_RETENTION_DAYS` (default tiga hari). Scheduler hanya berjalan pada database SQLite lokal; konfigurasi PostgreSQL melalui `DATABASE_URL` tidak didukung oleh fitur backup ini.

**Peringatan privasi:** file database mengandung data pelanggan dan dapat memuat informasi akun. Telegram Bot API bukan penyimpanan end-to-end encrypted. Gunakan chat privat admin yang benar-benar dipercaya, batasi akses bot, dan simpan salinan aman untuk pemulihan bencana.

Untuk memulihkan database SQLite, hentikan aplikasi, simpan salinan file aktif, salin snapshot `.sqlite` yang benar ke lokasi `DB_STORAGE`, lalu hidupkan kembali aplikasi. Jangan menimpa database aktif saat aplikasi masih berjalan.

## Pengiriman manual dua backup

Pada **Pengaturan > Backup**, tombol **Kirim Backup MikroTik & Aplikasi** langsung membuat kedua backup dan mengirim dua file terpisah ke chat Telegram admin yang dikonfigurasi. Tombol ini bekerja meskipun opsi kirim terjadwal nonaktif, selama Telegram sudah disiapkan.

File MikroTik sementara dihapus setelah proses pengiriman, sedangkan snapshot database SQLite tetap disimpan lokal mengikuti masa retensi. Jika salah satu proses pembuatan atau pengiriman gagal, proses lainnya tetap dilanjutkan. Dashboard menampilkan hasil terpisah untuk MikroTik dan database; detail kegagalan dicatat pada Log Sistem. Endpoint lama `POST /api/mikrotik/backup/send` tetap tersedia untuk integrasi yang hanya mengirim backup MikroTik.
