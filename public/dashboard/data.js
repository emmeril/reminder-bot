function createDashboardData() {
  return {
        async refreshAll() {
          await this.withProcessing("Memuat ulang data...", async () => {
            await this.loadStatus();
            await Promise.all([
              this.loadContacts(),
              this.loadReminders(),
              this.loadTemplates(),
            ]);
            await this.loadNonCriticalData();
          });
        },

        async loadStatus(options = {}) {
          this.loading.status = true;
          try {
            const data = await this.api("/api/status", { silent: Boolean(options.silent) });
            this.billingPeriod = data.billingPeriod || this.billingPeriod;
            if (!this.revenueDateFrom && this.billingPeriod) this.revenueDateFrom = `${this.billingPeriod}-01`;
            if (!this.revenueDateTo) this.revenueDateTo = this.formatDateInput(new Date());
            this.statusCards = [
              { label: `WhatsApp ${data.bot.selectedProvider || "Provider"}`, value: data.bot.deviceReady ? "Ready" : "Not ready", icon: data.bot.deviceReady ? "fa-solid fa-plug-circle-check" : "fa-solid fa-plug-circle-xmark" },
              { label: "Telegram", value: data.bot.telegramEnabled ? "Ready" : "Not ready", icon: "fa-brands fa-telegram" },
            ];
            this.summaryMetrics = [
              { label: "Pelanggan", value: data.summary.contacts, icon: "fa-solid fa-users", tone: "blue", menu: "contacts" },
              { label: "Layanan aktif", value: data.summary.activeServices || 0, icon: "fa-solid fa-wifi", tone: "green", menu: "hotspot-accounts" },
              { label: "Layanan perlu dicek", value: data.summary.serviceAttention || 0, icon: "fa-solid fa-screwdriver-wrench", tone: "amber", menu: "hotspot-accounts" },
              { label: "Reminder aktif", value: data.summary.reminders, icon: "fa-solid fa-calendar-check", tone: "violet", menu: "reminders" },
              { label: "Pesan hari ini", value: data.summary.sentToday || 0, icon: "fa-solid fa-paper-plane", tone: "cyan", menu: "history" },
              { label: "Lunas / paket aktif", value: data.summary.paidContacts, icon: "fa-solid fa-circle-check", tone: "green", menu: "payment-amount" },
              { label: "Perlu pembayaran", value: data.summary.unpaidContacts, icon: "fa-solid fa-clock", tone: "amber", menu: "payment-amount" },
              { label: "Memiliki tunggakan", value: data.summary.debtContacts || 0, icon: "fa-solid fa-file-invoice-dollar", tone: "red", menu: "payment-amount" },
            ];
            this.updateApSummaryMetrics();
            if (!this.settingsDirty) {
              this.forms.settings = {
                dashboardTitle: data.settings.dashboardTitle || "",
                companyName: data.settings.companyName || "",
                supportSignature: data.settings.supportSignature || "",
                apDownMessageTemplate: data.settings.apDownMessageTemplate || "",
                customerAccountMessageTemplate: data.settings.customerAccountMessageTemplate || "",
                prepaidPackagePaymentMessageTemplate: data.settings.prepaidPackagePaymentMessageTemplate || "",
                paymentHotspotAccountMessageTemplate: data.settings.paymentHotspotAccountMessageTemplate || "",
                prepaidPackageReminderMessageTemplate: data.settings.prepaidPackageReminderMessageTemplate || "",
                timezone: data.settings.timezone || "",
                hotspotIsolationGraceDays: Number(data.settings.hotspotIsolationGraceDays ?? 0),
                autoRescheduleMonthly: Boolean(data.settings.autoRescheduleMonthly),
                notifyContactsOnApDown: data.settings.notifyContactsOnApDown !== false,
                notifyAdminsOnDelivery: Boolean(data.settings.notifyAdminsOnDelivery),
                notifyAdminsOnConnectionChange: Boolean(data.settings.notifyAdminsOnConnectionChange),
                notifyAdminsOnPaymentReset: Boolean(data.settings.notifyAdminsOnPaymentReset),
                waRandomDelayMinSeconds: Number(data.settings.waRandomDelayMinSeconds ?? 2),
                waRandomDelayMaxSeconds: Number(data.settings.waRandomDelayMaxSeconds ?? 5),
                enableMikrotikBackupToWa: Boolean(data.settings.enableMikrotikBackupToWa),
                mikrotikBackupTime: data.settings.mikrotikBackupTime || "02:00",
                mikrotikBackupTimezone: data.settings.mikrotikBackupTimezone || data.settings.timezone || "Asia/Jakarta",
                profileMonthlyAmounts: { ...(data.settings.profileMonthlyAmounts || {}) },
              };
              this.syncProfileMonthlyAmountFields();
            }
          } finally {
            this.loading.status = false;
          }
        },

        async loadContacts(options = {}) {
          this.contacts = await this.api("/api/contacts", { silent: Boolean(options.silent) });
          this.clampPage("contacts", this.filteredContacts.length);
          this.clampPage("contactBilling", this.filteredBillingContacts.length);
          this.clampPage("contactHotspot", this.filteredHotspotContacts.length);
        },

        async saveContactPaymentAmount(contact) {
          if (!contact?.id) return;
          const amount = Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0));
          await this.withProcessing(`Menyimpan nominal ${contact.name}...`, async () => {
            const updated = await this.api(`/api/contacts/${contact.id}/payment-amount`, {
              method: "POST",
              body: JSON.stringify({ monthlyPaymentAmount: amount }),
            });
            const index = this.contacts.findIndex((item) => String(item.id) === String(contact.id));
            if (index >= 0) this.contacts.splice(index, 1, updated);
            this.notify(`Nominal ${contact.name} disimpan.`);
            await this.loadReminders();
          });
        },

        async resetContactPaymentAmount(contact) {
          if (!contact?.id || !this.hasProfileMonthlyAmount(contact)) return;
          await this.withProcessing(`Mengembalikan nominal ${contact.name}...`, async () => {
            const updated = await this.api(`/api/contacts/${contact.id}/payment-amount`, {
              method: "POST",
              body: JSON.stringify({ useProfileDefault: true }),
            });
            const index = this.contacts.findIndex((item) => String(item.id) === String(contact.id));
            if (index >= 0) this.contacts.splice(index, 1, updated);
            this.notify(`Nominal ${contact.name} kembali mengikuti tarif profile.`);
            await this.loadReminders();
          });
        },

        exportPaymentRecap() {
          const link = document.createElement("a");
          link.href = "/api/payments/export.xlsx";
          link.download = "rekap-pembayaran.xlsx";
          document.body.appendChild(link);
          link.click();
          link.remove();
          this.notify("Rekap pembayaran sedang diunduh dalam format Excel.");
        },

        async loadMikrotikProfiles(options = {}) {
          this.mikrotikProfiles = await this.api("/api/mikrotik/profiles", { silent: Boolean(options.silent) });
          this.syncProfileMonthlyAmountFields();
          if (!options.silent) this.notify(`${this.mikrotikProfiles.length} profile MikroTik dimuat.`);
        },

        async loadVoucherServers(options = {}) {
          this.mikrotikServers = await this.api("/api/mikrotik/hotspot-servers", { silent: Boolean(options.silent) });
          if (!options.silent) this.notify(`${this.mikrotikServers.length} server hotspot dimuat.`);
        },

        async loadVoucherOptions(options = {}) {
          if (this.loading.voucherOptions) return;
          this.loading.voucherOptions = true;
          try {
            const results = await Promise.allSettled([
              this.loadVoucherProfiles({ silent: true }),
              this.loadVoucherServers({ silent: true }),
            ]);
            const failed = results.find((item) => item.status === "rejected");
            if (failed) throw failed.reason;
            const readyProfiles = this.voucherProfiles.filter((profile) => profile.voucherReady);
            if (!readyProfiles.some((profile) => profile.name === this.forms.voucher.profile)) {
              this.forms.voucher.profile = readyProfiles[0]?.name || "";
            }
            if (this.forms.voucher.server !== "all"
              && !this.mikrotikServers.includes(this.forms.voucher.server)) {
              this.forms.voucher.server = "all";
            }
            if (!options.silent) {
              this.notify(`${readyProfiles.length} profile voucher siap dan ${this.mikrotikServers.length} server hotspot dimuat.`);
            }
          } catch (error) {
            this.setFormError("voucher", error);
            if (!options.silent) this.notify(error.message || "Data voucher gagal dimuat.");
          } finally {
            this.loading.voucherOptions = false;
          }
        },

        async openVoucherCreateModal(trigger = null) {
          this.voucherCreateModal.returnFocusId = trigger?.id || "voucher-create-button";
          this.clearFormError("voucher");
          this.voucherCreateModal.open = true;
          if (!this.voucherProfiles.length || !this.mikrotikServers.length) {
            await this.loadVoucherOptions({ silent: true });
          }
          this.$nextTick(() => document.getElementById("voucher-create-dialog")?.querySelector("input, select")?.focus());
        },

        closeVoucherCreateModal() {
          if (!this.voucherCreateModal.open) return;
          this.voucherCreateModal.open = false;
          this.$nextTick(() => document.getElementById(this.voucherCreateModal.returnFocusId)?.focus());
        },

        async openVoucherProfileModal(trigger = null) {
          this.voucherProfileModal.returnFocusId = trigger?.id || "voucher-profile-button";
          this.clearFormError("voucherProfile");
          this.voucherProfileModal.open = true;
          if (!this.voucherProfiles.length) await this.loadVoucherOptions({ silent: true });
          this.$nextTick(() => document.getElementById("voucher-profile-dialog")?.focus());
        },

        closeVoucherProfileModal() {
          if (!this.voucherProfileModal.open) return;
          this.voucherProfileModal.open = false;
          this.resetVoucherProfileForm();
          this.$nextTick(() => document.getElementById(this.voucherProfileModal.returnFocusId)?.focus());
        },

        async loadVoucherProfiles(options = {}) {
          const data = await this.api("/api/mikrotik/voucher-profiles", { silent: Boolean(options.silent) });
          this.voucherProfiles = Array.isArray(data?.profiles) ? data.profiles : [];
          this.voucherPools = Array.isArray(data?.pools) ? data.pools : [];
          this.voucherParentQueues = Array.isArray(data?.parentQueues) ? data.parentQueues : [];
          this.voucherExpiryModes = Array.isArray(data?.expiryModes) ? data.expiryModes : [];
          if (!options.silent) this.notify(`${this.voucherProfiles.length} profile hotspot diperiksa.`);
        },

        resetVoucherProfileForm() {
          this.forms.voucherProfile = {
            originalName: "",
            name: "",
            sharedUsers: 1,
            rateLimit: "",
            addressPool: "none",
            parentQueue: "none",
            expiredMode: "rem",
            validity: "1d",
            costPrice: 0,
            sellingPrice: 0,
            commission: 0,
            lockUser: false,
          };
          this.clearFormError("voucherProfile");
        },

        updateVoucherProfileProfit() {
          const form = this.forms.voucherProfile;
          const costPrice = Math.max(0, Number(form.costPrice) || 0);
          const sellingPrice = Math.max(0, Number(form.sellingPrice) || 0);
          form.commission = Math.max(0, sellingPrice - costPrice);
        },

        editVoucherProfile(profile) {
          this.forms.voucherProfile = {
            originalName: profile.name,
            name: profile.name,
            sharedUsers: Number(profile.sharedUsers || 1),
            rateLimit: profile.rateLimit || "",
            addressPool: profile.addressPool || "none",
            parentQueue: profile.parentQueue || "none",
            expiredMode: profile.expiredMode === "0" ? "rem" : profile.expiredMode,
            validity: profile.validity || "1d",
            costPrice: Number(profile.costPrice || 0),
            sellingPrice: Number(profile.sellingPrice || 0),
            commission: Number(profile.commission || 0),
            lockUser: Boolean(profile.lockUser),
          };
          this.updateVoucherProfileProfit();
          this.clearFormError("voucherProfile");
          document.getElementById("voucher-profile-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
        },

        async saveVoucherProfile() {
          this.clearFormError("voucherProfile");
          this.updateVoucherProfileProfit();
          const form = this.forms.voucherProfile;
          try {
            await this.withProcessing(`${form.originalName ? "Memperbarui" : "Membuat"} profile voucher...`, async () => {
              const saved = await this.api("/api/mikrotik/voucher-profiles", {
                method: "POST",
                body: JSON.stringify({
                  ...form,
                  sharedUsers: Number(form.sharedUsers || 1),
                  costPrice: Number(form.costPrice || 0),
                  sellingPrice: Number(form.sellingPrice || 0),
                  commission: Number(form.commission || 0),
                }),
              });
              await this.loadVoucherProfiles({ silent: true });
              this.forms.voucher.profile = saved.name;
              if (this.voucherProfileModal.open) this.closeVoucherProfileModal();
              else this.resetVoucherProfileForm();
              this.notify(`Profile ${saved.name} siap dipakai untuk voucher.`);
            });
          } catch (error) {
            this.setFormError("voucherProfile", error);
          }
        },

        async loadVoucherBatches(options = {}) {
          if (this.loading.voucherHistory) return;
          this.loading.voucherHistory = true;
          this.voucherHistoryError = "";
          try {
            const batches = await this.api("/api/mikrotik/voucher-batches?limit=all", {
              silent: Boolean(options.silent),
            });
            this.voucherBatches = Array.isArray(batches) ? batches : [];
            const preferredBatchId = options.batchId
              || this.selectedVoucherBatchId
              || "ALL";
            this.selectVoucherBatch(preferredBatchId);
            if (!options.silent) {
              this.notify(`${this.voucherBatches.length} batch voucher dimuat dari riwayat aplikasi.`);
            }
          } catch (error) {
            this.voucherHistoryError = error.message || "Riwayat voucher gagal dimuat.";
          } finally {
            this.loading.voucherHistory = false;
          }
        },

        async loadVoucherStats(options = {}) {
          if (this.loading.voucherStats) return;
          this.loading.voucherStats = true;
          this.voucherStatsError = "";
          try {
            const stats = await this.api("/api/mikrotik/voucher-stats", {
              silent: Boolean(options.silent),
            });
            this.voucherStats = {
              summary: {
                total: Number(stats?.summary?.total || 0),
                used: Number(stats?.summary?.used || 0),
                unused: Number(stats?.summary?.unused || 0),
              },
              profiles: Array.isArray(stats?.profiles) ? stats.profiles : [],
            };
            if (!options.silent) this.notify("Statistik voucher diperbarui dari MikroTik.");
          } catch (error) {
            this.voucherStatsError = error.message || "Statistik voucher gagal dimuat.";
          } finally {
            this.loading.voucherStats = false;
          }
        },

        selectVoucherBatch(batchId) {
          if (batchId === "ALL") {
            this.selectedVoucherBatchId = "ALL";
            this.voucherResult = null;
            return;
          }
          const selected = this.voucherBatches.find((batch) => batch.batchId === batchId) || null;
          this.selectedVoucherBatchId = selected?.batchId || "ALL";
          this.voucherResult = selected;
        },

        removeVoucher(voucher) {
          const batchId = voucher?.batchId || this.voucherResult?.batchId;
          const username = voucher?.username;
          if (!batchId || !username) return;
          const returnToAllBatches = this.selectedVoucherBatchId === "ALL";
          this.openDeleteConfirm({
            title: "Hapus voucher?",
            description: `Voucher "${username}" akan dihapus dari MikroTik dan riwayat batch. Jika voucher sedang digunakan, sesi hotspotnya akan diputus. Tindakan ini tidak bisa dibatalkan.`,
            confirmLabel: "Hapus voucher",
            processingMessage: `Menghapus voucher ${username}...`,
            action: async () => {
              const result = await this.api(
                `/api/mikrotik/voucher-batches/${encodeURIComponent(batchId)}/vouchers/${encodeURIComponent(username)}`,
                { method: "DELETE" }
              );
              await this.loadVoucherBatches({
                silent: true,
                batchId: returnToAllBatches ? "ALL" : (result.batchRemoved ? "ALL" : batchId),
              });
              await Promise.allSettled([
                this.loadHotspotUsers({ silent: true }),
                this.loadVoucherStats({ silent: true }),
              ]);
              this.notify(`Voucher ${username} berhasil dihapus.`);
            },
          });
        },

        resetVoucherDevice(voucher) {
          const batchId = voucher?.batchId || this.voucherResult?.batchId;
          const username = voucher?.username;
          const macAddress = this.getVoucherMacAddress(voucher);
          if (!batchId || !username || !macAddress) return;
          const returnToAllBatches = this.selectedVoucherBatchId === "ALL";
          this.openDeleteConfirm({
            title: "Reset perangkat voucher?",
            description: `MAC ${macAddress} pada voucher "${username}" akan dilepas. Sesi perangkat lama akan diputus, lalu voucher dapat digunakan pada perangkat baru. Masa berlaku dan riwayat pemakaian tidak berubah.`,
            confirmLabel: "Reset perangkat",
            processingMessage: `Mereset perangkat voucher ${username}...`,
            action: async () => {
              await this.api(
                `/api/mikrotik/voucher-batches/${encodeURIComponent(batchId)}/vouchers/${encodeURIComponent(username)}/reset-device`,
                { method: "POST" }
              );
              await this.loadVoucherBatches({
                silent: true,
                batchId: returnToAllBatches ? "ALL" : batchId,
              });
              await this.loadHotspotUsers({ silent: true }).catch(() => {});
              this.notify(`Perangkat voucher ${username} berhasil direset.`);
            },
          });
        },

        getVoucherBatchLabel(batch) {
          if (!batch) return "Batch voucher";
          const dateLabel = batch.createdAt ? this.formatDateTime(batch.createdAt) : batch.batchId;
          return `${dateLabel} · ${batch.quantity} voucher · ${batch.profile || "Tanpa profile"}`;
        },

        getVoucherSellingPrice(batch = this.voucherResult) {
          const storedPrice = Math.max(0, Number(batch?.sellingPrice) || 0);
          if (storedPrice > 0) return storedPrice;
          const profile = this.voucherProfiles.find((item) => item.name === batch?.profile);
          return Math.max(0, Number(profile?.sellingPrice || profile?.costPrice) || 0);
        },

        getVoucherPriceLabel(batch = this.voucherResult) {
          const price = this.getVoucherSellingPrice(batch);
          return price > 0 ? this.formatRupiah(price) : "Harga belum diatur";
        },

        getVoucherValidity(batch = this.voucherResult) {
          const storedValidity = String(batch?.validity || "").trim().toLowerCase();
          if (storedValidity) return storedValidity;
          const profile = this.voucherProfiles.find((item) => item.name === batch?.profile);
          return String(profile?.validity || "").trim().toLowerCase();
        },

        getVoucherValidityLabel(batch = this.voucherResult) {
          const validity = this.getVoucherValidity(batch);
          if (!validity) return "Belum diatur";
          const units = {
            w: "minggu",
            d: "hari",
            h: "jam",
            m: "menit",
            s: "detik",
          };
          const parts = Array.from(validity.matchAll(/(\d+)([wdhms])/g));
          if (!parts.length || parts.map((part) => part[0]).join("") !== validity) return validity;
          return parts.map(([, amount, unit]) => `${Number(amount)} ${units[unit]}`).join(" ");
        },

        getVoucherBatchForVoucher(voucher) {
          const batchId = String(voucher?.batchId || this.voucherResult?.batchId || "");
          return this.voucherBatches.find((batch) => String(batch.batchId) === batchId)
            || this.voucherResult
            || null;
        },

        getVoucherCardBatchLabel(voucher) {
          const batch = this.getVoucherBatchForVoucher(voucher);
          if (!batch) return "Batch tidak diketahui";
          if (batch.comment) return batch.comment;
          return batch.createdAt ? this.formatDateTime(batch.createdAt) : batch.batchId;
        },

        getVoucherMacAddress(voucher) {
          const macAddress = String(voucher?.macAddress || "").trim();
          return macAddress && macAddress !== "00:00:00:00:00:00" ? macAddress : "";
        },

        getVoucherDeviceLabel(voucher) {
          const macAddress = this.getVoucherMacAddress(voucher);
          if (macAddress) return macAddress;
          return this.getVoucherBatchForVoucher(voucher)?.lockUser ? "Belum terkunci" : "Tidak dikunci";
        },

        getVoucherUsageStatus(voucher) {
          const status = String(voucher?.usageStatus || "").toUpperCase();
          if (status === "USED" || voucher?.used) return "USED";
          if (status === "MISSING") return "MISSING";
          return "UNUSED";
        },

        getVoucherUsageLabel(voucher) {
          const status = this.getVoucherUsageStatus(voucher);
          if (status === "USED") return "Sudah digunakan";
          if (status === "MISSING") return "Tidak ditemukan di MikroTik";
          return "Belum digunakan";
        },

        getVoucherUsageIcon(voucher) {
          const status = this.getVoucherUsageStatus(voucher);
          if (status === "USED") return "fa-circle-check";
          if (status === "MISSING") return "fa-triangle-exclamation";
          return "fa-ticket-simple";
        },

        get voucherBatchVouchers() {
          const batches = this.selectedVoucherBatchId === "ALL"
            ? this.voucherBatches
            : (this.voucherResult ? [this.voucherResult] : []);
          return batches.flatMap((batch) => (
            (Array.isArray(batch.vouchers) ? batch.vouchers : []).map((voucher) => ({
              ...voucher,
              batchId: batch.batchId,
              batchProfile: batch.profile,
            }))
          ));
        },

        get filteredVoucherBatchVouchers() {
          const usage = String(this.voucherBatchFilters.usage || "ALL").toUpperCase();
          return this.voucherBatchVouchers.filter((voucher) => {
            if (usage !== "ALL" && this.getVoucherUsageStatus(voucher) !== usage) return false;
            return this.searchMatches(voucher, ["username", "password", "macAddress"], this.voucherBatchFilters.search);
          });
        },

        get hasVoucherBatchFilters() {
          return Boolean(String(this.voucherBatchFilters.search || "").trim())
            || String(this.voucherBatchFilters.usage || "ALL") !== "ALL";
        },

        resetVoucherBatchFilters() {
          this.voucherBatchFilters.search = "";
          this.voucherBatchFilters.usage = "ALL";
        },

        getVoucherJobMessage(job) {
          const progress = Math.max(0, Number(job?.progress) || 0);
          const total = Math.max(1, Number(job?.total) || 1);
          if (job?.status === "QUEUED" || job?.phase === "QUEUED") {
            return `Menunggu antrean pembuatan ${total} voucher...`;
          }
          if (job?.phase === "CONNECTING") {
            return `Menghubungkan ke MikroTik untuk membuat ${total} voucher...`;
          }
          if (job?.phase === "VERIFYING") {
            return `Memeriksa ${total} voucher yang sudah dibuat...`;
          }
          return `Membuat voucher ${Math.min(progress, total)} dari ${total} di MikroTik...`;
        },

        getOperationJobMessage(job) {
          const progress = Math.max(0, Number(job?.progress) || 0);
          const total = Math.max(1, Number(job?.total) || 1);
          if (["CONTACT_BROADCAST", "ADMIN_BROADCAST"].includes(job?.type)) {
            const target = job?.type === "ADMIN_BROADCAST" ? "admin" : "pelanggan";
            return `Mengirim pesan ${Math.min(progress, total)} dari ${total} ${target}...`;
          }
          if (job?.type === "MIKROTIK_BACKUP") {
            return job?.phase === "CREATING_BACKUP"
              ? "Membuat file backup MikroTik..."
              : `Mengirim backup ${Math.min(progress, total)} dari ${total} tujuan...`;
          }
          if (job?.type === "REMINDER_SCHEDULER") {
            return "Memproses reminder yang sudah jatuh tempo...";
          }
          if (job?.type === "HOTSPOT_REACTIVATION") {
            return "Memproses jadwal aktivasi dan penonaktifan hotspot...";
          }
          return "Memproses pekerjaan di server...";
        },

        async waitForBackgroundJob(initialJob, options = {}) {
          let job = initialJob;
          let pollingFailures = 0;
          const deadline = Date.now() + (30 * 60 * 1000);
          const endpointPrefix = options.endpointPrefix || "/api/jobs";
          const messageBuilder = typeof options.messageBuilder === "function"
            ? options.messageBuilder
            : (currentJob) => this.getOperationJobMessage(currentJob);
          while (Date.now() < deadline) {
            if (job?.status === "COMPLETED") return job.result;
            if (job?.status === "FAILED") {
              throw new Error(job.error || "Pembuatan voucher gagal.");
            }

            this.processingModal.message = messageBuilder(job);
            await new Promise((resolve) => setTimeout(resolve, 1200));
            try {
              job = await this.api(`${endpointPrefix}/${encodeURIComponent(job.id)}`, {
                silent: true,
              });
              pollingFailures = 0;
            } catch (error) {
              if (error?.status === 404) {
                throw new Error("Status pekerjaan tidak lagi tersedia. Periksa data atau riwayat terkait sebelum mencoba lagi.");
              }
              pollingFailures += 1;
              if (pollingFailures >= 10) {
                throw new Error("Koneksi ke server terputus, tetapi pekerjaan mungkin masih berjalan. Periksa hasilnya beberapa saat lagi.");
              }
            }
          }
          throw new Error("Pekerjaan masih berjalan terlalu lama. Tutup pesan ini dan periksa hasilnya beberapa saat lagi.");
        },

        waitForVoucherGeneration(initialJob) {
          return this.waitForBackgroundJob(initialJob, {
            endpointPrefix: "/api/mikrotik/voucher-jobs",
            messageBuilder: (job) => this.getVoucherJobMessage(job),
          });
        },

        waitForOperationJob(initialJob) {
          return this.waitForBackgroundJob(initialJob, { endpointPrefix: "/api/jobs" });
        },

        async createVouchers() {
          if (this.loading.voucherGeneration) return;
          this.loading.voucherGeneration = true;
          this.clearFormError("voucher");
          const form = this.forms.voucher;
          const quantity = form.generationType === "SINGLE" ? 1 : Number(form.quantity || 0);
          const payload = {
            ...form,
            quantity,
            codeLength: Number(form.codeLength || 0),
            dataLimit: form.dataLimit === "" ? 0 : Number(form.dataLimit),
          };
          try {
            await this.withProcessing(`Membuat ${quantity} voucher di MikroTik...`, async () => {
              let createdBatch;
              if (form.generationType === "BULK") {
                const job = await this.api("/api/mikrotik/voucher-jobs", {
                  method: "POST",
                  body: JSON.stringify(payload),
                });
                createdBatch = await this.waitForVoucherGeneration(job);
              } else {
                createdBatch = await this.api("/api/mikrotik/vouchers", {
                  method: "POST",
                  body: JSON.stringify(payload),
                });
              }
              this.voucherBatches = [
                createdBatch,
                ...this.voucherBatches.filter((batch) => batch.batchId !== createdBatch.batchId),
              ];
              this.selectVoucherBatch(createdBatch.batchId);
              if (form.generationType === "SINGLE") {
                form.username = "";
                form.password = "";
              }
              try {
                await this.loadHotspotUsers({ silent: true });
              } catch (error) {
                this.notify("Voucher berhasil dibuat, tetapi daftar user hotspot belum dapat dimuat ulang.");
              }
              void this.loadVoucherStats({ silent: true });
              this.closeVoucherCreateModal();
              this.notify(`${this.voucherResult.quantity} voucher berhasil dibuat dan ditambahkan ke riwayat batch.`);
            });
          } catch (error) {
            this.setFormError("voucher", error);
          } finally {
            this.loading.voucherGeneration = false;
          }
        },

        getVoucherCredentialText() {
          if (!this.voucherResult?.vouchers?.length) return "";
          const heading = [
            `Voucher Hotspot - ${this.voucherResult.profile}`,
            `Server: ${this.voucherResult.server === "all" ? "Semua server" : this.voucherResult.server}`,
            "",
          ];
          const rows = this.voucherResult.vouchers.map((voucher, index) => (
            `${index + 1}. Username: ${voucher.username} | Password: ${voucher.password}`
          ));
          return [...heading, ...rows].join("\n");
        },

        async copyVoucherCredentials() {
          const text = this.getVoucherCredentialText();
          if (!text) return;
          try {
            if (navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(text);
            } else {
              const input = document.createElement("textarea");
              input.value = text;
              input.setAttribute("readonly", "");
              input.style.position = "fixed";
              input.style.opacity = "0";
              document.body.appendChild(input);
              input.select();
              document.execCommand("copy");
              input.remove();
            }
            this.notify("Username dan password voucher disalin.");
          } catch (error) {
            this.notify("Voucher tidak dapat disalin otomatis. Pilih teks lalu salin secara manual.");
          }
        },

        printVouchers(template = "standard") {
          if (!this.voucherResult?.vouchers?.length) return;
          document.querySelector(".voucher-print-root")?.remove();
          const rewardTemplate = template === "reward";
          const source = document.querySelector(
            rewardTemplate ? ".voucher-reward-print-pages" : ".voucher-print-pages"
          );
          if (!source) return;
          const printRoot = source.cloneNode(true);
          printRoot.className = `voucher-print-root ${rewardTemplate ? "voucher-print-root-reward" : "voucher-print-root-standard"}`;
          printRoot.removeAttribute("aria-hidden");
          document.body.appendChild(printRoot);
          document.body.classList.add("voucher-print-mode");
          const cleanup = () => {
            document.body.classList.remove("voucher-print-mode");
            printRoot.remove();
          };
          window.addEventListener("afterprint", cleanup, { once: true });
          window.print();
          window.setTimeout(cleanup, 1_000);
        },

        printRewardVouchers() {
          this.printVouchers("reward");
        },

        getVoucherPrintPages() {
          const vouchers = Array.isArray(this.voucherResult?.vouchers)
            ? this.voucherResult.vouchers
            : [];
          const pages = [];
          for (let index = 0; index < vouchers.length; index += 15) {
            pages.push(vouchers.slice(index, index + 15));
          }
          return pages;
        },

        getVoucherRewardPrintPages() {
          const vouchers = Array.isArray(this.voucherResult?.vouchers)
            ? this.voucherResult.vouchers
            : [];
          const pages = [];
          for (let index = 0; index < vouchers.length; index += 15) {
            pages.push(vouchers.slice(index, index + 15));
          }
          return pages;
        },

        async loadHotspotUsers(options = {}) {
          this.hotspotUsers = await this.api("/api/mikrotik/hotspot-users", { silent: Boolean(options.silent) });
          if (!options.silent) this.notify(`${this.hotspotUsers.length} user hotspot dimuat.`);
        },

        async loadHotspotOptions(formKey = "", options = {}) {
          if (this.loading.hotspotOptions) return;
          this.loading.hotspotOptions = true;
          try {
            const results = await Promise.allSettled([
              this.loadHotspotUsers({ silent: true }),
              this.loadMikrotikProfiles({ silent: true }),
              this.loadApMonitors(),
            ]);
            const failed = results.find((item) => item.status === "rejected");
            if (failed) {
              this.notify(failed.reason?.message || "Gagal load data MikroTik.");
              return;
            }
            if (formKey) {
              this.syncHotspotUserToForm(formKey);
            }
            if (!options.silent) {
              this.notify(`${this.hotspotUsers.length} user hotspot, ${this.mikrotikProfiles.length} profile, dan ${this.apMonitors.length} AP dimuat.`);
            }
          } finally {
            this.loading.hotspotOptions = false;
          }
        },

        async loadApMonitors(options = {}) {
          this.apMonitors = await this.api("/api/mikrotik/netwatch", { silent: Boolean(options.silent) });
          this.updateApSummaryMetrics();
          this.clampPage("monitorAp", this.filteredApMonitors.length);
        },

        updateApSummaryMetrics() {
          if (!Array.isArray(this.summaryMetrics) || this.summaryMetrics.length === 0) return;

          const { down: apDown } = this.networkMonitorSummary;

          const baseMetrics = this.summaryMetrics.filter(
            (metric) => metric.label !== "AP online" && metric.label !== "AP bermasalah"
          );

          this.summaryMetrics = [
            ...baseMetrics,
            { label: "AP bermasalah", value: apDown, icon: "fa-solid fa-triangle-exclamation", tone: "red", menu: "monitor-ap" },
          ];
        },

        async loadReminders() {
          this.reminders = await this.api("/api/reminders");
          this.clampPage("reminders", this.filteredReminders.length);
        },

        async loadSent() {
          this.sent = await this.api("/api/reminders/sent");
          this.clampPage("sent", this.filteredSent.length);
        },

        async loadTemplates() {
          this.loading.templates = true;
          this.templateLoadError = "";
          try {
            this.templates = await this.api("/api/templates", { silent: true });
            return true;
          } catch (error) {
            this.templateLoadError = error instanceof Error ? error.message : "Template gagal dimuat.";
            return false;
          } finally {
            this.loading.templates = false;
          }
        },

        async loadRecipients() {
          const recipients = await this.api("/api/admin-recipients");
          this.forms.recipients = recipients.join("\n");
        },

        async loadLogs(options = {}) {
          this.logs = await this.api("/api/logs", { silent: Boolean(options.silent) });
          this.clampPage("logs", this.logs.length);
        },

  };
}
