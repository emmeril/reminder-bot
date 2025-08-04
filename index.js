const fs = require("fs/promises");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const express = require("express");
const app = express();

const cron = require("node-cron");

const DB_PATH = path.join(__dirname, "database");
const TEMPLATE_PATH = path.join(__dirname, "templates");

fs.mkdir(DB_PATH, { recursive: true });
fs.mkdir(TEMPLATE_PATH, { recursive: true });

const contactsPath = path.join(DB_PATH, "contacts.json");
const remindersPath = path.join(DB_PATH, "reminders.json");
const sentRemindersPath = path.join(DB_PATH, "sent_reminders.json");
const rolesPath = path.join(DB_PATH, "roles.json");

let contacts = new Map();
let reminders = new Map();
let sentReminders = new Map();
let roles = new Map();
let sessions = new Map();

// Utils
const loadMapFromFile = async (filePath, key = "id") => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const arr = JSON.parse(raw || "[]");
    return new Map(arr.map((item) => [item[key], item]));
  } catch {
    return new Map();
  }
};

const loadRolesFromFile = async () => {
  try {
    const raw = await fs.readFile(rolesPath, "utf-8");
    const json = JSON.parse(raw || "{}");
    return new Map(Object.entries(json));
  } catch {
    return new Map();
  }
};

const saveMapToFile = async (map, filePath) => {
  const arr = Array.from(map.values());
  await fs.writeFile(filePath, JSON.stringify(arr, null, 2));
};

const saveRolesToFile = async () => {
  const obj = Object.fromEntries(roles);
  await fs.writeFile(rolesPath, JSON.stringify(obj, null, 2));
};

const loadTemplates = async () => {
  const files = await fs.readdir(TEMPLATE_PATH);
  const templates = [];

  for (const file of files) {
    const content = await fs.readFile(path.join(TEMPLATE_PATH, file), "utf-8");
    templates.push({
      name: file.replace(/^\d+_/, "").replace(".txt", ""),
      content,
    });
  }

  return templates;
};

const isAdmin = (sender) => {
  const number = sender.split("@")[0];
  return roles.get(number) === "admin";
};

// Load data awal
(async () => {
  contacts = await loadMapFromFile(contactsPath);
  reminders = await loadMapFromFile(remindersPath);
  sentReminders = await loadMapFromFile(sentRemindersPath);
  roles = await loadRolesFromFile();
})();

// Setup WhatsApp
let currentQR = null;
let isReady = false;

// const client = new Client({
//   authStrategy: new LocalAuth(),
//   puppeteer: { headless: true, args: ["--no-sandbox"] },
// });

//termux
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: "/usr/bin/chromium",
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",

      // Optimasi untuk device low-resource
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu-shader-disk-cache",
      "--no-zygote",

      // Mempercepat startup dan kurangi overhead
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-infobars",

      // Minimalkan proses background
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",

      // Nonaktifkan fitur Chromium berat
      "--disable-features=IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests",
      "--disable-site-isolation-trials",
      "--disable-sync",
      "--disable-translate",
      "--disable-gl-drawing-for-tests",
      "--disable-canvas-aa",
      "--no-service-worker-by-default",
      "--mute-audio",

      // Tambahan untuk stabilitas di STB
      "--single-process", // Kurangi overhead multi-proses
      "--disable-crash-reporter", // Jangan kirim laporan crash
      "--disable-client-side-phishing-detection",
    ],
  },
});


client.on("qr", (qr) => {
  currentQR = qr;
  isReady = false;
  console.log("📲 QR code siap discan.");
});

client.on("ready", () => {
  isReady = true;
  currentQR = null;
  console.log("✅ WhatsApp berhasil terhubung.");
});

client.on("disconnected", (reason) => {
  console.log("❌ WhatsApp disconnected:", reason);
  fs.rmSync(".wwebjs_auth", { recursive: true, force: true });
  process.exit(); // atau restart otomatis
});

