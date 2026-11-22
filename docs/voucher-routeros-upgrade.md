# Voucher pada RouterOS 6 dan 7

Generator profile menggunakan satu script untuk tanggal `mon/dd/yyyy` pada ROS 6/ROS 7 lama dan `yyyy-mm-dd` pada ROS 7.10 ke atas. Pemeriksaan tanggal dilakukan saat script berjalan, sehingga profile yang dipasang sebelum upgrade tetap bisa dipakai sesudah upgrade.

`on-login` menghitung masa berlaku dari tanggal **dan jam login pertama**. Bentuk `next-run` berupa jam saja, tanggal tanpa tahun, tanggal lengkap ROS 6, dan tanggal ISO ditangani. Scheduler sementara memakai awalan `rb-voucher-expiry-`, lalu dihapus setelah tanggal expired dibaca. Jika inisialisasi gagal, sesi diputus, kegagalan dicatat pada log, dan komentar awal dipertahankan untuk percobaan login berikutnya.

Monitor membandingkan tanggal dan waktu sampai detik, termasuk pergantian tahun dan tahun kabisat. Pemutusan tetap mengikuti interval monitor profile, sehingga bisa terlambat paling lama sekitar satu interval. Mode hapus/batasi dan pencatatan pemakaian tetap mengikuti pengaturan profile.

Komentar expired voucher aktif dalam kedua format tidak diubah saat profile disimpan ulang atau saat script diperbarui. Login ulang tidak memulai masa berlaku baru. Catatan pemakaian tetap memakai format Mikhmon yang sudah dibaca aplikasi. Jam dan zona waktu router harus benar sebelum monitor dijalankan.

## Memperbarui profile yang sudah terpasang

Perubahan kode aplikasi tidak otomatis mengganti script di MikroTik. Jalankan dari direktori aplikasi:

```sh
npm run voucher:scripts:prepare
```

Perintah ini membaca router dari konfigurasi aplikasi dan menyiapkan direktori privat di `database/voucher-script-upgrades/` berisi:

- `snapshot.json`: identitas router serta script sebelum dan sesudah pembaruan.
- `apply.rsc`: mengganti monitor terlebih dahulu, lalu `on-login`.
- `rollback.rsc`: memasang kembali script awal.

Perintah tersebut tidak menulis ke router. Hanya profile dengan aturan expired yang valid dan scheduler bernama sama dengan komentar `Monitor Profile <nama>` yang dipilih. Harga, komisi, penguncian MAC, rate limit, interval/status scheduler, dan komentar user tidak diganti oleh file import. Profile yang dilewati ditampilkan beserta alasannya. Backup yang sudah ada tidak ditimpa.

Simpan backup konfigurasi router sebelum pemasangan. Periksa identitas router dan daftar profile pada preview; file import menggunakan ID profile dan scheduler dari snapshot. File import memeriksa ulang nama pada ID tersebut sebelum menulis. Jika konfigurasi berubah sejak preview dibuat, buat preview baru. Unggah `apply.rsc` ke router yang sama dan import pada jadwal pemeliharaan:

```routeros
/import file-name=apply.rsc
```

Setelah pemasangan, baca kembali `on-login` dan `on-event`, periksa log error, lalu uji voucher pendek pada profile uji: login pertama, logout/login ulang, expired ketika online dan offline, serta catatan pemakaian. Setelah verifikasi ROS 6, uji lagi pada versi ROS 7 tujuan sebelum upgrade router utama. Tes otomatis mengevaluasi script dalam simulasi terbatas; tes tersebut tidak menggantikan pengujian parser dan perilaku scheduler RouterOS.

Untuk mengembalikan script awal pada router dan profile yang sama:

```routeros
/import file-name=rollback.rsc
```

Rollback script tidak memulihkan user yang sudah dihapus monitor atau sesi yang sudah diputus. Setelah aplikasi direstart melalui pengelola proses yang digunakan, penyimpanan profile dari dashboard akan memakai generator baru.
