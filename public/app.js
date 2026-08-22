    function dashboardApp() {
      return {
        loading: {
          status: false,
          mikrotikBackup: false,
          hotspotOptions: false,
        },
        toast: {
          show: false,
          message: "",
          timer: null,
          duration: 10000,
          remaining: 0,
          startedAt: 0,
          paused: false,
        },
        processingModal: {
          open: false,
          message: "Memproses data...",
          startedAt: 0,
          minVisibleMs: 350,
          activeCount: 0,
        },
        toastQueue: [],
        deleteConfirm: {
          open: false,
          loading: false,
          title: "",
          description: "",
          confirmLabel: "Hapus",
          action: null,
        },
        formErrors: {
          manual: "",
          broadcast: "",
          recipients: "",
          contact: "",
          contactEdit: "",
          hotspotAccount: "",
          accountDelivery: "",
          reminder: "",
          reminderEdit: "",
          template: "",
          settings: "",
          deleteConfirm: "",
        },
        contactEditModal: {
          open: false,
          loading: false,
        },
        contactCreateModal: {
          open: false,
          loading: false,
        },
        hotspotAccountModal: {
          open: false,
          loading: false,
          editingContactId: "",
        },
        accountDeliveryModal: {
          open: false,
          loading: false,
          contact: null,
          includePortal: true,
          includeHotspot: false,
        },
        reminderEditModal: {
          open: false,
          loading: false,
        },
        reminderCreateModal: {
          open: false,
          loading: false,
        },
        activeMenu: "overview",
        activeContactTab: "data",
        sidebarHidden: false,
        mobileSidebarOpen: false,
        navGroups: [
          { key: "workspace", label: "Workspace" },
          { key: "operations", label: "Operasional" },
          { key: "messages", label: "Komunikasi" },
          { key: "system", label: "Sistem" },
        ],
        navMenus: [
          { key: "overview", group: "workspace", label: "Ringkasan", icon: "fa-solid fa-table-cells-large", description: "Kondisi layanan dan pekerjaan penting hari ini." },
          { key: "contacts", group: "operations", label: "Pelanggan", icon: "fa-solid fa-users", description: "Kelola data, tagihan, dan layanan hotspot pelanggan dalam tab terpisah." },
          { key: "reminders", group: "operations", label: "Jadwal Reminder", icon: "fa-solid fa-calendar-check", description: "Atur jadwal dan isi pesan reminder pelanggan." },
          { key: "monitor-ap", group: "operations", label: "Monitor Jaringan", icon: "fa-solid fa-tower-broadcast", description: "Pantau konektivitas dan kondisi access point." },
          { key: "notifications", group: "messages", label: "Kirim Pesan", icon: "fa-solid fa-paper-plane", description: "Kirim pesan personal, broadcast, dan kelola penerima admin." },
          { key: "templates", group: "messages", label: "Template Pesan", icon: "fa-solid fa-file-lines", description: "Siapkan format pesan untuk notifikasi dan reminder." },
          { key: "history", group: "messages", label: "Riwayat Kirim", icon: "fa-solid fa-clock-rotate-left", description: "Lihat pesan yang dikirim beserta statusnya." },
          { key: "settings", group: "system", label: "Pengaturan", icon: "fa-solid fa-sliders", description: "Konfigurasi identitas, notifikasi, backup, dan sistem." },
          { key: "logs", group: "system", label: "Log Aktivitas", icon: "fa-solid fa-list-check", description: "Audit aktivitas scheduler, koneksi, dan proses internal." },
        ],
        contacts: [],
        mikrotikProfiles: [],
        hotspotUsers: [],
        apMonitors: [],
        reminders: [],
        sent: [],
        templates: [],
        logs: [],
        statusCards: [],
        summaryMetrics: [],
        settingsDirty: false,
        isMobile: window.matchMedia("(max-width: 768px)").matches,
        pollers: [],
        paymentTypeSelection: {},
        expandedMessages: {},
        billingPeriod: "",
        pageSizes: [10, 25, 50, 100],
        filters: {
          contacts: { search: "", page: 1, pageSize: 10 },
          contactBilling: { search: "", status: "ALL", dueStatus: "ALL", page: 1, pageSize: 10 },
          contactHotspot: { search: "", status: "ALL", page: 1, pageSize: 10 },
          monitorAp: { search: "", status: "ALL", page: 1, pageSize: 10 },
          reminders: { search: "", schedule: "ALL", page: 1, pageSize: 10 },
          sent: { search: "", status: "ALL", page: 1, pageSize: 10 },
          logs: { page: 1, pageSize: 10 },
        },
        forms: {
          manual: { contactId: "", phoneNumber: "", templateName: "", message: "" },
          broadcast: { title: "", templateName: "", message: "" },
          recipients: "",
          contact: {
            id: "",
            name: "",
            phoneNumber: "",
            linkedApHost: "",
            subscriptionType: "RECURRING",
            mikrotikUsername: "",
            mikrotikProfile: "",
            mikrotikPassword: "",
            createHotspotAccount: true,
            sendCredentials: true,
            hotspotReactivationEnabled: false,
            hotspotReactivationDate: "",
            hotspotReactivationTime: "",
          },
          reminder: { id: "", contactId: "", reminderDate: "", reminderTime: "", templateName: "", message: "" },
          contactEdit: {
            id: "",
            name: "",
            phoneNumber: "",
            linkedApHost: "",
            subscriptionType: "RECURRING",
            mikrotikUsername: "",
            mikrotikProfile: "",
            mikrotikPassword: "",
            hotspotReactivationEnabled: false,
            hotspotReactivationDate: "",
            hotspotReactivationTime: "",
          },
          hotspotAccount: {
            contactId: "",
            username: "",
            profile: "",
            password: "",
            sendCredentials: true,
            reactivationEnabled: false,
            reactivationDate: "",
            reactivationTime: "",
          },
          reminderEdit: { id: "", contactId: "", reminderDate: "", reminderTime: "", templateName: "", message: "" },
          template: { name: "", content: "" },
          settings: {
            dashboardTitle: "",
            companyName: "",
            supportSignature: "",
            apDownMessageTemplate: "",
            customerAccountMessageTemplate: "",
            paymentMessageTemplateArrearsOnly: "",
            paymentMessageTemplateCurrentOnly: "",
            paymentMessageTemplateFullPaid: "",
            billingReminderMessageTemplate: "",
            timezone: "",
            autoRescheduleMonthly: false,
            notifyContactsOnApDown: true,
            notifyAdminsOnDelivery: false,
            notifyAdminsOnConnectionChange: false,
            notifyAdminsOnPaymentReset: false,
            waRandomDelayMinSeconds: 2,
            waRandomDelayMaxSeconds: 5,
            enableMikrotikBackupToWa: false,
            mikrotikBackupTime: "02:00",
            mikrotikBackupTimezone: "Asia/Jakarta",
            profileMonthlyAmounts: {},
          },
        },

        async init() {
          const requestedMenu = new URLSearchParams(window.location.search).get("menu");
          const savedMenu = requestedMenu || localStorage.getItem("dashboardActiveMenu");
          const savedContactTab = localStorage.getItem("dashboardContactTab");
          const isValidSavedMenu = this.navMenus.some((menu) => menu.key === savedMenu);
          if (savedMenu === "payment-amount") {
            this.activeMenu = "contacts";
            this.activeContactTab = "billing";
            localStorage.setItem("dashboardActiveMenu", "contacts");
            localStorage.setItem("dashboardContactTab", "billing");
          } else if (isValidSavedMenu) {
            this.activeMenu = savedMenu;
          }
          if (savedMenu !== "payment-amount" && ["data", "billing", "hotspot"].includes(savedContactTab)) {
            this.activeContactTab = savedContactTab;
          }
          this.sidebarHidden = localStorage.getItem("dashboardSidebarHidden") === "true";

          this.$watch("activeMenu", (value) => {
            localStorage.setItem("dashboardActiveMenu", value);
          });
          this.$watch("sidebarHidden", (value) => {
            localStorage.setItem("dashboardSidebarHidden", value ? "true" : "false");
          });
          this.$watch("activeContactTab", (value) => {
            localStorage.setItem("dashboardContactTab", value);
          });

          await this.loadStatus();
          await Promise.all([
            this.loadContacts(),
            this.loadReminders(),
            this.loadTemplates(),
          ]);

          setTimeout(() => {
            this.loadNonCriticalData();
          }, this.isMobile ? 900 : 250);

          this.startPolling();
        },

        startPolling() {
          const statusInterval = this.isMobile ? 45000 : 25000;
          const logsInterval = this.isMobile ? 120000 : 60000;

          this.pollers.push(setInterval(() => {
            if (!document.hidden) {
              const requests = [this.loadStatus({ silent: true })];
              if (this.activeMenu === "contacts" && this.activeContactTab === "hotspot") {
                requests.push(this.loadContacts({ silent: true }));
              }
              void Promise.allSettled(requests);
            }
          }, statusInterval));

          this.pollers.push(setInterval(() => {
            if (!document.hidden && this.activeMenu === "logs") {
              this.loadLogs({ silent: true });
            }
          }, logsInterval));
        },

        toggleSidebar() {
          this.sidebarHidden = !this.sidebarHidden;
        },

        selectMenu(key) {
          if (key === "payment-amount") {
            this.activeContactTab = "billing";
            key = "contacts";
          }
          this.activeMenu = key;
          this.mobileSidebarOpen = false;
          window.scrollTo({ top: 0, behavior: "smooth" });
        },

        selectContactTab(key) {
          if (!["data", "billing", "hotspot"].includes(key)) return;
          this.activeContactTab = key;
        },

        get activeMenuLabel() {
          return this.navMenus.find((menu) => menu.key === this.activeMenu)?.label || "Dashboard";
        },

        get activeMenuDescription() {
          return this.navMenus.find((menu) => menu.key === this.activeMenu)?.description || "Panel operasional reminder bot.";
        },

        get activeMenuIcon() {
          return this.navMenus.find((menu) => menu.key === this.activeMenu)?.icon || "fa-solid fa-table-cells-large";
        },

        get currentDateLabel() {
          return new Intl.DateTimeFormat("id-ID", {
            timeZone: this.getAppTimezone(),
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
          }).format(new Date());
        },

        summaryValue(label) {
          return Number(this.summaryMetrics.find((metric) => metric.label === label)?.value || 0);
        },

        get paymentProgress() {
          const total = this.summaryValue("Pelanggan");
          return total ? Math.min(100, Math.round((this.summaryValue("Sudah bayar") / total) * 100)) : 0;
        },

        async loadNonCriticalData() {
          await Promise.allSettled([
            this.loadApMonitors(),
            this.loadMikrotikProfiles({ silent: true }),
            this.loadHotspotUsers({ silent: true }),
            this.loadSent(),
            this.loadRecipients(),
            this.loadLogs(),
          ]);
        },

        async api(path, options = {}) {
          const { silent = false, ...fetchOptions } = options;
          const response = await fetch(path, {
            ...fetchOptions,
            cache: "no-store",
            credentials: "same-origin",
            headers: {
              "Content-Type": "application/json",
              ...(fetchOptions.headers || {}),
            },
          });

          if (response.status === 401) {
            window.location.href = "/login";
            throw new Error("Unauthorized");
          }

          const contentType = response.headers.get("content-type") || "";
          const payload = contentType.includes("application/json")
            ? await response.json()
            : { success: false, error: await response.text() || "Request failed" };
          if (!response.ok || !payload.success) {
            const message = payload.error || `Request failed (${response.status})`;
            if (!silent) this.notify(message);
            throw new Error(message);
          }

          return payload.data;
        },

        notify(message) {
          const text = String(message || "").trim();
          if (!text) return;
          if (this.toast.show) {
            this.toastQueue.push(text);
            return;
          }
          this.showToast(text);
        },

        setFormError(key, error) {
          const message = error instanceof Error ? error.message : String(error || "");
          this.formErrors[key] = message.trim() || "Operasi gagal. Silakan coba lagi.";
        },

        clearFormError(key) {
          if (key) {
            this.formErrors[key] = "";
          }
        },

        showProcessing(message = "Memproses data...") {
          this.processingModal.activeCount += 1;
          this.processingModal.message = message;
          if (!this.processingModal.open) {
            this.processingModal.startedAt = Date.now();
            this.processingModal.open = true;
          }
        },

        async hideProcessing() {
          this.processingModal.activeCount = Math.max(0, this.processingModal.activeCount - 1);
          if (this.processingModal.activeCount > 0) return;

          const elapsed = Date.now() - this.processingModal.startedAt;
          const waitMs = Math.max(0, this.processingModal.minVisibleMs - elapsed);
          if (waitMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, waitMs));
          }

          if (this.processingModal.activeCount === 0) {
            this.processingModal.open = false;
            this.processingModal.message = "Memproses data...";
          }
        },

        async withProcessing(message, action) {
          this.showProcessing(message);
          try {
            return await action();
          } finally {
            await this.hideProcessing();
          }
        },

        showToast(message) {
          this.toast.message = message;
          this.toast.show = true;
          this.toast.paused = false;
          this.toast.remaining = this.toast.duration;
          this.startToastTimer();
        },

        startToastTimer() {
          clearTimeout(this.toast.timer);
          this.toast.startedAt = Date.now();
          this.toast.timer = setTimeout(() => {
            this.hideToast();
          }, this.toast.remaining);
        },

        pauseToast() {
          if (!this.toast.show || this.toast.paused) return;
          this.toast.paused = true;
          clearTimeout(this.toast.timer);
          const elapsed = Date.now() - this.toast.startedAt;
          this.toast.remaining = Math.max(1200, this.toast.remaining - elapsed);
        },

        resumeToast() {
          if (!this.toast.show || !this.toast.paused) return;
          this.toast.paused = false;
          this.startToastTimer();
        },

        hideToast() {
          this.toast.show = false;
          this.toast.paused = false;
          clearTimeout(this.toast.timer);
          this.toast.timer = null;
          this.toast.remaining = this.toast.duration;
          const next = this.toastQueue.shift();
          if (next) {
            setTimeout(() => this.showToast(next), 120);
          }
        },

        openDeleteConfirm({ title, description, confirmLabel = "Hapus", action }) {
          this.deleteConfirm = {
            open: true,
            loading: false,
            title,
            description,
            confirmLabel,
            action,
          };
          this.clearFormError("deleteConfirm");
          document.body.classList.add("overflow-hidden");
        },

        closeDeleteConfirm() {
          this.deleteConfirm.open = false;
          this.deleteConfirm.loading = false;
          this.deleteConfirm.title = "";
          this.deleteConfirm.description = "";
          this.deleteConfirm.confirmLabel = "Hapus";
          this.deleteConfirm.action = null;
          this.clearFormError("deleteConfirm");
          document.body.classList.remove("overflow-hidden");
        },

        async confirmDeleteAction() {
          if (!this.deleteConfirm.action || this.deleteConfirm.loading) return;
          this.deleteConfirm.loading = true;
          this.clearFormError("deleteConfirm");
          try {
            await this.withProcessing("Menghapus data...", () => this.deleteConfirm.action());
            this.closeDeleteConfirm();
          } catch (error) {
            this.setFormError("deleteConfirm", error);
          } finally {
            this.deleteConfirm.loading = false;
          }
        },

        getAppTimezone() {
          return this.forms.settings.timezone || "Asia/Jakarta";
        },

        getZonedParts(value) {
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) return null;
          const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: this.getAppTimezone(),
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          }).formatToParts(date).reduce((result, part) => {
            if (part.type !== "literal") result[part.type] = part.value;
            return result;
          }, {});
          return parts;
        },

        formatDateTime(value) {
          return new Date(value).toLocaleString("id-ID", { timeZone: this.getAppTimezone() });
        },

        messageKey(scope, id) {
          return `${scope}:${id || "unknown"}`;
        },

        isLongMessage(message) {
          return String(message || "").trim().length > 150;
        },

        isMessageExpanded(key) {
          return Boolean(this.expandedMessages[key]);
        },

        toggleMessage(key) {
          this.expandedMessages[key] = !this.expandedMessages[key];
        },

        formatDateInput(value) {
          const parts = this.getZonedParts(value);
          return parts ? `${parts.year}-${parts.month}-${parts.day}` : "";
        },

        formatTimeInput(value) {
          const parts = this.getZonedParts(value);
          return parts ? `${parts.hour}:${parts.minute}` : "";
        },

        blankContactForm() {
          return {
            id: "",
            name: "",
            phoneNumber: "",
            linkedApHost: "",
          };
        },

        blankHotspotAccountForm() {
          return {
            contactId: "",
            username: "",
            profile: "",
            password: "",
            sendCredentials: true,
            reactivationEnabled: false,
            reactivationDate: "",
            reactivationTime: "",
          };
        },

        getContactsWithoutHotspot() {
          return this.contacts.filter((contact) => !contact.mikrotikUsername);
        },

        getHotspotAccountCandidates() {
          const editingContactId = String(this.hotspotAccountModal.editingContactId || "");
          return this.contacts.filter(
            (contact) => !contact.mikrotikUsername || String(contact.id) === editingContactId
          );
        },

        isHotspotReactivationAllowed() {
          const selected = this.contacts.find(
            (contact) => String(contact.id) === String(this.forms.hotspotAccount.contactId)
          );
          return String(selected?.subscriptionType || "RECURRING").toUpperCase().replace(/-/g, "_") === "RECURRING";
        },

        suggestHotspotUsername(name) {
          return String(name || "")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, "_")
            .replace(/[^a-z0-9_]/g, "");
        },

        buildHotspotReactivationAt(form) {
          const date = form.hotspotReactivationDate || form.reactivationDate;
          const time = form.hotspotReactivationTime || form.reactivationTime;
          if (!date) return "";
          return `${date} ${time || "00:00"}`;
        },

        getContactHotspotLabel(contact) {
          if (!contact.mikrotikUsername) return "-";
          const profile = contact.mikrotikProfile ? ` / ${contact.mikrotikProfile}` : "";
          return `${contact.mikrotikUsername}${profile}`;
        },

        getProfileMonthlyAmount(profileName) {
          const profile = String(profileName || "").trim().toLowerCase();
          if (!profile) return null;
          const entries = Object.entries(this.forms.settings.profileMonthlyAmounts || {});
          const match = entries.find(([name]) => String(name).trim().toLowerCase() === profile);
          if (!match || match[1] === "" || match[1] === null || match[1] === undefined) return null;
          const amount = Number(match[1]);
          return Number.isFinite(amount) && amount >= 0 ? Math.floor(amount) : null;
        },

        hasProfileMonthlyAmount(contact) {
          return this.getProfileMonthlyAmount(contact?.mikrotikProfile) !== null;
        },

        syncProfileMonthlyAmountFields() {
          const current = { ...(this.forms.settings.profileMonthlyAmounts || {}) };
          for (const profile of this.mikrotikProfiles) {
            const name = String(profile?.name || "").trim();
            if (!name) continue;
            const existingKey = Object.keys(current).find((key) => key.toLowerCase() === name.toLowerCase());
            current[name] = existingKey ? current[existingKey] : "";
            if (existingKey && existingKey !== name) delete current[existingKey];
          }
          this.forms.settings.profileMonthlyAmounts = current;
        },

        getHotspotProvisioningStatus(contact) {
          const status = String(contact?.hotspotProvisioningStatus || "").trim().toUpperCase();
          if (status) return status;
          return contact?.mikrotikUsername && contact?.mikrotikProfile ? "ACTIVE" : "NONE";
        },

        getHotspotProvisioningLabel(contact) {
          return {
            NONE: "Belum diproses",
            PENDING: "Menunggu provisioning",
            PROVISIONING: "Sedang diproses",
            ACTIVE: "Aktif di MikroTik",
            FAILED: "Sinkronisasi gagal",
            DEACTIVATED: "Dinonaktifkan terjadwal",
            DISABLED: "Dinonaktifkan di MikroTik",
            MISSING: "Akun tidak ditemukan",
            CHANGED: "Data akun berubah",
          }[this.getHotspotProvisioningStatus(contact)] || "Status tidak dikenal";
        },

        getHotspotProvisioningClass(contact) {
          return {
            ACTIVE: "bg-moss/10 text-moss",
            PENDING: "bg-amber-100 text-amber-800",
            PROVISIONING: "bg-sky-100 text-sky-800",
            FAILED: "bg-red-100 text-red-700",
            DEACTIVATED: "bg-slate-200/70 text-slate-700",
            DISABLED: "bg-red-100 text-red-700",
            MISSING: "bg-red-100 text-red-700",
            CHANGED: "bg-orange-100 text-orange-800",
          }[this.getHotspotProvisioningStatus(contact)] || "bg-slate-200/70 text-slate-700";
        },

        canRetryHotspotProvisioning(contact) {
          return ["PENDING", "FAILED", "MISSING", "CHANGED"].includes(
            this.getHotspotProvisioningStatus(contact)
          );
        },

        canReactivateHotspot(contact) {
          return ["ACTIVE", "DEACTIVATED"].includes(this.getHotspotProvisioningStatus(contact));
        },

        canDisableHotspot(contact) {
          return this.getHotspotProvisioningStatus(contact) === "ACTIVE";
        },

        canEnableHotspot(contact) {
          const status = this.getHotspotProvisioningStatus(contact);
          return status === "DISABLED"
            || (status === "CHANGED" && /akun dinonaktifkan/i.test(String(contact?.hotspotProvisioningError || "")));
        },

        canSendHotspotAccount(contact) {
          const status = this.getHotspotProvisioningStatus(contact);
          if (["NONE", "MISSING", "DEACTIVATED", "DISABLED"].includes(status)) return false;
          return !(status === "CHANGED" && /akun dinonaktifkan/i.test(String(contact?.hotspotProvisioningError || "")));
        },

        getReactivationLabel(contact) {
          if (!contact.hotspotReactivationAt) return contact.hotspotReactivationEnabled ? "Belum dijadwalkan" : "Tanpa jadwal";
          if (!contact.hotspotReactivationEnabled) return `Nonaktif terjadwal: ${this.formatDateTime(contact.hotspotReactivationAt)}`;
          return this.formatDateTime(contact.hotspotReactivationAt);
        },

        hasMikrotikProfile(profileName) {
          const needle = String(profileName || "").trim().toLowerCase();
          if (!needle) return true;
          return this.mikrotikProfiles.some((profile) => String(profile.name || "").trim().toLowerCase() === needle);
        },

        syncHotspotUserToForm(formKey) {
          const form = this.forms[formKey];
          if (!form) return;
          const usernameField = formKey === "hotspotAccount" ? "username" : "mikrotikUsername";
          const profileField = formKey === "hotspotAccount" ? "profile" : "mikrotikProfile";
          const passwordField = formKey === "hotspotAccount" ? "password" : "mikrotikPassword";
          const username = String(form[usernameField] || "").trim().toLowerCase();
          if (!username) return;
          const selected = this.hotspotUsers.find((user) => String(user.username || "").trim().toLowerCase() === username);
          if (selected?.profile) {
            form[profileField] = selected.profile;
          }
          if (selected?.password) {
            form[passwordField] = selected.password;
          }
        },

        inferPaymentType(contact, options = {}) {
           const { useSavedType = true } = options;
           const savedType = String(contact.paymentType || "").toUpperCase();
           if (useSavedType && ["ARREARS-ONLY", "CURRENT-ONLY", "FULL-PAID"].includes(savedType)) {
             return savedType;
           }

           const paymentMonths = contact.paymentMonths || {};
           const [periodYear, periodMonth] = String(this.billingPeriod || "").split("-").map(Number);
           const nowParts = this.getZonedParts(new Date());
           const year = periodYear || Number(nowParts?.year);
           const month = periodMonth || Number(nowParts?.month);
           const currentKey = `${year}-${String(month).padStart(2, "0")}`;
           const prevMonth = month === 1 ? 12 : month - 1;
           const prevYear = month === 1 ? year - 1 : year;
           const prevKey = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
           const currentPaid = paymentMonths[currentKey]?.status === "PAID";
           const prevPaid = paymentMonths[prevKey]?.status === "PAID";

           if (currentPaid && prevPaid) return "FULL-PAID";
           if (currentPaid) return "CURRENT-ONLY";
           if (prevPaid) return "ARREARS-ONLY";
           return "DEFAULT";
         },

        getPaymentTypeSelection(contact) {
          return String(contact.paymentType || this.inferPaymentType(contact) || "").toUpperCase();
        },

        getPaymentTypeLabel(type) {
          const labels = {
            "DEFAULT": "Default (Belum dibayar)",
            "ARREARS-ONLY": "Hanya Tunggakan",
            "CURRENT-ONLY": "Bulan Ini Saja",
            "FULL-PAID": "Lunas Semua"
          };
          return labels[type] || type;
        },

        getPaymentTypeOptions() {
          return ["ARREARS-ONLY", "CURRENT-ONLY", "FULL-PAID"];
        },

        getPreviousBillingPeriodLabel() {
          const monthNames = ["", "Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
          const [periodYear, periodMonth] = String(this.billingPeriod || "").split("-").map(Number);
          const nowParts = this.getZonedParts(new Date());
          const currentMonth = periodMonth || Number(nowParts?.month);
          const currentYear = periodYear || Number(nowParts?.year);
          const previousMonth = currentMonth === 1 ? 12 : currentMonth - 1;
          const previousYear = currentMonth === 1 ? currentYear - 1 : currentYear;
          return `${monthNames[previousMonth]} ${previousYear}`;
        },

        getBillingPeriodLabel(year, month) {
          const monthNames = ["", "Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
          return `${monthNames[month] || month} ${year}`;
        },

        getContactBillingStartPeriod(contact) {
          const systemStart = { year: 2026, month: 4 };
          const createdParts = contact.createdAt ? this.getZonedParts(contact.createdAt) : null;
          if (!createdParts) return systemStart;
          const createdPeriod = { year: Number(createdParts.year), month: Number(createdParts.month) };
          return ((createdPeriod.year * 12) + createdPeriod.month) > ((systemStart.year * 12) + systemStart.month)
            ? createdPeriod
            : systemStart;
        },

        getDebtPeriods(contact) {
          if (Array.isArray(contact.debtPeriods)) return contact.debtPeriods;
          if (this.inferPaymentType(contact) === "FULL-PAID") return [];

          const paymentMonths = contact.paymentMonths || {};
          const start = this.getContactBillingStartPeriod(contact);
          const [periodYear, periodMonth] = String(this.billingPeriod || "").split("-").map(Number);
          const nowParts = this.getZonedParts(new Date());
          const currentYear = periodYear || Number(nowParts?.year);
          const currentMonth = periodMonth || Number(nowParts?.month);
          const endIndex = (currentYear * 12) + currentMonth - 2;
          const periods = [];

          for (let index = (start.year * 12) + (start.month - 1); index <= endIndex; index += 1) {
            const year = Math.floor(index / 12);
            const month = (index % 12) + 1;
            const key = `${year}-${String(month).padStart(2, "0")}`;
            if (paymentMonths[key]?.status !== "PAID") {
              periods.push({ key, label: this.getBillingPeriodLabel(year, month), status: paymentMonths[key]?.status || "UNPAID" });
            }
          }

          return periods;
        },


        hasDebt(contact) {
          if (contact.hasDebt !== undefined) return Boolean(contact.hasDebt);
          return this.getDebtPeriods(contact).length > 0;
        },

        canSendBillingReminder(contact) {
          const status = String(contact?.currentPaymentStatus || contact?.paymentStatus || "UNPAID").toUpperCase();
          const dueStatus = String(contact?.dueStatus || "NOT_SCHEDULED").toUpperCase();
          return this.hasDebt(contact) || (status === "UNPAID" && dueStatus === "OVERDUE");
        },

        getSubscriptionTypeLabel(contact) {
          return String(contact?.subscriptionType || "RECURRING").toUpperCase() === "ONE_TIME"
            ? "Sekali berlangganan"
            : "Bulanan aktif";
        },

        getCurrentPaymentLabel(contact) {
          if (contact?.subscriptionActive === false) return "Tidak ada tagihan baru";
          if (contact?.paymentType) return this.getPaymentTypeLabel(contact.paymentType);
          return contact?.currentPaymentStatus === "PAID" ? "Lunas" : "Belum Bayar";
        },

        getDebtNote(contact) {
          const periods = this.getDebtPeriods(contact);
          return contact.debtNote || `Masih ada hutang ${periods.map((period) => period.label).join(", ") || contact.debtPeriodLabel || this.getPreviousBillingPeriodLabel()}.`;
        },

        getDebtCountLabel(contact) {
          const count = Number(contact.debtCount || this.getDebtPeriods(contact).length || 0);
          return `Hutang ${count || 1} bulan`;
        },

        formatRupiah(value) {
          return new Intl.NumberFormat("id-ID", {
            style: "currency",
            currency: "IDR",
            maximumFractionDigits: 0,
          }).format(Math.max(0, Number(value) || 0));
        },

        getDueStatusLabel(status) {
          const labels = {
            NOT_SCHEDULED: "Belum Dijadwalkan",
            UPCOMING: "Belum Jatuh Tempo",
            OVERDUE: "Jatuh Tempo",
            PAID: "Lunas",
          };
          return labels[String(status || "").toUpperCase()] || "Belum Dijadwalkan";
        },

        getDueStatusClass(status) {
          const normalized = String(status || "").toUpperCase();
          if (normalized === "PAID") return "bg-moss/10 text-moss";
          if (normalized === "OVERDUE") return "bg-clay/10 text-clay";
          if (normalized === "UPCOMING") return "bg-ink/10 text-ink";
          return "bg-slate-200/70 text-slate-700";
        },

        getApStatusClass(status) {
          const normalized = String(status || "").toUpperCase();
          if (["UP", "ONLINE", "OK"].includes(normalized)) return "bg-moss/10 text-moss";
          if (["DOWN", "OFFLINE", "FAIL"].includes(normalized)) return "bg-clay/10 text-clay";
          return "bg-slate-200/70 text-slate-700";
        },

        normalizeHost(value) {
          return String(value || "").trim().toLowerCase();
        },

        getApMonitorByHost(host) {
          const needle = this.normalizeHost(host);
          if (!needle) return null;
          return this.apMonitors.find((ap) => this.normalizeHost(ap.host) === needle) || null;
        },

        getContactApStatus(contact) {
          const linkedHost = this.normalizeHost(contact?.linkedApHost);
          if (!linkedHost) return "NOT_LINKED";
          if (!this.apMonitors.length) return "UNKNOWN";
          const monitor = this.getApMonitorByHost(linkedHost);
          if (!monitor) return "NOT_MONITORED";
          return String(monitor.status || "UNKNOWN").toUpperCase();
        },

        getContactApStatusLabel(contact) {
          const status = this.getContactApStatus(contact);
          if (status === "NOT_LINKED") return "Belum dipilih";
          if (status === "NOT_MONITORED") return "Tidak ada di Netwatch";
          return status;
        },

        getContactApStatusClass(contact) {
          const status = this.getContactApStatus(contact);
          if (status === "NOT_LINKED" || status === "NOT_MONITORED") {
            return "bg-slate-200/70 text-slate-700";
          }
          return this.getApStatusClass(status);
        },

        searchMatches(item, fields, search) {
          const needle = String(search || "").trim().toLowerCase();
          if (!needle) return true;
          return fields.some((field) => String(item[field] || "").toLowerCase().includes(needle));
        },

        isToday(value) {
          const dateParts = this.getZonedParts(value);
          const todayParts = this.getZonedParts(new Date());
          return Boolean(dateParts && todayParts
            && dateParts.year === todayParts.year
            && dateParts.month === todayParts.month
            && dateParts.day === todayParts.day);
        },

        get filteredContacts() {
          return this.contacts.filter((contact) => this.searchMatches(
            contact,
            ["name", "phoneNumber", "linkedApHost"],
            this.filters.contacts.search
          ));
        },

        get filteredBillingContacts() {
          return this.contacts.filter((contact) => {
            const selectedStatus = String(this.filters.contactBilling.status || "ALL").toUpperCase();
            const selectedDueStatus = String(this.filters.contactBilling.dueStatus || "ALL").toUpperCase();
            const paymentStatus = String(contact.paymentStatus || "UNPAID").toUpperCase();
            const savedPaymentType = String(contact.paymentType || "").toUpperCase();
            const dueStatus = String(contact.dueStatus || "NOT_SCHEDULED").toUpperCase();

            if (selectedStatus !== "ALL") {
              if (selectedStatus === "HAS-DEBT" && !this.hasDebt(contact)) return false;
              if (selectedStatus === "ARREARS-ONLY" && (savedPaymentType !== "ARREARS-ONLY" || paymentStatus === "PAID")) return false;
              if (selectedStatus === "UNPAID" && (paymentStatus === "PAID" || savedPaymentType === "ARREARS-ONLY")) return false;
              if (selectedStatus === "CURRENT-ONLY" && (savedPaymentType !== "CURRENT-ONLY" || paymentStatus !== "PAID")) return false;
              if (selectedStatus === "FULL-PAID" && (savedPaymentType !== "FULL-PAID" || paymentStatus !== "PAID")) return false;
            }
            if (selectedDueStatus !== "ALL" && dueStatus !== selectedDueStatus) return false;

            return this.searchMatches(
              contact,
              ["name", "phoneNumber", "monthlyPaymentAmount", "paymentStatus", "paymentType", "debtNote", "dueStatus", "dueDate"],
              this.filters.contactBilling.search
            );
          });
        },

        get filteredHotspotContacts() {
          return this.contacts.filter((contact) => {
            const selectedStatus = String(this.filters.contactHotspot.status || "ALL").toUpperCase();
            const hasAccount = Boolean(contact.mikrotikUsername);
            const provisioningStatus = this.getHotspotProvisioningStatus(contact);
            if (selectedStatus === "CONFIGURED" && !hasAccount) return false;
            if (selectedStatus === "UNCONFIGURED" && hasAccount) return false;
            if (selectedStatus === "AUTO" && !contact.hotspotReactivationEnabled) return false;
            if (["ACTIVE", "PENDING", "FAILED", "DEACTIVATED", "DISABLED", "MISSING", "CHANGED"].includes(selectedStatus)
              && provisioningStatus !== selectedStatus) return false;

            return this.searchMatches(
              contact,
              ["name", "phoneNumber", "mikrotikUsername", "mikrotikProfile", "linkedApHost", "hotspotReactivationAt", "hotspotProvisioningStatus", "hotspotProvisioningError"],
              this.filters.contactHotspot.search
            );
          });
        },

        get filteredApMonitors() {
          return this.apMonitors.filter((ap) => {
            const selectedStatus = String(this.filters.monitorAp.status || "ALL").toUpperCase();
            const status = String(ap.status || "UNKNOWN").toUpperCase();
            if (selectedStatus !== "ALL" && status !== selectedStatus) return false;
            return this.searchMatches(
              ap,
              ["host", "status", "since", "comment", "interval", "timeout", "type"],
              this.filters.monitorAp.search
            );
          });
        },

        get filteredReminders() {
          const now = Date.now();
          return this.reminders.filter((reminder) => {
            const reminderTime = new Date(reminder.reminderDateTime).getTime();
            const schedule = this.filters.reminders.schedule;
            if (schedule === "TODAY" && !this.isToday(reminder.reminderDateTime)) return false;
            if (schedule === "UPCOMING" && (!Number.isFinite(reminderTime) || reminderTime < now)) return false;
            if (schedule === "OVERDUE" && (!Number.isFinite(reminderTime) || reminderTime >= now)) return false;
            return this.searchMatches(reminder, ["contactName", "phoneNumber", "templateName", "message", "reminderDateTime"], this.filters.reminders.search);
          });
        },

        get filteredSent() {
          return this.sent.filter((item) => {
            const status = String(item.deliveryStatus || "SENT").toUpperCase();
            if (this.filters.sent.status !== "ALL" && status !== this.filters.sent.status) return false;
            return this.searchMatches(item, ["contactName", "phoneNumber", "deliveryStatus", "message", "sentAt", "reminderDateTime"], this.filters.sent.search);
          });
        },

        get paginatedContacts() {
          return this.paginate(this.filteredContacts, "contacts");
        },

        get paginatedBillingContacts() {
          return this.paginate(this.filteredBillingContacts, "contactBilling");
        },

        get paginatedHotspotContacts() {
          return this.paginate(this.filteredHotspotContacts, "contactHotspot");
        },

        get paginatedApMonitors() {
          return this.paginate(this.filteredApMonitors, "monitorAp");
        },

        get paginatedReminders() {
          return this.paginate(this.filteredReminders, "reminders");
        },

        get paginatedSent() {
          return this.paginate(this.filteredSent, "sent");
        },

        get filteredLogs() {
          return this.logs;
        },

        get paginatedLogs() {
          return this.paginate(this.filteredLogs, "logs");
        },

        paginate(items, key) {
          this.clampPage(key, items.length);
          const pageSize = this.filters[key].pageSize;
          const start = (this.filters[key].page - 1) * pageSize;
          return items.slice(start, start + pageSize);
        },

        totalPages(key, total) {
          return Math.max(1, Math.ceil(total / this.filters[key].pageSize));
        },

        clampPage(key, total) {
          const max = this.totalPages(key, total);
          if (this.filters[key].page > max) this.filters[key].page = max;
          if (this.filters[key].page < 1) this.filters[key].page = 1;
        },

        setPage(key, page) {
          const totalsByKey = {
            contacts: this.filteredContacts.length,
            contactBilling: this.filteredBillingContacts.length,
            contactHotspot: this.filteredHotspotContacts.length,
            monitorAp: this.filteredApMonitors.length,
            reminders: this.filteredReminders.length,
            sent: this.filteredSent.length,
            logs: this.logs.length,
          };
          const total = totalsByKey[key] ?? 0;
          this.filters[key].page = Math.min(Math.max(1, page), this.totalPages(key, total));
        },

        resetPage(key) {
          this.filters[key].page = 1;
        },

        paginationLabel(key, total) {
          this.clampPage(key, total);
          if (!total) return "Menampilkan 0 data";
          const pageSize = this.filters[key].pageSize;
          const start = (this.filters[key].page - 1) * pageSize + 1;
          const end = Math.min(total, start + pageSize - 1);
          return `Menampilkan ${start}-${end} dari ${total} data`;
        },

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
            this.statusCards = [
              { label: `WhatsApp ${data.bot.selectedProvider || "Provider"}`, value: data.bot.deviceReady ? "Ready" : "Not ready", icon: data.bot.deviceReady ? "fa-solid fa-plug-circle-check" : "fa-solid fa-plug-circle-xmark" },
              { label: "Telegram", value: data.bot.telegramEnabled ? "Ready" : "Not ready", icon: "fa-brands fa-telegram" },
            ];
            this.summaryMetrics = [
              { label: "Pelanggan", value: data.summary.contacts, icon: "fa-solid fa-users", tone: "blue" },
              { label: "Reminder aktif", value: data.summary.reminders, icon: "fa-solid fa-calendar-check", tone: "violet" },
              { label: "Pesan terkirim", value: data.summary.sentReminders, icon: "fa-solid fa-paper-plane", tone: "cyan" },
              { label: "Penerima admin", value: data.summary.adminRecipients, icon: "fa-solid fa-user-shield", tone: "slate" },
              { label: "Sudah bayar", value: data.summary.paidContacts, icon: "fa-solid fa-circle-check", tone: "green" },
              { label: "Belum bayar", value: data.summary.unpaidContacts, icon: "fa-solid fa-clock", tone: "amber" },
              { label: "Masih ada hutang", value: data.summary.debtContacts || 0, icon: "fa-solid fa-file-invoice-dollar" },
            ];
            this.updateApSummaryMetrics();
            if (!this.settingsDirty) {
              this.forms.settings = {
                dashboardTitle: data.settings.dashboardTitle || "",
                companyName: data.settings.companyName || "",
                supportSignature: data.settings.supportSignature || "",
                apDownMessageTemplate: data.settings.apDownMessageTemplate || "",
                customerAccountMessageTemplate: data.settings.customerAccountMessageTemplate || "",
                paymentMessageTemplateArrearsOnly: data.settings.paymentMessageTemplateArrearsOnly || "",
                paymentMessageTemplateCurrentOnly: data.settings.paymentMessageTemplateCurrentOnly || "",
                paymentMessageTemplateFullPaid: data.settings.paymentMessageTemplateFullPaid || "",
                billingReminderMessageTemplate: data.settings.billingReminderMessageTemplate || "",
                timezone: data.settings.timezone || "",
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

        async loadApMonitors() {
          this.apMonitors = await this.api("/api/mikrotik/netwatch");
          this.updateApSummaryMetrics();
          this.clampPage("monitorAp", this.filteredApMonitors.length);
        },

        updateApSummaryMetrics() {
          if (!Array.isArray(this.summaryMetrics) || this.summaryMetrics.length === 0) return;

          const apUp = this.apMonitors.filter((ap) => {
            const status = String(ap?.status || "").toUpperCase();
            return ["UP", "ONLINE", "OK"].includes(status);
          }).length;

          const apDown = this.apMonitors.filter((ap) => {
            const status = String(ap?.status || "").toUpperCase();
            return ["DOWN", "OFFLINE", "FAIL"].includes(status);
          }).length;

          const baseMetrics = this.summaryMetrics.filter(
            (metric) => metric.label !== "AP online" && metric.label !== "AP bermasalah"
          );

          this.summaryMetrics = [
            ...baseMetrics,
            { label: "AP online", value: apUp, icon: "fa-solid fa-wifi", tone: "green" },
            { label: "AP bermasalah", value: apDown, icon: "fa-solid fa-triangle-exclamation", tone: "red" },
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
          this.templates = await this.api("/api/templates");
        },

        async loadRecipients() {
          const recipients = await this.api("/api/admin-recipients");
          this.forms.recipients = recipients.join("\n");
        },

        async loadLogs(options = {}) {
          this.logs = await this.api("/api/logs", { silent: Boolean(options.silent) });
          this.clampPage("logs", this.logs.length);
        },

        getContactCreatePayload() {
          return {
            name: this.forms.contact.name,
            phoneNumber: this.forms.contact.phoneNumber,
            linkedApHost: this.forms.contact.linkedApHost,
            subscriptionType: this.forms.contact.subscriptionType,
          };
        },

        async createContact() {
          const payload = this.getContactCreatePayload();
          const result = await this.api("/api/contacts", {
            method: "POST",
            body: JSON.stringify(payload),
          });
          this.forms.contact = this.blankContactForm();
          this.notify(`Pelanggan ${result.name || payload.name} berhasil disimpan. Akun hotspot dapat dibuat dari tab Hotspot.`);
          return result;
        },

        openContactCreateModal() {
          this.forms.contact = this.blankContactForm();
          this.clearFormError("contact");
          this.contactCreateModal.open = true;
          document.body.classList.add("overflow-hidden");
        },

        closeContactCreateModal() {
          this.contactCreateModal.open = false;
          this.contactCreateModal.loading = false;
          this.forms.contact = this.blankContactForm();
          this.clearFormError("contact");
          document.body.classList.remove("overflow-hidden");
        },

        async submitCreateContact() {
          if (this.contactCreateModal.loading) return;
          this.contactCreateModal.loading = true;
          this.clearFormError("contact");
          try {
            await this.withProcessing("Mendaftarkan pelanggan...", async () => {
              await this.createContact();
              await Promise.all([this.loadContacts(), this.loadReminders(), this.loadStatus(), this.loadLogs()]);
              this.closeContactCreateModal();
            });
          } catch (error) {
            this.setFormError("contact", error);
            await Promise.all([this.loadContacts(), this.loadStatus(), this.loadLogs()]).catch(() => {});
          } finally {
            this.contactCreateModal.loading = false;
          }
        },

        async openContactEditModal(contact) {
          this.forms.contactEdit = {
            id: contact.id,
            name: contact.name || "",
            phoneNumber: contact.phoneNumber || "",
            linkedApHost: contact.linkedApHost || "",
            subscriptionType: contact.subscriptionType || "RECURRING",
          };
          this.clearFormError("contactEdit");
          this.contactEditModal.open = true;
          document.body.classList.add("overflow-hidden");
        },

        closeContactEditModal() {
          this.contactEditModal.open = false;
          this.contactEditModal.loading = false;
          this.forms.contactEdit = this.blankContactForm();
          this.clearFormError("contactEdit");
          document.body.classList.remove("overflow-hidden");
        },

        async saveContactEdit() {
          if (!this.forms.contactEdit.id || this.contactEditModal.loading) return;
          this.contactEditModal.loading = true;
          this.clearFormError("contactEdit");
          try {
            await this.withProcessing("Menyimpan perubahan kontak...", async () => {
              const result = await this.api(`/api/contacts/${this.forms.contactEdit.id}`, {
                method: "PUT",
                body: JSON.stringify({
                  name: this.forms.contactEdit.name,
                  phoneNumber: this.forms.contactEdit.phoneNumber,
                  linkedApHost: this.forms.contactEdit.linkedApHost,
                  subscriptionType: this.forms.contactEdit.subscriptionType,
                }),
              });
              this.notify(result.hotspotSynced
                ? "Contact diperbarui dan akun hotspot sudah disinkronkan ke MikroTik."
                : "Contact diperbarui.");
              this.closeContactEditModal();
              await Promise.all([this.loadContacts(), this.loadReminders(), this.loadStatus(), this.loadLogs()]);
            });
          } catch (error) {
            this.setFormError("contactEdit", error);
            await Promise.all([this.loadContacts(), this.loadStatus(), this.loadLogs()]).catch(() => {});
          } finally {
            this.contactEditModal.loading = false;
          }
        },

        async openHotspotAccountModal(contact = null) {
          const selected = contact || null;
          this.hotspotAccountModal.editingContactId = selected ? String(selected.id) : "";
          this.forms.hotspotAccount = this.blankHotspotAccountForm();
          if (selected) {
            this.forms.hotspotAccount.contactId = String(selected.id);
            this.forms.hotspotAccount.username = selected.mikrotikUsername || this.suggestHotspotUsername(selected.name);
            this.forms.hotspotAccount.profile = selected.mikrotikProfile || "";
            this.forms.hotspotAccount.password = selected.mikrotikUsername ? "" : String(selected.phoneNumber || "").slice(-5);
            this.forms.hotspotAccount.sendCredentials = !selected.mikrotikUsername;
            this.forms.hotspotAccount.reactivationEnabled = this.isHotspotReactivationAllowed()
              && Boolean(selected.hotspotReactivationEnabled);
            this.forms.hotspotAccount.reactivationDate = this.formatDateInput(selected.hotspotReactivationAt);
            this.forms.hotspotAccount.reactivationTime = this.formatTimeInput(selected.hotspotReactivationAt) || "00:00";
          }
          this.clearFormError("hotspotAccount");
          this.hotspotAccountModal.open = true;
          document.body.classList.add("overflow-hidden");
          await this.loadHotspotOptions("hotspotAccount", { silent: true });
        },

        closeHotspotAccountModal() {
          this.hotspotAccountModal.open = false;
          this.hotspotAccountModal.loading = false;
          this.hotspotAccountModal.editingContactId = "";
          this.forms.hotspotAccount = this.blankHotspotAccountForm();
          this.clearFormError("hotspotAccount");
          document.body.classList.remove("overflow-hidden");
        },

        onHotspotAccountContactChange() {
          const selected = this.contacts.find(
            (contact) => String(contact.id) === String(this.forms.hotspotAccount.contactId)
          );
          if (!selected) return;
          this.forms.hotspotAccount.username = selected.mikrotikUsername || this.suggestHotspotUsername(selected.name);
          this.forms.hotspotAccount.profile = selected.mikrotikProfile || "";
          this.forms.hotspotAccount.password = selected.mikrotikUsername ? "" : String(selected.phoneNumber || "").slice(-5);
          this.forms.hotspotAccount.sendCredentials = !selected.mikrotikUsername;
          this.forms.hotspotAccount.reactivationEnabled = this.isHotspotReactivationAllowed()
            && Boolean(selected.hotspotReactivationEnabled);
          this.forms.hotspotAccount.reactivationDate = this.formatDateInput(selected.hotspotReactivationAt);
          this.forms.hotspotAccount.reactivationTime = this.formatTimeInput(selected.hotspotReactivationAt) || "00:00";
        },

        async saveHotspotAccount() {
          if (this.hotspotAccountModal.loading) return;
          const form = this.forms.hotspotAccount;
          if (!form.contactId) return;
          this.hotspotAccountModal.loading = true;
          this.clearFormError("hotspotAccount");
          try {
            await this.withProcessing("Menyimpan akun hotspot...", async () => {
              const payload = {
                mikrotikUsername: form.username,
                mikrotikProfile: form.profile,
                sendCredentials: form.sendCredentials,
                hotspotReactivationEnabled: form.reactivationEnabled,
                hotspotReactivationAt: this.buildHotspotReactivationAt(form),
              };
              if (form.password) payload.mikrotikPassword = form.password;
              const result = await this.api(`/api/contacts/${form.contactId}/hotspot`, {
                method: "POST",
                body: JSON.stringify(payload),
              });
              this.notify(result.hotspotSynced ? "Akun hotspot berhasil disinkronkan ke MikroTik." : "Akun hotspot sudah tersimpan.");
              this.closeHotspotAccountModal();
              await Promise.all([this.loadContacts(), this.loadStatus(), this.loadLogs()]);
            });
          } catch (error) {
            this.setFormError("hotspotAccount", error);
            await Promise.all([this.loadContacts(), this.loadStatus(), this.loadLogs()]).catch(() => {});
          } finally {
            this.hotspotAccountModal.loading = false;
          }
        },

        async togglePayment(id, status, paymentType = "") {
          await this.withProcessing("Memperbarui status pembayaran...", async () => {
            const contact = this.contacts.find((item) => String(item.id) === String(id));
            const payload = { status };
            if (paymentType && contact) {
              payload.paymentType = paymentType || contact.paymentType || this.inferPaymentType(contact);
            }
            const result = await this.api(`/api/contacts/${id}/payment`, {
              method: "POST",
              body: JSON.stringify(payload),
            });
            if (status === "UNPAID" && payload.paymentType === "ARREARS-ONLY") {
              if (result.notificationSent) {
                this.notify(`Tunggakan dicatat. Notifikasi terkirim (${result.transactionId}).`);
              } else if (result.notificationError) {
                this.notify(`Tunggakan dicatat, tapi notifikasi gagal: ${result.notificationError}`);
              } else {
                this.notify("Tunggakan dicatat.");
              }
            } else if (status === "PAID") {
              if (result.notificationSent) {
                this.notify(`Status pembayaran diperbarui. Bukti pembayaran terkirim (${result.transactionId}).`);
              } else if (result.notificationError) {
                this.notify(`Status pembayaran diperbarui, tapi notifikasi gagal: ${result.notificationError}`);
              } else {
                this.notify("Status pembayaran diperbarui.");
              }
            } else {
              this.notify("Status pembayaran diperbarui.");
            }
            await Promise.all([this.loadContacts(), this.loadReminders(), this.loadStatus()]);
          });
        },

        async sendBillingReminder(contact) {
          if (!contact?.id) return;
          await this.withProcessing(`Mengirim pengingat ke ${contact.name}...`, async () => {
            const result = await this.api(`/api/contacts/${contact.id}/billing-reminder`, {
              method: "POST",
              body: JSON.stringify({}),
            });
            this.notify(`Pengingat tagihan terkirim ke ${result.phoneNumber}.`);
            await this.loadLogs({ silent: true });
          });
        },

        openAccountDeliveryModal(contact) {
          if (!contact?.id) return;
          this.accountDeliveryModal = {
            open: true,
            loading: false,
            contact,
            includePortal: true,
            includeHotspot: this.canSendHotspotAccount(contact),
          };
          this.clearFormError("accountDelivery");
          document.body.classList.add("overflow-hidden");
        },

        closeAccountDeliveryModal() {
          if (this.accountDeliveryModal.loading) return;
          this.accountDeliveryModal = {
            open: false,
            loading: false,
            contact: null,
            includePortal: true,
            includeHotspot: false,
          };
          this.clearFormError("accountDelivery");
          document.body.classList.remove("overflow-hidden");
        },

        async sendCustomerAccounts() {
          const modal = this.accountDeliveryModal;
          if (!modal.contact?.id || modal.loading) return;
          if (!modal.includePortal && !modal.includeHotspot) {
            this.setFormError("accountDelivery", "Pilih minimal satu akun yang akan dikirim.");
            return;
          }

          modal.loading = true;
          this.clearFormError("accountDelivery");
          try {
            const result = await this.api(`/api/contacts/${modal.contact.id}/account-credentials`, {
              method: "POST",
              body: JSON.stringify({
                includePortal: modal.includePortal,
                includeHotspot: modal.includeHotspot,
              }),
            });
            const labels = result.accounts.map((account) => account === "portal" ? "portal" : "hotspot").join(" dan ");
            modal.loading = false;
            this.closeAccountDeliveryModal();
            this.notify(`Akun ${labels} terkirim ke ${result.phoneNumber}.`);
            await this.loadLogs({ silent: true });
          } catch (error) {
            this.setFormError("accountDelivery", error);
          } finally {
            modal.loading = false;
          }
        },

        async reactivateHotspotContact(contact) {
          if (!contact?.id) return;
          await this.withProcessing("Mereaktivasi hotspot...", async () => {
            try {
              const result = await this.api(`/api/contacts/${contact.id}/hotspot/reactivate`, {
                method: "POST",
                body: JSON.stringify({}),
              });
              if (result.contact.hotspotReactivationEnabled && result.contact.hotspotReactivationAt) {
                this.notify(`Hotspot ${result.username} direaktivasi. Jadwal berikutnya ${this.formatDateTime(result.contact.hotspotReactivationAt)}.`);
              } else {
                this.notify(`Hotspot ${result.username} direaktivasi.`);
              }
            } finally {
              await Promise.all([this.loadContacts(), this.loadStatus(), this.loadLogs()]);
            }
          });
        },

        setHotspotDisabled(contact, disabled) {
          if (!contact?.id) return;
          const action = disabled ? "menonaktifkan" : "mengaktifkan";
          this.openDeleteConfirm({
            title: `${disabled ? "Nonaktifkan" : "Aktifkan"} akun hotspot?`,
            description: disabled
              ? `Akun hotspot ${contact.mikrotikUsername || "ini"} akan dinonaktifkan di MikroTik dan sesi aktifnya akan diputus. Data akun tetap tersimpan.`
              : `Akun hotspot ${contact.mikrotikUsername || "ini"} akan diaktifkan kembali di MikroTik.`,
            confirmLabel: disabled ? "Nonaktifkan" : "Aktifkan",
            action: async () => {
              await this.api(`/api/contacts/${contact.id}/hotspot/${disabled ? "disable" : "enable"}`, {
                method: "POST",
                body: JSON.stringify({}),
              });
              this.notify(`Akun hotspot berhasil ${action}.`);
              await Promise.all([this.loadContacts(), this.loadStatus(), this.loadLogs()]);
            },
          });
        },

        async retryHotspotProvisioning(contact) {
          if (!contact?.id || !this.canRetryHotspotProvisioning(contact)) return;
          await this.withProcessing("Mencoba provisioning hotspot...", async () => {
            try {
              const result = await this.api(`/api/contacts/${contact.id}/hotspot/provision`, {
                method: "POST",
                body: JSON.stringify({}),
              });
              const notificationText = result.notification?.sent
                ? " Kredensial terkirim ke WhatsApp."
                : (result.notification?.error ? ` WA belum terkirim: ${result.notification.error}` : "");
              if (result.operation === "DEACTIVATE") {
                this.notify(`Hotspot ${result.username} berhasil dinonaktifkan.`);
              } else {
                this.notify(`Hotspot ${result.username} berhasil diaktifkan.${notificationText}`);
              }
            } finally {
              await Promise.all([this.loadContacts(), this.loadStatus(), this.loadLogs()]);
            }
          });
        },

        removeContact(contact) {
          const label = contact?.name ? `"${contact.name}"` : "ini";
          this.openDeleteConfirm({
            title: "Hapus kontak?",
            description: contact?.name
              ? `Kontak ${label} akan dihapus dari daftar. Tindakan ini tidak bisa dibatalkan.`
              : "Kontak ini akan dihapus dari daftar. Tindakan ini tidak bisa dibatalkan.",
            action: async () => {
              await this.api(`/api/contacts/${contact.id}`, { method: "DELETE" });
              this.notify("Contact dihapus.");
              await Promise.all([this.loadContacts(), this.loadReminders(), this.loadStatus()]);
            },
          });
        },

        applyTemplateContent(templateContent, contact, dateIso) {
          let msg = String(templateContent || "");
          if (contact && contact.name) {
            msg = msg.replace(/{{\s*name\s*}}/gi, contact.name);
          }
          if (dateIso) {
            try {
              msg = msg.replace(/{{\s*date\s*}}/gi, new Date(dateIso).toLocaleString("id-ID", { timeZone: this.getAppTimezone() }));
            } catch {}
          }
          return msg;
        },

        applySelectedTemplate() {
          const name = this.forms.reminder.templateName;
          if (!name) return;
          const tpl = this.templates.find((t) => t.name === name);
          if (!tpl) return;
          this.forms.reminder.message = tpl.content || "";
        },
        onManualContactChange() {
          const selected = this.contacts.find((c) => String(c.id) === String(this.forms.manual.contactId));
          if (selected) {
            this.forms.manual.phoneNumber = selected.phoneNumber || "";
          }
          if (this.forms.manual.templateName) {
            this.applyManualTemplate();
          }
        },

        applyManualTemplate() {
          const name = this.forms.manual.templateName;
          if (!name) return;
          const tpl = this.templates.find((t) => t.name === name);
          if (!tpl) return;
          const contact = this.contacts.find((c) => String(c.id) === String(this.forms.manual.contactId)) || null;
          this.forms.manual.message = this.applyTemplateContent(tpl.content, contact, new Date().toISOString());
        },
        applyBroadcastTemplate() {
          const name = this.forms.broadcast.templateName;
          if (!name) return;
          const tpl = this.templates.find((t) => t.name === name);
          if (!tpl) return;
          this.forms.broadcast.message = tpl.content || "";
        },

        onReminderContactChange() {
          if (this.forms.reminder.templateName) {
            this.applySelectedTemplate();
          }
        },

        async createReminder() {
          this.clearFormError("reminder");
          const date = this.forms.reminder.reminderDate;
          const time = this.forms.reminder.reminderTime || '00:00';
          if (!date) {
            this.setFormError("reminder", "Pilih tanggal pengiriman.");
            return false;
          }
          const datetime = `${date} ${time}`;

          const payload = {
            contactId: this.forms.reminder.contactId,
            reminderDateTime: datetime,
            message: this.forms.reminder.message,
            templateName: this.forms.reminder.templateName,
          };

          await this.api("/api/reminders", {
            method: "POST",
            body: JSON.stringify(payload),
          });

          this.forms.reminder = { id: "", contactId: "", reminderDate: "", reminderTime: "", templateName: "", message: "" };
          await Promise.all([this.loadReminders(), this.loadStatus()]);
          return true;
        },

        openReminderCreateModal() {
          this.forms.reminder = { id: "", contactId: "", reminderDate: "", reminderTime: "", templateName: "", message: "" };
          this.clearFormError("reminder");
          this.reminderCreateModal.open = true;
          document.body.classList.add("overflow-hidden");
        },

        closeReminderCreateModal() {
          this.reminderCreateModal.open = false;
          this.reminderCreateModal.loading = false;
          this.forms.reminder = { id: "", contactId: "", reminderDate: "", reminderTime: "", templateName: "", message: "" };
          this.clearFormError("reminder");
          document.body.classList.remove("overflow-hidden");
        },

        async submitCreateReminder() {
          if (this.reminderCreateModal.loading) return;
          this.reminderCreateModal.loading = true;
          this.clearFormError("reminder");
          try {
            await this.withProcessing("Menyimpan reminder...", async () => {
              const created = await this.createReminder();
              if (created) {
                this.notify("Reminder dibuat.");
                this.closeReminderCreateModal();
              }
            });
          } catch (error) {
            this.setFormError("reminder", error);
          } finally {
            this.reminderCreateModal.loading = false;
          }
        },

        openReminderEditModal(reminder) {
          this.forms.reminderEdit = {
            id: reminder.id,
            contactId: reminder.contactId || "",
            reminderDate: this.formatDateInput(reminder.reminderDateTime),
            reminderTime: this.formatTimeInput(reminder.reminderDateTime),
            templateName: reminder.templateName || "",
            message: reminder.messageSource || reminder.message || "",
          };
          this.clearFormError("reminderEdit");
          this.reminderEditModal.open = true;
          document.body.classList.add("overflow-hidden");
        },

        closeReminderEditModal() {
          this.reminderEditModal.open = false;
          this.reminderEditModal.loading = false;
          this.forms.reminderEdit = { id: "", contactId: "", reminderDate: "", reminderTime: "", templateName: "", message: "" };
          this.clearFormError("reminderEdit");
          document.body.classList.remove("overflow-hidden");
        },

        applyReminderEditTemplate() {
          const name = this.forms.reminderEdit.templateName;
          if (!name) return;
          const tpl = this.templates.find((t) => t.name === name);
          if (!tpl) return;
          this.forms.reminderEdit.message = tpl.content || "";
        },

        onReminderEditContactChange() {
          if (this.forms.reminderEdit.templateName) {
            this.applyReminderEditTemplate();
          }
        },

        async saveReminderEdit() {
          if (!this.forms.reminderEdit.id || this.reminderEditModal.loading) return;
          const date = this.forms.reminderEdit.reminderDate;
          const time = this.forms.reminderEdit.reminderTime || "00:00";
          if (!date) {
            this.setFormError("reminderEdit", "Pilih tanggal pengiriman.");
            return;
          }

          this.reminderEditModal.loading = true;
          this.clearFormError("reminderEdit");
          try {
            await this.withProcessing("Menyimpan perubahan reminder...", async () => {
              await this.api(`/api/reminders/${this.forms.reminderEdit.id}`, {
                method: "PUT",
                body: JSON.stringify({
                  contactId: this.forms.reminderEdit.contactId,
                  reminderDateTime: `${date} ${time}`,
                  message: this.forms.reminderEdit.message,
                  templateName: this.forms.reminderEdit.templateName,
                }),
              });
              this.notify("Reminder diperbarui.");
              this.closeReminderEditModal();
              await Promise.all([this.loadReminders(), this.loadStatus(), this.loadContacts()]);
            });
          } catch (error) {
            this.setFormError("reminderEdit", error);
          } finally {
            this.reminderEditModal.loading = false;
          }
        },

        removeReminder(reminder) {
          const label = reminder?.contactName ? `untuk "${reminder.contactName}"` : "ini";
          this.openDeleteConfirm({
            title: "Hapus reminder?",
            description: `Reminder ${label} akan dihapus. Tindakan ini tidak bisa dibatalkan.`,
            action: async () => {
              await this.api(`/api/reminders/${reminder.id}`, { method: "DELETE" });
              this.notify("Reminder dihapus.");
              await Promise.all([this.loadReminders(), this.loadStatus()]);
            },
          });
        },

        async createTemplate() {
          this.clearFormError("template");
          try {
            await this.withProcessing("Menyimpan template...", async () => {
              await this.api("/api/templates", {
                method: "POST",
                body: JSON.stringify(this.forms.template),
              });
              this.forms.template = { name: "", content: "" };
              this.notify("Template disimpan.");
              await this.loadTemplates();
            });
          } catch (error) {
            this.setFormError("template", error);
          }
        },

        removeTemplate(template) {
          this.openDeleteConfirm({
            title: "Hapus template?",
            description: `Template "${template.name}" akan dihapus dari penyimpanan. Tindakan ini tidak bisa dibatalkan.`,
            action: async () => {
              await this.api(`/api/templates/${encodeURIComponent(template.name)}`, { method: "DELETE" });
              this.notify("Template dihapus.");
              await this.loadTemplates();
            },
          });
        },

        async saveSettings() {
          this.clearFormError("settings");
          try {
            await this.withProcessing("Menyimpan settings...", async () => {
              await this.api("/api/settings", {
                method: "PUT",
                body: JSON.stringify(this.forms.settings),
              });
              this.settingsDirty = false;
              this.notify("Settings diperbarui.");
              await this.loadStatus();
            });
          } catch (error) {
            this.setFormError("settings", error);
          }
        },

        async sendManualNotification() {
          this.clearFormError("manual");
          try {
            await this.withProcessing("Mengirim notifikasi...", async () => {
              await this.api("/api/notifications/test", {
                method: "POST",
                body: JSON.stringify(this.forms.manual),
              });
              this.forms.manual = { contactId: "", phoneNumber: "", templateName: "", message: "" };
              this.notify("Notifikasi diterima WhatsApp; status pengiriman sedang dipantau.");
              await this.loadLogs();
            });
          } catch (error) {
            this.setFormError("manual", error);
          }
        },

        async sendBroadcast() {
          this.clearFormError("broadcast");
          try {
            await this.withProcessing("Mengirim broadcast...", async () => {
              const response = await this.api("/api/notifications/broadcast", {
                method: "POST",
                body: JSON.stringify(this.forms.broadcast),
              });
              const successCount = response.filter(r => r.status === "sent").length;
              const failedCount = response.filter(r => r.status === "failed").length;
              this.forms.broadcast = { title: "", templateName: "", message: "" };
              this.notify(`Broadcast terkirim: ${successCount} berhasil, ${failedCount} gagal.`);
              await this.loadLogs();
            });
          } catch (error) {
            this.setFormError("broadcast", error);
          }
        },

        async sendMikrotikBackupNow() {
          if (this.loading.mikrotikBackup) return;
          this.loading.mikrotikBackup = true;
          try {
            await this.withProcessing("Membuat dan mengirim backup MikroTik...", async () => {
              const response = await this.api("/api/mikrotik/backup/send", {
                method: "POST",
                body: JSON.stringify({}),
              });
              const results = Array.isArray(response.results) ? response.results : [];
              const successCount = results.filter((item) => item.status === "sent").length;
              const failedCount = results.filter((item) => item.status === "failed").length;
              const fileName = response.fileName ? ` (${response.fileName})` : "";

              if (successCount > 0 && failedCount === 0) {
                this.notify(`Backup MikroTik terkirim ke ${successCount} admin${fileName}.`);
              } else if (successCount > 0) {
                this.notify(`Backup MikroTik terkirim ${successCount}, gagal ${failedCount}${fileName}.`);
              } else {
                this.notify(`Backup MikroTik dibuat, tapi gagal dikirim ke semua admin${fileName}.`);
              }

              await Promise.allSettled([this.loadLogs(), this.loadStatus()]);
            });
          } finally {
            this.loading.mikrotikBackup = false;
          }
        },

        async saveRecipients() {
          this.clearFormError("recipients");
          try {
            await this.withProcessing("Menyimpan admin recipients...", async () => {
              await this.api("/api/admin-recipients", {
                method: "PUT",
                body: JSON.stringify({ recipients: this.forms.recipients }),
              });
              this.notify("Admin recipients diperbarui.");
              await Promise.all([this.loadRecipients(), this.loadStatus()]);
            });
          } catch (error) {
            this.setFormError("recipients", error);
          }
        },

        async runScheduler() {
          await this.withProcessing("Menjalankan scheduler...", async () => {
            await this.api("/api/scheduler/run", {
              method: "POST",
              body: JSON.stringify({}),
            });
            this.notify("Scheduler dipicu manual.");
            await this.refreshAll();
          });
        },

        async logout() {
          await this.withProcessing("Keluar dari dashboard...", async () => {
            await this.api("/api/auth/logout", {
              method: "POST",
              body: JSON.stringify({}),
            });
            window.location.href = "/login";
          });
        },
      };
    }
