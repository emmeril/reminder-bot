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

// Pastikan direktori ada
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

// 🔧 FIX: Enhanced Lock mechanism untuk prevent race conditions
const fileLocks = new Map();

const acquireLock = async (filePath) => {
  while (fileLocks.has(filePath)) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  fileLocks.set(filePath, true);
};

const releaseLock = (filePath) => {
  fileLocks.delete(filePath);
};

// 🔧 FIX: Enhanced Atomic write dengan backup dan retry mechanism
const atomicWrite = async (filePath, data, maxRetries = 3) => {
  await acquireLock(filePath);
  
  try {
    const tempPath = filePath + '.tmp';
    const backupPath = filePath + '.bak';
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Backup file original jika ada
        try {
          await fs.copyFile(filePath, backupPath);
        } catch (error) {
          // File mungkin tidak exist, itu normal
        }
        
        // Tulis ke temporary file dulu
        await fs.writeFile(tempPath, JSON.stringify(data, null, 2));
        
        // Verify data yang ditulis
        const verifyData = await fs.readFile(tempPath, 'utf-8');
        JSON.parse(verifyData); // Test parse JSON
        
        // Atomic rename temporary ke file utama
        await fs.rename(tempPath, filePath);
        
        console.log(`✅ Data berhasil disimpan ke ${filePath}`);
        return;
        
      } catch (error) {
        console.error(`❌ Attempt ${attempt} failed for ${filePath}:`, error.message);
        
        // Restore from backup jika ada
        try {
          await fs.copyFile(backupPath, filePath);
          console.log(`🔄 Restored ${filePath} from backup`);
        } catch (restoreError) {
          // Tidak bisa restore, continue ke retry berikutnya
        }
        
        if (attempt === maxRetries) {
          throw new Error(`Failed to write ${filePath} after ${maxRetries} attempts: ${error.message}`);
        }
        
        // Wait sebelum retry
        await new Promise(resolve => setTimeout(resolve, 100 * attempt));
      }
    }
  } finally {
    releaseLock(filePath);
    
    // Cleanup temporary files
    try {
      await fs.unlink(filePath + '.tmp');
    } catch (error) {
      // Ignore error jika file tidak exist
    }
  }
};

// Utils dengan error handling yang lebih baik
const loadMapFromFile = async (filePath, key = "id") => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    if (!raw || raw.trim() === '') {
      console.log(`📁 File ${filePath} kosong, mengembalikan Map kosong`);
      return new Map();
    }
    
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) {
      console.warn(`⚠️ Data di ${filePath} bukan array, mengembalikan Map kosong`);
      return new Map();
    }
    
    return new Map(arr.map((item) => {
      if (item && typeof item === 'object' && key in item) {
        return [item[key], item];
      }
      console.warn(`⚠️ Item invalid di ${filePath}:`, item);
      return null;
    }).filter(Boolean));
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`📁 File ${filePath} tidak ditemukan, membuat baru`);
      return new Map();
    }
    console.error(`❌ Error loading ${filePath}:`, error.message);
    
    // Try to recover corrupted file
    try {
      const backupPath = filePath + '.bak';
      await fs.copyFile(backupPath, filePath);
      console.log(`🔄 Restored ${filePath} from backup after corruption`);
      return await loadMapFromFile(filePath, key);
    } catch (recoverError) {
      console.error(`❌ Cannot recover ${filePath}, using empty Map`);
      return new Map();
    }
  }
};

const loadRolesFromFile = async () => {
  try {
    const raw = await fs.readFile(rolesPath, "utf-8");
    if (!raw || raw.trim() === '') {
      return new Map();
    }
    
    const json = JSON.parse(raw);
    if (typeof json !== 'object' || json === null) {
      console.warn(`⚠️ Data roles invalid, menggunakan Map kosong`);
      return new Map();
    }
    
    return new Map(Object.entries(json));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return new Map();
    }
    console.error("❌ Error loading roles:", error.message);
    return new Map();
  }
};

// 🔧 FIX: Gunakan atomic write untuk semua save operations
const saveMapToFile = async (map, filePath) => {
  try {
    const arr = Array.from(map.values());
    await atomicWrite(filePath, arr);
  } catch (error) {
    console.error(`❌ Critical error saving ${filePath}:`, error);
    throw error;
  }
};

const saveRolesToFile = async () => {
  try {
    const obj = Object.fromEntries(roles);
    await atomicWrite(rolesPath, obj);
  } catch (error) {
    console.error("❌ Critical error saving roles:", error);
    throw error;
  }
};

