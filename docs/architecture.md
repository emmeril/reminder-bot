# Arsitektur aplikasi

`src/app.js` adalah composition root. File ini hanya membuat service, memasang scheduler, mengelola startup/shutdown, dan mempertahankan export publik yang dipakai test serta `index.js`.

## Modul utama

- `src/modules/customers/domain.js`: aturan murni pelanggan, siklus tagihan, status hotspot, dan format laporan.
- `src/modules/customers/routes.js`: endpoint pelanggan, akun hotspot/IP Binding, dan pembayaran pelanggan.
- `src/modules/data-manager/core.js`: koneksi database, pemuatan data, migrasi dasar, voucher, akun portal, dan transaksi gateway.
- `src/modules/data-manager/customers.js`: pelanggan, reminder, tunggakan, serta siklus hidup akun hotspot.
- `src/modules/data-manager/service.js`: pengaturan, laporan pembayaran, dan reset pembayaran bulanan. File ini adalah class publik `DataManager`.
- `src/modules/mikrotik/domain.js`: normalisasi MAC, rate-limit, target Simple Queue, dan nilai RouterOS.
- `src/modules/mikrotik/service.js`: seluruh komunikasi dan operasi MikroTik.
- `src/modules/notifications/service.js`: pengiriman WhatsApp/Telegram dan perenderan pesan pembayaran.
- `src/modules/vouchers/domain.js`: validasi, parsing, script profile, dan laporan voucher.
- `src/modules/vouchers/routes.js`: endpoint voucher.
- `src/modules/web-server/service.js`: middleware, autentikasi web, portal pelanggan, dan route administratif yang belum menjadi modul fitur.
- `public/dashboard/state.js`: state awal Alpine dan nilai formulir bawaan.
- `public/dashboard/ui.js`: lifecycle, API browser, toast, dialog, serta navigasi dashboard.
- `public/dashboard/selectors.js`: formatter, status turunan, filter, pagination, dan ringkasan laporan.
- `public/dashboard/data.js`: pemuatan data, voucher, laporan, serta polling pekerjaan latar belakang.
- `public/dashboard/actions.js`: aksi formulir dan perubahan data oleh administrator.
- `public/app.js`: menggabungkan descriptor kelima modul menjadi satu komponen `dashboardApp()` tanpa mengubah getter Alpine.

## Arah dependensi

Domain tidak boleh mengimpor web server atau composition root. Service boleh memakai domain dan utilitas bersama. Route menerima dependency melalui fungsi registrasi, sehingga tidak membuat instance database atau koneksi MikroTik sendiri.

Saat menambah fitur:

1. Letakkan aturan tanpa I/O di `domain.js` fitur terkait dan tambahkan unit test.
2. Letakkan akses eksternal di service atau lapisan data yang sesuai.
3. Daftarkan endpoint melalui file `routes.js` fitur, bukan langsung di `src/app.js`.
4. Pertahankan `src/app.js` sebagai wiring startup dan shutdown saja.
5. Untuk dashboard, tambahkan state atau method ke modul `public/dashboard` yang sesuai dan pertahankan urutan script `defer` pada `public/index.html`.

Jalankan `npm run check` sebelum commit.