app.get("/qr", async (req, res) => {
  if (isReady) {
    return res.send(`
      <html>
        <head>
          <title>WhatsApp Terhubung</title>
          <style>
            body {
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              background: #f2f2f2;
              font-family: sans-serif;
              margin: 0;
            }
            .status {
              font-size: 1.5rem;
              color: #28a745;
            }
          </style>
        </head>
        <body>
          <div class="status">✅ WhatsApp sudah terhubung.</div>
        </body>
      </html>
    `);
  }

  if (!currentQR) {
    return res.send("⏳ Menunggu QR code tersedia...");
  }

  const qrImage = await QRCode.toDataURL(currentQR);

  res.send(`
    <html>
      <head>
        <title>Scan QR WhatsApp</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta http-equiv="refresh" content="15" />
        <style>
          body {
            margin: 0;
            padding: 0;
            background: #f7f7f7;
            font-family: sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
            text-align: center;
          }
          h1 {
            margin-bottom: 1rem;
            font-size: 1.8rem;
            color: #333;
          }
          img {
            width: 90%;
            max-width: 300px;
            border: 8px solid #fff;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            border-radius: 10px;
          }
          p {
            margin-top: 1rem;
            font-size: 1rem;
            color: #666;
          }
          .small {
            font-size: 0.8rem;
            color: #aaa;
          }
        </style>
      </head>
      <body>
        <h1>Scan QR WhatsApp</h1>
        <img src="${qrImage}" alt="QR Code WhatsApp" />
        <p>Silakan scan dengan aplikasi WhatsApp kamu.</p>
        <p class="small">⏳ Halaman ini auto-refresh setiap 15 detik</p>
      </body>
    </html>
  `);
});

client.initialize();

const PORT = 3025;
app.listen(PORT, () => {
  console.log(`🌐 Akses QR di browser: http://localhost:${PORT}/qr`);
});