const loadTemplates = async () => {
  try {
    const files = await fs.readdir(TEMPLATE_PATH);
    const templates = [];

    for (const file of files) {
      try {
        const content = await fs.readFile(path.join(TEMPLATE_PATH, file), "utf-8");
        templates.push({
          name: file.replace(/^\d+_/, "").replace(".txt", ""),
          content,
        });
      } catch (error) {
        console.error(`❌ Error loading template ${file}:`, error.message);
      }
    }

    return templates;
  } catch (error) {
    console.error("❌ Error loading templates:", error.message);
    return [];
  }
};

const isAdmin = (sender) => {
  const number = sender.split("@")[0];
  return roles.get(number) === "admin";
};

// 🔧 FIX: Enhanced Periodic backup dan auto-save
const createBackup = async () => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(DB_PATH, 'backups', timestamp);
  
  try {
    await fs.mkdir(backupDir, { recursive: true });
    
    const files = [contactsPath, remindersPath, sentRemindersPath, rolesPath];
    
    for (const file of files) {
      try {
        await fs.copyFile(file, path.join(backupDir, path.basename(file)));
      } catch (error) {
        // Skip jika file tidak exist
      }
    }
    
    console.log(`💾 Backup created: ${backupDir}`);
  } catch (error) {
    console.error('❌ Backup failed:', error.message);
  }
};

// Auto-save setiap 5 menit untuk prevent data loss
const autoSave = async () => {
  try {
    console.log('🔄 Auto-saving data...');
    await saveMapToFile(contacts, contactsPath);
    await saveMapToFile(reminders, remindersPath);
    await saveMapToFile(sentReminders, sentRemindersPath);
    await saveRolesToFile();
    console.log('✅ Auto-save completed');
  } catch (error) {
    console.error('❌ Auto-save failed:', error);
  }
};

// Load data awal dengan error handling
(async () => {
  try {
    console.log('📂 Loading data...');
    
    contacts = await loadMapFromFile(contactsPath);
    reminders = await loadMapFromFile(remindersPath);
    sentReminders = await loadMapFromFile(sentRemindersPath);
    roles = await loadRolesFromFile();
    
    console.log(`✅ Data loaded: ${contacts.size} contacts, ${reminders.size} reminders, ${roles.size} roles`);
    
    // Create initial backup
    await createBackup();
    
    // Start auto-save interval (setiap 30 menit)
    setInterval(autoSave, 24 * 60 * 60 * 1000);
    
    // Backup setiap 24 jam
    setInterval(createBackup, 24 * 60 * 60 * 1000);
  } catch (error) {
    console.error('❌ Failed to load initial data:', error);
  }
})();

// 🔧 FIX: Enhanced Puppeteer configuration untuk stability
const puppeteerOptions = {
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-accelerated-2d-canvas",
    "--no-first-run",
    "--no-zygote",
    "--disable-gpu",
    "--disable-software-rasterizer",
    "--disable-web-security",
    "--disable-features=VizDisplayCompositor",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--max-old-space-size=512",
    "--single-process"
  ],
  ignoreHTTPSErrors: true,
  handleSIGINT: false,
  handleSIGTERM: false,
  handleSIGHUP: false
};

// 🔧 FIX: Enhanced Client dengan restart mechanism dan connection monitoring
let client = null;
let currentQR = null;
let isReady = false;
let restartCount = 0;
const MAX_RESTARTS = 10;
const RESTART_DELAY = 10000; // 10 detik

// 🔧 NEW: Enhanced message sender dengan retry mechanism
const sendMessageWithRetry = async (chatId, message, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Check connection status before sending
      if (!client || !isReady) {
        throw new Error('Client not ready');
      }

      await client.sendMessage(chatId, message);
      console.log(`✅ Message sent successfully to ${chatId}`);
      return true;
      
    } catch (error) {
      console.error(`❌ Send attempt ${attempt}/${maxRetries} failed:`, error.message);
      
      if (error.message.includes('Session closed') || 
          error.message.includes('Protocol error') ||
          error.message.includes('Target closed')) {
        
        console.log('🔄 Session error detected, marking as disconnected...');
        isReady = false;
        
        if (attempt === maxRetries) {
          console.log('🔁 Max retries reached, triggering client restart...');
          setTimeout(restartClient, 1000);
          return false;
        }
        
        // Wait sebelum retry
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        continue;
      }
      
      // Untuk error lainnya, throw langsung
      throw error;
    }
  }
  return false;
};