// Bot logic
client.on("message", async (msg) => {
  const sender = msg.from;
  const body = msg.body.trim();
  const session = sessions.get(sender);
  const number = sender.split("@")[0];

  if (body === "!addreminder") {
    if (!isAdmin(sender)) {
      return msg.reply("❌ Anda bukan admin. Akses ditolak.");
    }

    const contactList = Array.from(contacts.values());
    const list = contactList.map((c, i) => `${i + 1}. ${c.name}`).join("\n");

    sessions.set(sender, { step: "add-1", contactList });
    return msg.reply(
      `📇 Kontak tersedia:\n${list}\n\nKetik nomor kontak (misal: 1):`
    );
  }

  if (session?.step === "add-1") {
    const index = parseInt(body);
    const contact = session.contactList?.[index - 1];

    if (!contact) return msg.reply("❌ Nomor kontak tidak valid.");

    session.kontak = contact;

    const templates = await loadTemplates();
    session.templateOptions = templates;
    session.step = "add-2";

    const list = templates.map((t, i) => `${i + 1}. ${t.name}`).join("\n");

    const fullList = `📄 Pilih Template atau Custom:\n${list}\n${
      templates.length + 1
    }. ✏️ Ketik manual (Custom)\n\nKetik angka pilihan:`;
    return msg.reply(fullList);
  }

  if (session?.step === "add-2") {
    const idx = parseInt(body);
    const templates = session.templateOptions;

    if (idx >= 1 && idx <= templates.length) {
      session.template = templates[idx - 1].content;
      session.step = "add-4";
      return msg.reply("📅 Ketik tanggal & jam (format: YYYY-MM-DD HH:mm):");
    }

    if (idx === templates.length + 1) {
      session.step = "add-3-custom";
      return msg.reply("✏️ Ketik pesan custom Anda:");
    }

    return msg.reply("❌ Pilihan tidak valid. Ketik angka yang tersedia.");
  }

  if (session?.step === "add-3-custom") {
    session.template = body;
    session.step = "add-4";
    return msg.reply("📅 Ketik tanggal & jam (format: YYYY-MM-DD HH:mm):");
  }

  if (session?.step === "add-4") {
    const [tanggal, jam] = body.split(" ");
    const dt = new Date(`${tanggal}T${jam}:00`);
    if (isNaN(dt.getTime())) return msg.reply("❌ Format waktu salah.");

    const bulan = dt.toLocaleString("id-ID", { month: "long" });
    const { kontak, template } = session;

    const finalMessage = template
      .replace(/{{nama}}/gi, kontak.name)
      .replace(/{{tanggal}}/gi, tanggal)
      .replace(/{{bulan}}/gi, bulan);

    const reminder = {
      id: Date.now(),
      phoneNumber: kontak.phoneNumber,
      reminderDateTime: dt,
      message: finalMessage,
    };

    reminders.set(reminder.id, reminder);
    await saveMapToFile(reminders, remindersPath);
    sessions.delete(sender);

    return msg.reply(
      `✅ Reminder disimpan untuk ${kontak.name} pada ${tanggal} ${jam}`
    );
  }

  if (body === "!editreminder") {
    if (!isAdmin(sender)) return msg.reply("❌ Anda bukan admin.");

    const sorted = Array.from(reminders.values()).sort(
      (a, b) => new Date(a.reminderDateTime) - new Date(b.reminderDateTime)
    );

    if (sorted.length === 0) {
      return msg.reply("📭 Tidak ada reminder yang bisa diedit.");
    }

    const list = sorted
      .map((r, i) => {
        const kontak = Array.from(contacts.values()).find(
          (c) => c.phoneNumber === r.phoneNumber
        );
        const nama = kontak ? kontak.name : r.phoneNumber;
        const waktu = new Date(r.reminderDateTime).toLocaleString("id-ID");
        return `${i + 1}. ${nama} | ${waktu}`;
      })
      .join("\n");

    sessions.set(sender, {
      step: "edit-reminder-select",
      list: sorted,
    });

    return msg.reply(
      `✏️ Pilih reminder yang ingin diedit:\n${list}\n\nKetik nomor:`
    );
  }

  if (session?.step === "edit-reminder-select") {
    const index = parseInt(body);
    const selected = session.list?.[index - 1];
    if (!selected) return msg.reply("❌ Nomor tidak valid.");

    session.selectedReminder = selected;
    session.step = "edit-reminder-tanggal";

    return msg.reply(
      "📅 Masukkan tanggal & jam baru (format: YYYY-MM-DD HH:mm):"
    );
  }

  if (session?.step === "edit-reminder-tanggal") {
    const [tanggal, jam] = body.split(" ");
    const dt = new Date(`${tanggal}T${jam}:00`);
    if (isNaN(dt.getTime())) return msg.reply("❌ Format waktu salah.");

    session.newDate = dt;
    session.step = "edit-reminder-pesan";
    return msg.reply(
      "📩 Ganti isi pesan?\n1. Pakai template\n2. Ketik manual\n3. Tidak usah ganti\n\nKetik 1 / 2 / 3:"
    );
  }

  if (session?.step === "edit-reminder-pesan") {
    if (body === "1") {
      const templates = await loadTemplates();
      session.templateOptions = templates;
      session.step = "edit-reminder-template";

      const list = templates.map((t, i) => `${i + 1}. ${t.name}`).join("\n");
      return msg.reply(`📄 Pilih Template:\n${list}\n\nKetik nomor:`);
    }

    if (body === "2") {
      session.step = "edit-reminder-custom";
      return msg.reply("✏️ Ketik pesan baru:");
    }

    if (body === "3") {
      const reminder = session.selectedReminder;
      reminder.reminderDateTime = session.newDate;

      reminders.set(reminder.id, reminder);
      await saveMapToFile(reminders, remindersPath);
      sessions.delete(sender);

      return msg.reply(
        `✅ Reminder berhasil diperbarui ke ${session.newDate.toLocaleString(
          "id-ID"
        )}`
      );
    }

    return msg.reply("❌ Pilih 1 / 2 / 3 sesuai opsi.");
  }

  if (session?.step === "edit-reminder-template") {
    const idx = parseInt(body);
    const selected = session.templateOptions?.[idx - 1];
    if (!selected) return msg.reply("❌ Template tidak ditemukan.");

    const reminder = session.selectedReminder;
    const tanggal = session.newDate.toISOString().split("T")[0];
    const bulan = session.newDate.toLocaleString("id-ID", { month: "long" });

    const kontak = Array.from(contacts.values()).find(
      (c) => c.phoneNumber === reminder.phoneNumber
    );

    const finalMessage = selected.content
      .replace(/{{nama}}/gi, kontak?.name || reminder.phoneNumber)
      .replace(/{{tanggal}}/gi, tanggal)
      .replace(/{{bulan}}/gi, bulan);

    reminder.reminderDateTime = session.newDate;
    reminder.message = finalMessage;

    reminders.set(reminder.id, reminder);
    await saveMapToFile(reminders, remindersPath);
    sessions.delete(sender);

    return msg.reply(
      "✅ Reminder berhasil diperbarui dengan pesan dari template."
    );
  }

  if (session?.step === "edit-reminder-custom") {
    const reminder = session.selectedReminder;
    const tanggal = session.newDate.toISOString().split("T")[0];
    const bulan = session.newDate.toLocaleString("id-ID", { month: "long" });

    const kontak = Array.from(contacts.values()).find(
      (c) => c.phoneNumber === reminder.phoneNumber
    );

    const finalMessage = body
      .replace(/{{nama}}/gi, kontak?.name || reminder.phoneNumber)
      .replace(/{{tanggal}}/gi, tanggal)
      .replace(/{{bulan}}/gi, bulan);

    reminder.reminderDateTime = session.newDate;
    reminder.message = finalMessage;

    reminders.set(reminder.id, reminder);
    await saveMapToFile(reminders, remindersPath);
    sessions.delete(sender);

    return msg.reply("✅ Reminder berhasil diperbarui dengan pesan custom.");
  }

  if (body === "!deletereminder") {
    if (!isAdmin(sender)) return msg.reply("❌ Anda bukan admin.");

    const sorted = Array.from(reminders.values()).sort(
      (a, b) => new Date(a.reminderDateTime) - new Date(b.reminderDateTime)
    );

    if (sorted.length === 0) {
      return msg.reply("📭 Tidak ada reminder yang aktif.");
    }

    const list = sorted
      .map((r, i) => {
        const kontak = Array.from(contacts.values()).find(
          (c) => c.phoneNumber === r.phoneNumber
        );
        const nama = kontak ? kontak.name : r.phoneNumber;
        const waktu = new Date(r.reminderDateTime).toLocaleString("id-ID");
        return `${i + 1}. ${nama} | ${waktu}`;
      })
      .join("\n");

    sessions.set(sender, {
      step: "delete-reminder-select",
      list: sorted,
    });

    return msg.reply(
      `🗑️ Reminder yang tersedia:\n${list}\n\nKetik nomor reminder yang ingin dihapus:`
    );
  }

  if (session?.step === "delete-reminder-select") {
    const index = parseInt(body);
    const selected = session.list?.[index - 1];
    if (!selected) return msg.reply("❌ Nomor tidak valid.");

    reminders.delete(selected.id);
    await saveMapToFile(reminders, remindersPath);
    sessions.delete(sender);

    return msg.reply(`✅ Reminder berhasil dihapus:\n${selected.message}`);
  }

  if (body === "!listreminder") {
    if (!isAdmin(sender)) return msg.reply("❌ Anda bukan admin.");

    const sorted = Array.from(reminders.values()).sort(
      (a, b) => new Date(a.reminderDateTime) - new Date(b.reminderDateTime)
    );

    if (sorted.length === 0) {
      return msg.reply("📭 Belum ada reminder yang aktif.");
    }

    const list = sorted
      .map((r, i) => {
        const kontak = Array.from(contacts.values()).find(
          (c) => c.phoneNumber === r.phoneNumber
        );
        const nama = kontak ? kontak.name : r.phoneNumber;
        const waktu = new Date(r.reminderDateTime).toLocaleString("id-ID", {
          dateStyle: "long",
          timeStyle: "short",
          timeZone: "Asia/Jakarta",
        });

        return `${i + 1}. ${nama} — ${waktu} WIB\n   💬 ${r.message}`;
      })
      .join("\n\n");

    return msg.reply(`📌 Reminder Aktif (urut tanggal):\n\n${list}`);
  }

  if (body === "!addkontak") {
    if (!isAdmin(sender)) return msg.reply("❌ Anda bukan admin.");

    sessions.set(sender, { step: "add-kontak-nama" });
    return msg.reply("📝 Masukkan nama kontak:");
  }

  if (session?.step === "add-kontak-nama") {
    session.nama = body;
    session.step = "add-kontak-nomor";
    return msg.reply("📞 Masukkan nomor HP (format 628xxx):");
  }

  if (session?.step === "add-kontak-nomor") {
    const nomor = body.replace(/[^0-9]/g, "");
    if (!/^628\d{7,13}$/.test(nomor)) return msg.reply("❌ Nomor tidak valid!");

    const newKontak = {
      id: Date.now(),
      name: session.nama,
      phoneNumber: nomor,
    };

    contacts.set(newKontak.id, newKontak);
    await saveMapToFile(contacts, contactsPath);
    sessions.delete(sender);

    return msg.reply(
      `✅ Kontak berhasil ditambahkan:\n${newKontak.name} | ${newKontak.phoneNumber}`
    );
  }
  if (body === "!editkontak") {
    if (!isAdmin(sender)) return msg.reply("❌ Anda bukan admin.");

    const sorted = Array.from(contacts.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    if (sorted.length === 0) {
      return msg.reply("📭 Tidak ada kontak untuk diedit.");
    }

    const list = sorted
      .map((c, i) => `${i + 1}. ${c.name} | ${c.phoneNumber}`)
      .join("\n");

    sessions.set(sender, {
      step: "edit-kontak-select",
      list: sorted,
    });

    return msg.reply(
      `✏️ Kontak tersedia:\n${list}\n\nKetik nomor kontak yang ingin diedit:`
    );
  }

  if (session?.step === "edit-kontak-select") {
    const index = parseInt(body);
    const selected = session.list?.[index - 1];
    if (!selected) return msg.reply("❌ Nomor tidak valid.");

    session.kontak = {
      id: selected.id,
      name: selected.name,
      phoneNumber: selected.phoneNumber,
    };

    session.step = "edit-kontak-nama";
    return msg.reply(`✏️ Nama saat ini: ${selected.name}\nMasukkan nama baru:`);
  }

  if (session?.step === "edit-kontak-nama") {
    session.newName = body;
    session.step = "edit-kontak-nomor";
    return msg.reply(`📞 Masukkan nomor HP baru (format: 628xxx):`);
  }

  if (session?.step === "edit-kontak-nomor") {
    const nomor = body.replace(/[^0-9]/g, "");
    if (!/^628\d{7,13}$/.test(nomor)) return msg.reply("❌ Nomor tidak valid!");

    const kontak = session.kontak;

    if (!kontak?.id) {
      sessions.delete(sender);
      return msg.reply(
        "❌ Error: ID kontak tidak ditemukan. Coba tambah ulang kontak."
      );
    }

    // ⚠️ Tambahan keamanan: pastikan contacts masih Map
    if (!(contacts instanceof Map)) {
      return msg.reply(
        "❌ Error internal: data kontak rusak (bukan Map). Restart bot."
      );
    }

    kontak.name = session.newName;
    kontak.phoneNumber = nomor;

    contacts.set(kontak.id, kontak);
    await saveMapToFile(contacts, contactsPath);
    sessions.delete(sender);

    return msg.reply(
      `✅ Kontak berhasil diperbarui:\n${kontak.name} | ${kontak.phoneNumber}`
    );
  }

  if (body === "!deletekontak") {
    if (!isAdmin(sender)) return msg.reply("❌ Anda bukan admin.");

    const sorted = Array.from(contacts.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    if (sorted.length === 0) {
      return msg.reply("📭 Tidak ada kontak untuk dihapus.");
    }

    const list = sorted
      .map((c, i) => `${i + 1}. ${c.name} | ${c.phoneNumber}`)
      .join("\n");

    sessions.set(sender, {
      step: "delete-kontak-select",
      list: sorted,
    });

    return msg.reply(
      `🗑️ Kontak tersedia:\n${list}\n\nKetik nomor kontak yang ingin dihapus:`
    );
  }

  if (session?.step === "delete-kontak-select") {
    const index = parseInt(body);
    const selected = session.list?.[index - 1];
    if (!selected) return msg.reply("❌ Nomor tidak valid.");

    contacts.delete(selected.id);
    await saveMapToFile(contacts, contactsPath);
    sessions.delete(sender);

    return msg.reply(`✅ Kontak '${selected.name}' berhasil dihapus.`);
  }

  if (body === "!listkontak") {
    if (!isAdmin(sender)) return msg.reply("❌ Anda bukan admin.");

    const sorted = Array.from(contacts.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    if (sorted.length === 0) return msg.reply("📭 Belum ada kontak.");

    const list = sorted
      .map((c, i) => `${i + 1}. ${c.name}\n   📞 ${c.phoneNumber}`)
      .join("\n\n");

    return msg.reply(`📇 Daftar Kontak (A–Z):\n\n${list}`);
  }

  // ADMIN add role
  if (body.startsWith("!setadmin ") && isAdmin(sender)) {
    const newAdminNumber = body.split(" ")[1].replace(/[^0-9]/g, "");
    roles.set(newAdminNumber, "admin");
    await saveRolesToFile();
    return msg.reply(`✅ ${newAdminNumber} sekarang menjadi admin.`);
  }

  // ===== HELP & MENU =====
  if (body === "!help" || body === "!menu") {
    // Daftar perintah umum (semua pengguna)
    const umum = [
      "📖  *Menu Bantuan*",
      "",
      "• !help / !menu  – tampilkan bantuan",
    ];

    // Daftar perintah khusus admin
    const admin = [
      "",
      "🛠️  *Perintah Admin:*",
      "• !addreminder      – tambah reminder",
      "• !editreminder     – ubah reminder",
      "• !deletereminder   – hapus reminder",
      "• !listreminder     – lihat semua reminder",
      "• !addkontak        – tambah kontak",
      "• !editkontak       – ubah kontak",
      "• !deletekontak     – hapus kontak",
      "• !listkontak       – lihat semua kontak",
      "• !setadmin <no>    – jadikan nomor admin",
    ];

    const menuText = isAdmin(sender)
      ? umum.concat(admin).join("\n")
      : umum.join("\n");

    return msg.reply(menuText);
  }
  // ===== END HELP =====
});

// Cron kirim reminder
cron.schedule("*/1 * * * *", async () => {
  const now = Date.now();
  const due = Array.from(reminders.entries()).filter(
    ([, r]) => new Date(r.reminderDateTime).getTime() <= now
  );

  for (const [id, reminder] of due) {
    try {
      await client.sendMessage(
        `${reminder.phoneNumber}@c.us`,
        reminder.message
      );
      console.log("📤 Reminder terkirim:", reminder.phoneNumber);

      // Kirim salinan ke semua admin
      for (const [nomor, role] of roles.entries()) {
        if (role === "admin") {
          const jid = `${nomor}@c.us`;
          if (jid !== `${reminder.phoneNumber}@c.us`) {
            await client.sendMessage(
              jid,
              `📥 Reminder terkirim ke ${reminder.phoneNumber}:\n\n${reminder.message}`
            );
          }
        }
      }

      sentReminders.set(id, reminder);
      reminders.delete(id);

      // Reschedule
      const next = new Date(reminder.reminderDateTime);
      next.setMonth(next.getMonth() + 1);
      const nextDate = `${next.getFullYear()}-${(next.getMonth() + 1)
        .toString()
        .padStart(2, "0")}-${next.getDate().toString().padStart(2, "0")}`;
      const bulan = next.toLocaleString("id-ID", { month: "long" });

      const newMessage = reminder.message
        .replace(/\d{4}-\d{2}-\d{2}/, nextDate)
        .replace(/bulan \w+/gi, `bulan ${bulan}`);

      const newReminder = {
        id: Date.now(),
        phoneNumber: reminder.phoneNumber,
        reminderDateTime: next,
        message: newMessage,
      };

      reminders.set(newReminder.id, newReminder);
    } catch (err) {
      console.error("❌ Gagal kirim:", err.message);
    }
  }

  await saveMapToFile(reminders, remindersPath);
  await saveMapToFile(sentReminders, sentRemindersPath);
});