const initializeClient = () => {
  try {
    if (client) {
      try {
        client.destroy();
        console.log('🔄 Previous client destroyed');
      } catch (e) {
        console.log('🔄 Cleaning up previous client...');
      }
      client = null;
    }

    client = new Client({
      authStrategy: new LocalAuth({
        clientId: "whatsapp-bot",
        dataPath: DB_PATH
      }),
      puppeteer: puppeteerOptions,
      webVersionCache: {
        type: 'remote',
        remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html`,
      },
      takeoverOnConflict: true,
      takeoverTimeoutMs: 30000,
      qrMaxRetries: 10,
      restartOnAuthFail: true
    });

    client.on("qr", (qr) => {
      currentQR = qr;
      isReady = false;
      console.log("📲 QR code siap discan.");
      qrcode.generate(qr, { small: true });
    });

    client.on("ready", () => {
      isReady = true;
      currentQR = null;
      restartCount = 0; // Reset restart count on successful ready
      console.log("✅ WhatsApp berhasil terhubung.");
    });

    client.on("authenticated", () => {
      console.log("🔐 Authentication successful");
      isReady = false; // Wait for ready event
    });

    client.on("auth_failure", (msg) => {
      console.error("❌ Authentication failure:", msg);
      isReady = false;
      setTimeout(restartClient, RESTART_DELAY);
    });

    client.on("disconnected", (reason) => {
      console.log("❌ WhatsApp disconnected:", reason);
      isReady = false;
      setTimeout(restartClient, RESTART_DELAY);
    });

    // 🔧 FIX: Enhanced error handlers
    client.on("change_state", (state) => {
      console.log("🔁 State changed:", state);
    });

    client.on("loading_screen", (percent, message) => {
      console.log(`🔄 Loading: ${percent}% ${message || ''}`);
    });

    client.on("remote_session_saved", () => {
      console.log("💾 Remote session saved");
    });

    // 🔧 NEW: Page error handlers
    client.on("call", (call) => {
      console.log("📞 Incoming call from:", call.from);
    });

    // Initialize WhatsApp client
    client.initialize().catch(error => {
      console.error('❌ Failed to initialize client:', error);
      setTimeout(restartClient, RESTART_DELAY);
    });

  } catch (error) {
    console.error('❌ Error creating client:', error);
    setTimeout(restartClient, RESTART_DELAY);
  }
};

const restartClient = () => {
  if (restartCount >= MAX_RESTARTS) {
    console.error(`❌ Maximum restart attempts (${MAX_RESTARTS}) reached. Giving up.`);
    return;
  }

  restartCount++;
  console.log(`🔄 Restarting WhatsApp client... (Attempt ${restartCount}/${MAX_RESTARTS})`);
  
  setTimeout(() => {
    initializeClient();
  }, RESTART_DELAY);
};

// Start the client
initializeClient();

// Express setup untuk QR code
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
          .restart-info {
            margin-top: 10px;
            padding: 10px;
            background: #fff3cd;
            border: 1px solid #ffeaa7;
            border-radius: 5px;
            font-size: 0.8rem;
            color: #856404;
          }
        </style>
      </head>
      <body>
        <h1>Scan QR WhatsApp</h1>
        <img src="${qrImage}" alt="QR Code WhatsApp" />
        <p>Silakan scan dengan aplikasi WhatsApp kamu.</p>
        <p class="small">⏳ Halaman ini auto-refresh setiap 15 detik</p>
        <div class="restart-info">
          🔄 Restart count: ${restartCount}/${MAX_RESTARTS}
        </div>
      </body>
    </html>
  `);
});

const PORT = 3025;
app.listen(PORT, () => {
  console.log(`🌐 Akses QR di browser: http://localhost:${PORT}/qr`);
});

// 🔧 FIX: Enhanced message handler dengan better session management dan error handling
client.on("message", async (msg) => {
  // Skip if message is from status broadcast
  if (msg.from === 'status@broadcast') return;
  
  const sender = msg.from;
  const body = msg.body.trim();
  const session = sessions.get(sender);
  const number = sender.split("@")[0];
  
  // Update session activity
  if (session) {
    session.lastActivity = Date.now();
  }
  
  // Tambahkan try-catch di level tertinggi
  try {
    if (body === "!cancel") {
      if (session) {
        sessions.delete(sender);
        await sendMessageWithRetry(sender, "✅ Sesi saat ini dibatalkan.");
        return;
      } else {
        await sendMessageWithRetry(sender, "❌ Tidak ada sesi yang aktif untuk dibatalkan.");
        return;
      }
    }

    if (body === "!addreminder") {
      if (!isAdmin(sender)) {
        await sendMessageWithRetry(sender, "❌ Anda bukan admin. Akses ditolak.");
        return;
      }

      const contactList = Array.from(contacts.values());
      if (contactList.length === 0) {
        await sendMessageWithRetry(sender, "❌ Tidak ada kontak tersedia. Tambah kontak dulu dengan !addkontak");
        return;
      }

      const list = contactList.map((c, i) => `${i + 1}. ${c.name}`).join("\n");

      sessions.set(sender, { step: "add-1", contactList, lastActivity: Date.now() });
      await sendMessageWithRetry(sender, `📇 Kontak tersedia:\n${list}\n\nKetik nomor kontak (misal: 1):`);
      return;
    }

    if (session?.step === "add-1") {
      const index = parseInt(body);
      const contact = session.contactList?.[index - 1];

      if (!contact) {
        await sendMessageWithRetry(sender, "❌ Nomor kontak tidak valid.");
        return;
      }

      session.kontak = contact;

      const templates = await loadTemplates();
      session.templateOptions = templates;
      session.step = "add-2";
      session.lastActivity = Date.now();

      const list = templates.map((t, i) => `${i + 1}. ${t.name}`).join("\n");

      const fullList = `📄 Pilih Template atau Custom:\n${list}\n${
        templates.length + 1
      }. ✏️ Ketik manual (Custom)\n\nKetik angka pilihan:`;
      await sendMessageWithRetry(sender, fullList);
      return;
    }

    if (session?.step === "add-2") {
      const idx = parseInt(body);
      const templates = session.templateOptions;

      if (idx >= 1 && idx <= templates.length) {
        session.template = templates[idx - 1].content;
        session.step = "add-4";
        session.lastActivity = Date.now();
        await sendMessageWithRetry(sender, "📅 Ketik tanggal & jam (format: YYYY-MM-DD HH:mm):");
        return;
      }

      if (idx === templates.length + 1) {
        session.step = "add-3-custom";
        session.lastActivity = Date.now();
        await sendMessageWithRetry(sender, "✏️ Ketik pesan custom Anda:");
        return;
      }

      await sendMessageWithRetry(sender, "❌ Pilihan tidak valid. Ketik angka yang tersedia.");
      return;
    }

    if (session?.step === "add-3-custom") {
      session.template = body;
      session.step = "add-4";
      session.lastActivity = Date.now();
      await sendMessageWithRetry(sender, "📅 Ketik tanggal & jam (format: YYYY-MM-DD HH:mm):");
      return;
    }

    if (session?.step === "add-4") {
      const [tanggal, jam] = body.split(" ");
      const dt = new Date(`${tanggal}T${jam}:00`);
      if (isNaN(dt.getTime())) {
        await sendMessageWithRetry(sender, "❌ Format waktu salah. Gunakan format: YYYY-MM-DD HH:mm");
        return;
      }

      // Validasi tanggal tidak di masa lalu
      if (dt < new Date()) {
        await sendMessageWithRetry(sender, "❌ Tanggal tidak boleh di masa lalu.");
        return;
      }

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

      try {
        reminders.set(reminder.id, reminder);
        await saveMapToFile(reminders, remindersPath);
        sessions.delete(sender);

        await sendMessageWithRetry(sender, `✅ Reminder disimpan untuk ${kontak.name} pada ${tanggal} ${jam}`);
      } catch (error) {
        console.error('❌ Error saving reminder:', error);
        await sendMessageWithRetry(sender, "❌ Gagal menyimpan reminder. Coba lagi.");
      }
      return;
    }

    if (body === "!editreminder") {
      if (!isAdmin(sender)) {
        await sendMessageWithRetry(sender, "❌ Anda bukan admin.");
        return;
      }

      const sorted = Array.from(reminders.values()).sort(
        (a, b) => new Date(a.reminderDateTime) - new Date(b.reminderDateTime)
      );

      if (sorted.length === 0) {
        await sendMessageWithRetry(sender, "📭 Tidak ada reminder yang bisa diedit.");
        return;
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
        lastActivity: Date.now()
      });

      await sendMessageWithRetry(sender, `✏️ Pilih reminder yang ingin diedit:\n${list}\n\nKetik nomor:`);
      return;
    }

    if (session?.step === "edit-reminder-select") {
      const index = parseInt(body);
      const selected = session.list?.[index - 1];
      if (!selected) {
        await sendMessageWithRetry(sender, "❌ Nomor tidak valid.");
        return;
      }

      session.selectedReminder = selected;
      session.step = "edit-reminder-tanggal";
      session.lastActivity = Date.now();

      await sendMessageWithRetry(sender, "📅 Masukkan tanggal & jam baru (format: YYYY-MM-DD HH:mm):");
      return;
    }

    if (session?.step === "edit-reminder-tanggal") {
      const [tanggal, jam] = body.split(" ");
      const dt = new Date(`${tanggal}T${jam}:00`);
      if (isNaN(dt.getTime())) {
        await sendMessageWithRetry(sender, "❌ Format waktu salah. Gunakan format: YYYY-MM-DD HH:mm");
        return;
      }

      // Validasi tanggal tidak di masa lalu
      if (dt < new Date()) {
        await sendMessageWithRetry(sender, "❌ Tanggal tidak boleh di masa lalu.");
        return;
      }

      session.newDate = dt;
      session.step = "edit-reminder-pesan";
      session.lastActivity = Date.now();
      await sendMessageWithRetry(sender, "📩 Ganti isi pesan?\n1. Pakai template\n2. Ketik manual\n3. Tidak usah ganti\n\nKetik 1 / 2 / 3:");
      return;
    }

    if (session?.step === "edit-reminder-pesan") {
      if (body === "1") {
        const templates = await loadTemplates();
        session.templateOptions = templates;
        session.step = "edit-reminder-template";
        session.lastActivity = Date.now();

        const list = templates.map((t, i) => `${i + 1}. ${t.name}`).join("\n");
        await sendMessageWithRetry(sender, `📄 Pilih Template:\n${list}\n\nKetik nomor:`);
        return;
      }

      if (body === "2") {
        session.step = "edit-reminder-custom";
        session.lastActivity = Date.now();
        await sendMessageWithRetry(sender, "✏️ Ketik pesan baru:");
        return;
      }

      if (body === "3") {
        const reminder = session.selectedReminder;
        reminder.reminderDateTime = session.newDate;

        try {
          reminders.set(reminder.id, reminder);
          await saveMapToFile(reminders, remindersPath);
          sessions.delete(sender);

          await sendMessageWithRetry(sender, `✅ Reminder berhasil diperbarui ke ${session.newDate.toLocaleString("id-ID")}`);
        } catch (error) {
          console.error('❌ Error saving reminder:', error);
          await sendMessageWithRetry(sender, "❌ Gagal memperbarui reminder. Coba lagi.");
        }
        return;
      }

      await sendMessageWithRetry(sender, "❌ Pilih 1 / 2 / 3 sesuai opsi.");
      return;
    }

    if (session?.step === "edit-reminder-template") {
      const idx = parseInt(body);
      const selected = session.templateOptions?.[idx - 1];
      if (!selected) {
        await sendMessageWithRetry(sender, "❌ Template tidak ditemukan.");
        return;
      }

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

      try {
        reminders.set(reminder.id, reminder);
        await saveMapToFile(reminders, remindersPath);
        sessions.delete(sender);

        await sendMessageWithRetry(sender, "✅ Reminder berhasil diperbarui dengan pesan dari template.");
      } catch (error) {
        console.error('❌ Error saving reminder:', error);
        await sendMessageWithRetry(sender, "❌ Gagal memperbarui reminder. Coba lagi.");
      }
      return;
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

      try {
        reminders.set(reminder.id, reminder);
        await saveMapToFile(reminders, remindersPath);
        sessions.delete(sender);

        await sendMessageWithRetry(sender, "✅ Reminder berhasil diperbarui dengan pesan custom.");
      } catch (error) {
        console.error('❌ Error saving reminder:', error);
        await sendMessageWithRetry(sender, "❌ Gagal memperbarui reminder. Coba lagi.");
      }
      return;
    }

    if (body === "!deletereminder") {
      if (!isAdmin(sender)) {
        await sendMessageWithRetry(sender, "❌ Anda bukan admin.");
        return;
      }

      const sorted = Array.from(reminders.values()).sort(
        (a, b) => new Date(a.reminderDateTime) - new Date(b.reminderDateTime)
      );

      if (sorted.length === 0) {
        await sendMessageWithRetry(sender, "📭 Tidak ada reminder yang aktif.");
        return;
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
        lastActivity: Date.now()
      });

      await sendMessageWithRetry(sender, `🗑️ Reminder yang tersedia:\n${list}\n\nKetik nomor reminder yang ingin dihapus:`);
      return;
    }

    if (session?.step === "delete-reminder-select") {
      const index = parseInt(body);
      const selected = session.list?.[index - 1];
      if (!selected) {
        await sendMessageWithRetry(sender, "❌ Nomor tidak valid.");
        return;
      }

      try {
        reminders.delete(selected.id);
        await saveMapToFile(reminders, remindersPath);
        sessions.delete(sender);

        await sendMessageWithRetry(sender, `✅ Reminder berhasil dihapus:\n${selected.message}`);
      } catch (error) {
        console.error('❌ Error deleting reminder:', error);
        await sendMessageWithRetry(sender, "❌ Gagal menghapus reminder. Coba lagi.");
      }
      return;
    }

    if (body === "!listreminder") {
      if (!isAdmin(sender)) {
        await sendMessageWithRetry(sender, "❌ Anda bukan admin.");
        return;
      }

      const sorted = Array.from(reminders.values()).sort(
        (a, b) => new Date(a.reminderDateTime) - new Date(b.reminderDateTime)
      );

      if (sorted.length === 0) {
        await sendMessageWithRetry(sender, "📭 Belum ada reminder yang aktif.");
        return;
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

      await sendMessageWithRetry(sender, `📌 Reminder Aktif (urut tanggal):\n\n${list}`);
      return;
    }

    if (body === "!addkontak") {
      if (!isAdmin(sender)) {
        await sendMessageWithRetry(sender, "❌ Anda bukan admin.");
        return;
      }

      sessions.set(sender, { step: "add-kontak-nama", lastActivity: Date.now() });
      await sendMessageWithRetry(sender, "📝 Masukkan nama kontak:");
      return;
    }

    if (session?.step === "add-kontak-nama") {
      session.nama = body;
      session.step = "add-kontak-nomor";
      session.lastActivity = Date.now();
      await sendMessageWithRetry(sender, "📞 Masukkan nomor HP (format 628xxx):");
      return;
    }

    if (session?.step === "add-kontak-nomor") {
      const nomor = body.replace(/[^0-9]/g, "");
      if (!/^628\d{7,13}$/.test(nomor)) {
        await sendMessageWithRetry(sender, "❌ Nomor tidak valid! Format: 628xxxx");
        return;
      }

      const newKontak = {
        id: Date.now(),
        name: session.nama,
        phoneNumber: nomor,
      };

      try {
        contacts.set(newKontak.id, newKontak);
        await saveMapToFile(contacts, contactsPath);
        sessions.delete(sender);

        await sendMessageWithRetry(sender, `✅ Kontak berhasil ditambahkan:\n${newKontak.name} | ${newKontak.phoneNumber}`);
      } catch (error) {
        console.error('❌ Error saving contact:', error);
        await sendMessageWithRetry(sender, "❌ Gagal menambahkan kontak. Coba lagi.");
      }
      return;
    }

    if (body === "!editkontak") {
      if (!isAdmin(sender)) {
        await sendMessageWithRetry(sender, "❌ Anda bukan admin.");
        return;
      }

      const sorted = Array.from(contacts.values()).sort((a, b) =>
        a.name.localeCompare(b.name)
      );

      if (sorted.length === 0) {
        await sendMessageWithRetry(sender, "📭 Tidak ada kontak untuk diedit.");
        return;
      }

      const list = sorted
        .map((c, i) => `${i + 1}. ${c.name} | ${c.phoneNumber}`)
        .join("\n");

      sessions.set(sender, {
        step: "edit-kontak-select",
        list: sorted,
        lastActivity: Date.now()
      });

      await sendMessageWithRetry(sender, `✏️ Kontak tersedia:\n${list}\n\nKetik nomor kontak yang ingin diedit:`);
      return;
    }

    if (session?.step === "edit-kontak-select") {
      const index = parseInt(body);
      const selected = session.list?.[index - 1];
      if (!selected) {
        await sendMessageWithRetry(sender, "❌ Nomor tidak valid.");
        return;
      }

      session.kontak = {
        id: selected.id,
        name: selected.name,
        phoneNumber: selected.phoneNumber,
      };

      session.step = "edit-kontak-nama";
      session.lastActivity = Date.now();
      await sendMessageWithRetry(sender, `✏️ Nama saat ini: ${selected.name}\nMasukkan nama baru:`);
      return;
    }

    if (session?.step === "edit-kontak-nama") {
      session.newName = body;
      session.step = "edit-kontak-nomor";
      session.lastActivity = Date.now();
      await sendMessageWithRetry(sender, `📞 Masukkan nomor HP baru (format: 628xxx):`);
      return;
    }

    if (session?.step === "edit-kontak-nomor") {
      const nomor = body.replace(/[^0-9]/g, "");
      if (!/^628\d{7,13}$/.test(nomor)) {
        await sendMessageWithRetry(sender, "❌ Nomor tidak valid! Format: 628xxxx");
        return;
      }

      const kontak = session.kontak;

      if (!kontak?.id) {
        sessions.delete(sender);
        await sendMessageWithRetry(sender, "❌ Error: ID kontak tidak ditemukan. Coba tambah ulang kontak.");
        return;
      }

      if (!(contacts instanceof Map)) {
        await sendMessageWithRetry(sender, "❌ Error internal: data kontak rusak (bukan Map). Restart bot.");
        return;
      }

      kontak.name = session.newName;
      kontak.phoneNumber = nomor;

      try {
        contacts.set(kontak.id, kontak);
        await saveMapToFile(contacts, contactsPath);
        sessions.delete(sender);

        await sendMessageWithRetry(sender, `✅ Kontak berhasil diperbarui:\n${kontak.name} | ${kontak.phoneNumber}`);
      } catch (error) {
        console.error('❌ Error saving contact:', error);
        await sendMessageWithRetry(sender, "❌ Gagal memperbarui kontak. Coba lagi.");
      }
      return;
    }

    if (body === "!deletekontak") {
      if (!isAdmin(sender)) {
        await sendMessageWithRetry(sender, "❌ Anda bukan admin.");
        return;
      }

      const sorted = Array.from(contacts.values()).sort((a, b) =>
        a.name.localeCompare(b.name)
      );

      if (sorted.length === 0) {
        await sendMessageWithRetry(sender, "📭 Tidak ada kontak untuk dihapus.");
        return;
      }

      const list = sorted
        .map((c, i) => `${i + 1}. ${c.name} | ${c.phoneNumber}`)
        .join("\n");

      sessions.set(sender, {
        step: "delete-kontak-select",
        list: sorted,
        lastActivity: Date.now()
      });

      await sendMessageWithRetry(sender, `🗑️ Kontak tersedia:\n${list}\n\nKetik nomor kontak yang ingin dihapus:`);
      return;
    }

    if (session?.step === "delete-kontak-select") {
      const index = parseInt(body);
      const selected = session.list?.[index - 1];
      if (!selected) {
        await sendMessageWithRetry(sender, "❌ Nomor tidak valid.");
        return;
      }

      try {
        contacts.delete(selected.id);
        await saveMapToFile(contacts, contactsPath);
        sessions.delete(sender);

        await sendMessageWithRetry(sender, `✅ Kontak '${selected.name}' berhasil dihapus.`);
      } catch (error) {
        console.error('❌ Error deleting contact:', error);
        await sendMessageWithRetry(sender, "❌ Gagal menghapus kontak. Coba lagi.");
      }
      return;
    }

    if (body === "!listkontak") {
      if (!isAdmin(sender)) {
        await sendMessageWithRetry(sender, "❌ Anda bukan admin.");
        return;
      }

      const sorted = Array.from(contacts.values()).sort((a, b) =>
        a.name.localeCompare(b.name)
      );

      if (sorted.length === 0) {
        await sendMessageWithRetry(sender, "📭 Belum ada kontak.");
        return;
      }

      const list = sorted
        .map((c, i) => `${i + 1}. ${c.name}\n   📞 ${c.phoneNumber}`)
        .join("\n\n");

      await sendMessageWithRetry(sender, `📇 Daftar Kontak (A–Z):\n\n${list}`);
      return;
    }

    // ADMIN add role
    if (body.startsWith("!setadmin ") && isAdmin(sender)) {
      const newAdminNumber = body.split(" ")[1].replace(/[^0-9]/g, "");
      
      try {
        roles.set(newAdminNumber, "admin");
        await saveRolesToFile();
        await sendMessageWithRetry(sender, `✅ ${newAdminNumber} sekarang menjadi admin.`);
      } catch (error) {
        console.error('❌ Error setting admin:', error);
        await sendMessageWithRetry(sender, "❌ Gagal menambahkan admin. Coba lagi.");
      }
      return;
    }

    // ===== HELP & MENU =====
    if (body === "!help" || body === "!menu") {
      const umum = [
        "📖  *Menu Bantuan*",
        "",
        "• !help / !menu  – tampilkan bantuan",
        "• !cancel        – batalkan proses saat ini",
      ];

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

      await sendMessageWithRetry(sender, menuText);
      return;
    }
    // ===== END HELP =====

  } catch (error) {
    console.error('❌ Error in message handler:', error);
    try {
      await sendMessageWithRetry(sender, "❌ Terjadi error internal. Silakan coba lagi.");
    } catch (sendError) {
      console.error('❌ Even error message failed to send:', sendError);
    }
  }
});

// 🔧 FIX: Enhanced cron job dengan better error handling dan connection check
cron.schedule("*/1 * * * *", async () => {
  if (!isReady) {
    console.log('⏳ Skip cron job - WhatsApp not ready');
    return;
  }

  try {
    const now = Date.now();
    const due = Array.from(reminders.entries()).filter(
      ([, r]) => new Date(r.reminderDateTime).getTime() <= now
    );

    if (due.length > 0) {
      console.log(`⏰ Processing ${due.length} due reminders...`);
    }

    for (const [id, reminder] of due) {
      try {
        // Use enhanced message sender with retry
        const success = await sendMessageWithRetry(
          `${reminder.phoneNumber}@c.us`,
          reminder.message
        );

        if (!success) {
          console.log(`⏳ Skipping reminder ${id} due to connection issues`);
          continue;
        }

        console.log("📤 Reminder terkirim:", reminder.phoneNumber);

        // Kirim salinan ke semua admin
        for (const [nomor, role] of roles.entries()) {
          if (role === "admin") {
            const jid = `${nomor}@c.us`;
            if (jid !== `${reminder.phoneNumber}@c.us`) {
              await sendMessageWithRetry(
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
        console.error("❌ Gagal proses reminder:", err.message);
        
        // If it's a connection error, trigger restart
        if (err.message.includes('closed') || err.message.includes('disconnected') || err.message.includes('Protocol error')) {
          console.log('🔁 Connection error detected in cron, triggering restart...');
          restartClient();
          break;
        }
      }
    }

    // 🔧 FIX: Save dengan error handling
    if (due.length > 0) {
      try {
        await saveMapToFile(reminders, remindersPath);
        await saveMapToFile(sentReminders, sentRemindersPath);
        console.log('✅ Reminders saved after cron execution');
      } catch (error) {
        console.error('❌ Error saving reminders in cron:', error);
      }
    }
  } catch (error) {
    console.error('❌ Critical error in cron job:', error);
  }
});

// Handle process exit untuk save data terakhir
process.on('SIGINT', async () => {
  console.log('\n🔄 Menyimpan data sebelum shutdown...');
  try {
    await autoSave();
    console.log('✅ Data berhasil disimpan. Shutdown...');
    process.exit(0);
  } catch (error) {
    console.error('❌ Gagal menyimpan data sebelum shutdown:', error);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  console.log('\n🔄 Menyimpan data sebelum termination...');
  try {
    await autoSave();
    console.log('✅ Data berhasil disimpan. Termination...');
    process.exit(0);
  } catch (error) {
    console.error('❌ Gagal menyimpan data sebelum termination:', error);
    process.exit(1);
  }
});

process.on('uncaughtException', async (error) => {
  console.error('❌ Uncaught Exception:', error);
  try {
    await autoSave();
  } catch (saveError) {
    console.error('❌ Gagal emergency save:', saveError);
  }
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

process.on('unhandledRejection', async (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  try {
    await autoSave();
  } catch (saveError) {
    console.error('❌ Gagal emergency save:', saveError);
  }
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

// Session cleanup setiap 1 jam untuk mencegah memory leak
setInterval(() => {
  const now = Date.now();
  const oneHourAgo = now - (60 * 60 * 1000);
  
  for (const [sender, session] of sessions.entries()) {
    if (session.lastActivity && session.lastActivity < oneHourAgo) {
      sessions.delete(sender);
      console.log(`🧹 Cleaned up stale session for ${sender}`);
    }
  }
}, 60 * 60 * 1000);

// 🔧 NEW: Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: isReady ? "connected" : "disconnected",
    ready: isReady,
    qr_available: !!currentQR,
    restart_count: restartCount,
    sessions: sessions.size,
    contacts: contacts.size,
    reminders: reminders.size,
    roles: roles.size,
    timestamp: new Date().toISOString()
  });
});

console.log('🚀 WhatsApp Bot started with enhanced connection handling');
