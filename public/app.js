    function dashboardApp() {
      return {
        loading: {
          status: false,
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
        toastQueue: [],
        deleteConfirm: {
          open: false,
          loading: false,
          title: "",
          description: "",
          action: null,
        },
        contactEditModal: {
          open: false,
          loading: false,
        },
        contactCreateModal: {
          open: false,
          loading: false,
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
        navMenus: [
          { key: "overview", label: "Overview", icon: "fa-solid fa-chart-pie" },
          { key: "notifications", label: "Notifikasi", icon: "fa-solid fa-paper-plane" },
          { key: "contacts", label: "Contacts", icon: "fa-solid fa-address-book" },
          { key: "monitor-ap", label: "Monitor AP", icon: "fa-solid fa-tower-cell" },
          { key: "reminders", label: "Reminders", icon: "fa-solid fa-calendar-check" },
          { key: "templates", label: "Templates", icon: "fa-solid fa-file-pen" },
          { key: "settings", label: "Settings", icon: "fa-solid fa-sliders" },
          { key: "history", label: "Sent History", icon: "fa-solid fa-clock-rotate-left" },
          { key: "logs", label: "Activity Log", icon: "fa-solid fa-list-check" },
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
          contacts: { search: "", status: "ALL", dueStatus: "ALL", page: 1, pageSize: 10 },
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
            mikrotikUsername: "",
            mikrotikProfile: "",
            mikrotikPassword: "",
            createHotspotAccount: false,
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
            mikrotikUsername: "",
            mikrotikProfile: "",
            mikrotikPassword: "",
            hotspotReactivationEnabled: false,
            hotspotReactivationDate: "",
            hotspotReactivationTime: "",
          },
          reminderEdit: { id: "", contactId: "", reminderDate: "", reminderTime: "", templateName: "", message: "" },
          template: { name: "", content: "" },
          settings: {
            dashboardTitle: "",
            companyName: "",
            supportSignature: "",
            apDownMessageTemplate: "",
            paymentMessageTemplateArrearsOnly: "",
            paymentMessageTemplateCurrentOnly: "",
            paymentMessageTemplateFullPaid: "",
            timezone: "",
            autoRescheduleMonthly: false,
            notifyAdminsOnDelivery: false,
            notifyAdminsOnConnectionChange: false,
            notifyAdminsOnPaymentReset: false,
          },
        },

        async init() {
          const savedMenu = localStorage.getItem("dashboardActiveMenu");
          const isValidSavedMenu = this.navMenus.some((menu) => menu.key === savedMenu);
          if (isValidSavedMenu) {
            this.activeMenu = savedMenu;
          }

          this.$watch("activeMenu", (value) => {
            localStorage.setItem("dashboardActiveMenu", value);
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
              this.loadStatus({ silent: true });
            }
          }, statusInterval));

          this.pollers.push(setInterval(() => {
            if (!document.hidden && this.activeMenu === "logs") {
              this.loadLogs({ silent: true });
            }
          }, logsInterval));
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

        openDeleteConfirm({ title, description, action }) {
          this.deleteConfirm = {
            open: true,
            loading: false,
            title,
            description,
            action,
          };
          document.body.classList.add("overflow-hidden");
        },

        closeDeleteConfirm() {
          this.deleteConfirm.open = false;
          this.deleteConfirm.loading = false;
          this.deleteConfirm.title = "";
          this.deleteConfirm.description = "";
          this.deleteConfirm.action = null;
          document.body.classList.remove("overflow-hidden");
        },

        async confirmDeleteAction() {
          if (!this.deleteConfirm.action || this.deleteConfirm.loading) return;
          this.deleteConfirm.loading = true;
          try {
            await this.deleteConfirm.action();
          } finally {
            this.closeDeleteConfirm();
          }
        },

        formatDateTime(value) {
          return new Date(value).toLocaleString("id-ID");
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
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) return "";
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, "0");
          const day = String(date.getDate()).padStart(2, "0");
          return `${year}-${month}-${day}`;
        },

        formatTimeInput(value) {
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) return "";
          const hours = String(date.getHours()).padStart(2, "0");
          const minutes = String(date.getMinutes()).padStart(2, "0");
          return `${hours}:${minutes}`;
        },

        blankContactForm() {
          return {
            id: "",
            name: "",
            phoneNumber: "",
            linkedApHost: "",
            mikrotikUsername: "",
            mikrotikProfile: "",
            mikrotikPassword: "",
            createHotspotAccount: false,
            sendCredentials: true,
            hotspotReactivationEnabled: false,
            hotspotReactivationDate: "",
            hotspotReactivationTime: "",
          };
        },

        buildHotspotReactivationAt(form) {
          if (!form.hotspotReactivationEnabled || !form.hotspotReactivationDate) return "";
          return `${form.hotspotReactivationDate} ${form.hotspotReactivationTime || "00:00"}`;
        },

        getContactHotspotLabel(contact) {
          if (!contact.mikrotikUsername) return "-";
          const profile = contact.mikrotikProfile ? ` / ${contact.mikrotikProfile}` : "";
          return `${contact.mikrotikUsername}${profile}`;
        },

        getReactivationLabel(contact) {
          if (!contact.hotspotReactivationEnabled) return "Nonaktif";
          if (!contact.hotspotReactivationAt) return "Belum dijadwalkan";
          return this.formatDateTime(contact.hotspotReactivationAt);
        },

        getHotspotUserOptionLabel(user) {
          const profile = user?.profile ? ` - ${user.profile}` : "";
          const source = user?.source === "active" ? " - aktif" : "";
          const disabled = user?.disabled ? " (disabled)" : "";
          return `${user?.username || "-"}${profile}${source}${disabled}`;
        },

        hasHotspotUser(username) {
          const needle = String(username || "").trim().toLowerCase();
          if (!needle) return true;
          return this.hotspotUsers.some((user) => String(user.username || "").trim().toLowerCase() === needle);
        },

        hasMikrotikProfile(profileName) {
          const needle = String(profileName || "").trim().toLowerCase();
          if (!needle) return true;
          return this.mikrotikProfiles.some((profile) => String(profile.name || "").trim().toLowerCase() === needle);
        },

        syncHotspotUserToForm(formKey) {
          const form = this.forms[formKey];
          if (!form) return;
          const username = String(form.mikrotikUsername || "").trim().toLowerCase();
          if (!username) return;
          const selected = this.hotspotUsers.find((user) => String(user.username || "").trim().toLowerCase() === username);
          if (selected?.profile) {
            form.mikrotikProfile = selected.profile;
          }
        },

        inferPaymentType(contact, options = {}) {
           const { useSavedType = true } = options;
           const savedType = String(contact.paymentType || "").toUpperCase();
           if (useSavedType && ["ARREARS-ONLY", "CURRENT-ONLY", "FULL-PAID"].includes(savedType)) {
             return savedType;
           }

           const paymentMonths = contact.paymentMonths || {};
           const now = new Date();
           const year = now.getFullYear();
           const month = now.getMonth() + 1;
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
          const now = new Date();
          const currentMonth = now.getMonth() + 1;
          const previousMonth = currentMonth === 1 ? 12 : currentMonth - 1;
          const previousYear = currentMonth === 1 ? now.getFullYear() - 1 : now.getFullYear();
          return `${monthNames[previousMonth]} ${previousYear}`;
        },

        hasDebt(contact) {
          if (contact.hasDebt !== undefined) return Boolean(contact.hasDebt);
          const type = this.inferPaymentType(contact);
          if (type === "FULL-PAID" || type === "ARREARS-ONLY") return false;

          const paymentMonths = contact.paymentMonths || {};
          const now = new Date();
          const year = now.getFullYear();
          const month = now.getMonth() + 1;
          const prevMonth = month === 1 ? 12 : month - 1;
          const prevYear = month === 1 ? year - 1 : year;
          const prevKey = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
          return paymentMonths[prevKey]?.status !== "PAID";
        },

        getDebtNote(contact) {
          return contact.debtNote || `Masih ada hutang ${contact.debtPeriodLabel || this.getPreviousBillingPeriodLabel()}.`;
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
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) return false;
          const today = new Date();
          return date.getFullYear() === today.getFullYear()
            && date.getMonth() === today.getMonth()
            && date.getDate() === today.getDate();
        },

        get filteredContacts() {
          return this.contacts.filter((contact) => {
            const selectedStatus = String(this.filters.contacts.status || "ALL").toUpperCase();
            const selectedDueStatus = String(this.filters.contacts.dueStatus || "ALL").toUpperCase();
            const paymentStatus = String(contact.paymentStatus || "UNPAID").toUpperCase();
            const savedPaymentType = String(contact.paymentType || "").toUpperCase();
            const dueStatus = String(contact.dueStatus || "NOT_SCHEDULED").toUpperCase();

            if (selectedStatus !== "ALL") {
              if (selectedStatus === "ARREARS-ONLY" && (savedPaymentType !== "ARREARS-ONLY" || paymentStatus === "PAID")) return false;
              if (selectedStatus === "UNPAID" && (paymentStatus === "PAID" || savedPaymentType === "ARREARS-ONLY")) return false;
              if (selectedStatus === "CURRENT-ONLY" && (savedPaymentType !== "CURRENT-ONLY" || paymentStatus !== "PAID")) return false;
              if (selectedStatus === "FULL-PAID" && (savedPaymentType !== "FULL-PAID" || paymentStatus !== "PAID")) return false;
            }
            if (selectedDueStatus !== "ALL" && dueStatus !== selectedDueStatus) return false;

            return this.searchMatches(
              contact,
              ["name", "phoneNumber", "linkedApHost", "mikrotikUsername", "mikrotikProfile", "paymentStatus", "paymentType", "debtNote", "dueStatus", "dueDate", "hotspotReactivationAt"],
              this.filters.contacts.search
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
          await this.loadStatus();
          await Promise.all([
            this.loadContacts(),
            this.loadReminders(),
            this.loadTemplates(),
          ]);
          await this.loadNonCriticalData();
        },

        async loadStatus(options = {}) {
          this.loading.status = true;
          try {
            const data = await this.api("/api/status", { silent: Boolean(options.silent) });
            this.billingPeriod = data.billingPeriod || this.billingPeriod;
            this.statusCards = [
              { label: "Transport", value: data.bot.isAvailable ? "Online" : "Offline", icon: data.bot.isAvailable ? "fa-solid fa-plug-circle-check" : "fa-solid fa-plug-circle-xmark" },
              { label: "QR", value: data.bot.currentQR ? "Ready to scan" : "No QR", icon: "fa-solid fa-qrcode" },
              { label: "Reconnect", value: data.bot.reconnectAttempts, icon: "fa-solid fa-rotate" },
            ];
            this.summaryMetrics = [
              { label: "Contacts", value: data.summary.contacts, icon: "fa-solid fa-address-book" },
              { label: "Queued reminders", value: data.summary.reminders, icon: "fa-solid fa-calendar-days" },
              { label: "Sent outputs", value: data.summary.sentReminders, icon: "fa-solid fa-paper-plane" },
              { label: "Admin recipients", value: data.summary.adminRecipients, icon: "fa-solid fa-user-shield" },
              { label: "Paid contacts", value: data.summary.paidContacts, icon: "fa-solid fa-circle-check" },
              { label: "Unpaid contacts", value: data.summary.unpaidContacts, icon: "fa-solid fa-triangle-exclamation" },
              { label: "Masih ada hutang", value: data.summary.debtContacts || 0, icon: "fa-solid fa-file-invoice-dollar" },
            ];
            this.updateApSummaryMetrics();
            if (!this.settingsDirty) {
              this.forms.settings = {
                dashboardTitle: data.settings.dashboardTitle || "",
                companyName: data.settings.companyName || "",
                supportSignature: data.settings.supportSignature || "",
                apDownMessageTemplate: data.settings.apDownMessageTemplate || "",
                paymentMessageTemplateArrearsOnly: data.settings.paymentMessageTemplateArrearsOnly || "",
                paymentMessageTemplateCurrentOnly: data.settings.paymentMessageTemplateCurrentOnly || "",
                paymentMessageTemplateFullPaid: data.settings.paymentMessageTemplateFullPaid || "",
                timezone: data.settings.timezone || "",
                autoRescheduleMonthly: Boolean(data.settings.autoRescheduleMonthly),
                notifyAdminsOnDelivery: Boolean(data.settings.notifyAdminsOnDelivery),
                notifyAdminsOnConnectionChange: Boolean(data.settings.notifyAdminsOnConnectionChange),
                notifyAdminsOnPaymentReset: Boolean(data.settings.notifyAdminsOnPaymentReset),
              };
            }
          } finally {
            this.loading.status = false;
          }
        },

        async loadContacts() {
          this.contacts = await this.api("/api/contacts");
          this.clampPage("contacts", this.filteredContacts.length);
        },

        async loadMikrotikProfiles(options = {}) {
          this.mikrotikProfiles = await this.api("/api/mikrotik/profiles", { silent: Boolean(options.silent) });
          if (!options.silent) this.notify(`${this.mikrotikProfiles.length} profile MikroTik dimuat.`);
        },

        async loadHotspotUsers(options = {}) {
          this.hotspotUsers = await this.api("/api/mikrotik/hotspot-users", { silent: Boolean(options.silent) });
          if (!options.silent) this.notify(`${this.hotspotUsers.length} user hotspot dimuat.`);
        },

        async loadHotspotOptions(formKey = "") {
          const results = await Promise.allSettled([
            this.loadHotspotUsers({ silent: true }),
            this.loadMikrotikProfiles({ silent: true }),
          ]);
          const failed = results.find((item) => item.status === "rejected");
          if (failed) {
            this.notify(failed.reason?.message || "Gagal load data MikroTik.");
            return;
          }
          if (formKey) {
            this.syncHotspotUserToForm(formKey);
          }
          this.notify(`${this.hotspotUsers.length} user hotspot dan ${this.mikrotikProfiles.length} profile dimuat.`);
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
            (metric) => metric.label !== "Status AP UP" && metric.label !== "Status AP DOWN"
          );

          this.summaryMetrics = [
            ...baseMetrics,
            { label: "Status AP UP", value: apUp, icon: "fa-solid fa-tower-cell" },
            { label: "Status AP DOWN", value: apDown, icon: "fa-solid fa-tower-cell" },
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
            mikrotikUsername: this.forms.contact.mikrotikUsername,
            mikrotikProfile: this.forms.contact.mikrotikProfile,
            mikrotikPassword: this.forms.contact.mikrotikPassword,
            hotspotReactivationEnabled: this.forms.contact.hotspotReactivationEnabled,
            hotspotReactivationAt: this.buildHotspotReactivationAt(this.forms.contact),
          };
        },

        getMikrotikCustomerPayload() {
          return {
            name: this.forms.contact.name,
            phoneNumber: this.forms.contact.phoneNumber,
            profile: this.forms.contact.mikrotikProfile,
            sendCredentials: this.forms.contact.sendCredentials,
          };
        },

        async createContact() {
          const payload = this.getContactCreatePayload();
          await this.api("/api/contacts", {
            method: "POST",
            body: JSON.stringify(payload),
          });
          this.forms.contact = this.blankContactForm();
          await Promise.all([this.loadContacts(), this.loadReminders(), this.loadStatus()]);
        },

        openContactCreateModal() {
          this.forms.contact = this.blankContactForm();
          this.contactCreateModal.open = true;
          document.body.classList.add("overflow-hidden");
        },

        closeContactCreateModal() {
          this.contactCreateModal.open = false;
          this.contactCreateModal.loading = false;
          this.forms.contact = this.blankContactForm();
          document.body.classList.remove("overflow-hidden");
        },

        async submitCreateContact() {
          if (this.contactCreateModal.loading) return;
          this.contactCreateModal.loading = true;
          try {
            if (this.forms.contact.createHotspotAccount) {
              const result = await this.registerMikrotikCustomer(this.getMikrotikCustomerPayload(), { reload: false, resetForm: false });
              if (result?.contact?.id && (this.forms.contact.linkedApHost || this.forms.contact.hotspotReactivationEnabled)) {
                await this.api(`/api/contacts/${result.contact.id}`, {
                  method: "PUT",
                  body: JSON.stringify({
                    ...result.contact,
                    linkedApHost: this.forms.contact.linkedApHost,
                    hotspotReactivationEnabled: this.forms.contact.hotspotReactivationEnabled,
                    hotspotReactivationAt: this.buildHotspotReactivationAt(this.forms.contact),
                  }),
                });
              }
              await Promise.all([this.loadContacts(), this.loadReminders(), this.loadStatus(), this.loadLogs()]);
            } else {
              await this.createContact();
              this.notify("Contact ditambahkan.");
            }
            this.closeContactCreateModal();
          } finally {
            this.contactCreateModal.loading = false;
          }
        },

        openContactEditModal(contact) {
          this.forms.contactEdit = {
            id: contact.id,
            name: contact.name || "",
            phoneNumber: contact.phoneNumber || "",
            linkedApHost: contact.linkedApHost || "",
            mikrotikUsername: contact.mikrotikUsername || "",
            mikrotikProfile: contact.mikrotikProfile || "",
            mikrotikPassword: contact.mikrotikPassword || "",
            hotspotReactivationEnabled: Boolean(contact.hotspotReactivationEnabled),
            hotspotReactivationDate: this.formatDateInput(contact.hotspotReactivationAt),
            hotspotReactivationTime: this.formatTimeInput(contact.hotspotReactivationAt) || "00:00",
          };
          this.contactEditModal.open = true;
          document.body.classList.add("overflow-hidden");
        },

        closeContactEditModal() {
          this.contactEditModal.open = false;
          this.contactEditModal.loading = false;
          this.forms.contactEdit = this.blankContactForm();
          document.body.classList.remove("overflow-hidden");
        },

        async saveContactEdit() {
          if (!this.forms.contactEdit.id || this.contactEditModal.loading) return;
          this.contactEditModal.loading = true;
          try {
            await this.api(`/api/contacts/${this.forms.contactEdit.id}`, {
              method: "PUT",
              body: JSON.stringify({
                name: this.forms.contactEdit.name,
                phoneNumber: this.forms.contactEdit.phoneNumber,
                linkedApHost: this.forms.contactEdit.linkedApHost,
                mikrotikUsername: this.forms.contactEdit.mikrotikUsername,
                mikrotikProfile: this.forms.contactEdit.mikrotikProfile,
                mikrotikPassword: this.forms.contactEdit.mikrotikPassword,
                hotspotReactivationEnabled: this.forms.contactEdit.hotspotReactivationEnabled,
                hotspotReactivationAt: this.buildHotspotReactivationAt(this.forms.contactEdit),
              }),
            });
            this.notify("Contact diperbarui.");
            this.closeContactEditModal();
            await Promise.all([this.loadContacts(), this.loadReminders(), this.loadStatus()]);
          } finally {
            this.contactEditModal.loading = false;
          }
        },

        async registerMikrotikCustomer(payload = null, options = {}) {
          const result = await this.api("/api/mikrotik/customers", {
            method: "POST",
            body: JSON.stringify(payload || this.getMikrotikCustomerPayload()),
          });
          if (options.resetForm !== false) {
            this.forms.contact = this.blankContactForm();
          }

          if (result.notification?.sent) {
            this.notify(`Pelanggan dibuat: ${result.username}. Akun terkirim ke WhatsApp.`);
          } else if (result.notification?.error) {
            this.notify(`Pelanggan dibuat: ${result.username}. WA belum terkirim: ${result.notification.error}`);
          } else {
            this.notify(`Pelanggan dibuat: ${result.username}.`);
          }

          if (options.reload !== false) {
            await Promise.all([this.loadContacts(), this.loadStatus(), this.loadLogs()]);
          }
          return result;
        },

        async togglePayment(id, status, paymentType = "") {
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
          await Promise.all([this.loadContacts(), this.loadStatus()]);
        },

        async reactivateHotspotContact(contact) {
          if (!contact?.id) return;
          const result = await this.api(`/api/contacts/${contact.id}/hotspot/reactivate`, {
            method: "POST",
            body: JSON.stringify({}),
          });
          if (result.contact.hotspotReactivationEnabled && result.contact.hotspotReactivationAt) {
            this.notify(`Hotspot ${result.username} direaktivasi. Jadwal berikutnya ${this.formatDateTime(result.contact.hotspotReactivationAt)}.`);
          } else {
            this.notify(`Hotspot ${result.username} direaktivasi.`);
          }
          await Promise.all([this.loadContacts(), this.loadStatus(), this.loadLogs()]);
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
              msg = msg.replace(/{{\s*date\s*}}/gi, new Date(dateIso).toLocaleString('id-ID'));
            } catch {}
          }
          return msg;
        },

        applySelectedTemplate() {
          const name = this.forms.reminder.templateName;
          if (!name) return;
          const tpl = this.templates.find((t) => t.name === name);
          if (!tpl) return;
          const contact = this.contacts.find((c) => c.id === this.forms.reminder.contactId) || null;
          const dateIso = (this.forms.reminder.reminderDate && this.forms.reminder.reminderTime) ? `${this.forms.reminder.reminderDate}T${this.forms.reminder.reminderTime}:00` : null;
          this.forms.reminder.message = this.applyTemplateContent(tpl.content, contact, dateIso);
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
          const date = this.forms.reminder.reminderDate;
          const time = this.forms.reminder.reminderTime || '00:00';
          if (!date) return this.notify('Pilih tanggal pengiriman');
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
        },

        openReminderCreateModal() {
          this.forms.reminder = { id: "", contactId: "", reminderDate: "", reminderTime: "", templateName: "", message: "" };
          this.reminderCreateModal.open = true;
          document.body.classList.add("overflow-hidden");
        },

        closeReminderCreateModal() {
          this.reminderCreateModal.open = false;
          this.reminderCreateModal.loading = false;
          this.forms.reminder = { id: "", contactId: "", reminderDate: "", reminderTime: "", templateName: "", message: "" };
          document.body.classList.remove("overflow-hidden");
        },

        async submitCreateReminder() {
          if (this.reminderCreateModal.loading) return;
          this.reminderCreateModal.loading = true;
          try {
            await this.createReminder();
            this.notify("Reminder dibuat.");
            this.closeReminderCreateModal();
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
            message: reminder.message || "",
          };
          this.reminderEditModal.open = true;
          document.body.classList.add("overflow-hidden");
        },

        closeReminderEditModal() {
          this.reminderEditModal.open = false;
          this.reminderEditModal.loading = false;
          this.forms.reminderEdit = { id: "", contactId: "", reminderDate: "", reminderTime: "", templateName: "", message: "" };
          document.body.classList.remove("overflow-hidden");
        },

        applyReminderEditTemplate() {
          const name = this.forms.reminderEdit.templateName;
          if (!name) return;
          const tpl = this.templates.find((t) => t.name === name);
          if (!tpl) return;
          const contact = this.contacts.find((c) => c.id === this.forms.reminderEdit.contactId) || null;
          const dateIso = (this.forms.reminderEdit.reminderDate && this.forms.reminderEdit.reminderTime)
            ? `${this.forms.reminderEdit.reminderDate}T${this.forms.reminderEdit.reminderTime}:00`
            : null;
          this.forms.reminderEdit.message = this.applyTemplateContent(tpl.content, contact, dateIso);
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
          if (!date) return this.notify("Pilih tanggal pengiriman");

          this.reminderEditModal.loading = true;
          try {
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
          await this.api("/api/templates", {
            method: "POST",
            body: JSON.stringify(this.forms.template),
          });
          this.forms.template = { name: "", content: "" };
          this.notify("Template disimpan.");
          await this.loadTemplates();
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
          await this.api("/api/settings", {
            method: "PUT",
            body: JSON.stringify(this.forms.settings),
          });
          this.settingsDirty = false;
          this.notify("Settings diperbarui.");
          await this.loadStatus();
        },

        async sendManualNotification() {
          await this.api("/api/notifications/test", {
            method: "POST",
            body: JSON.stringify(this.forms.manual),
          });
          this.forms.manual = { contactId: "", phoneNumber: "", templateName: "", message: "" };
          this.notify("Notifikasi manual terkirim.");
          await this.loadLogs();
        },

        async sendBroadcast() {
          const response = await this.api("/api/notifications/broadcast", {
            method: "POST",
            body: JSON.stringify(this.forms.broadcast),
          });
          const successCount = response.filter(r => r.status === "sent").length;
          const failedCount = response.filter(r => r.status === "failed").length;
          this.forms.broadcast = { title: "", templateName: "", message: "" };
          this.notify(`Broadcast terkirim: ${successCount} berhasil, ${failedCount} gagal.`);
          await this.loadLogs();
        },

        async saveRecipients() {
          await this.api("/api/admin-recipients", {
            method: "PUT",
            body: JSON.stringify({ recipients: this.forms.recipients }),
          });
          this.notify("Admin recipients diperbarui.");
          await Promise.all([this.loadRecipients(), this.loadStatus()]);
        },

        async runScheduler() {
          await this.api("/api/scheduler/run", {
            method: "POST",
            body: JSON.stringify({}),
          });
          this.notify("Scheduler dipicu manual.");
          await this.refreshAll();
        },

        async logout() {
          await this.api("/api/auth/logout", {
            method: "POST",
            body: JSON.stringify({}),
          });
          window.location.href = "/login";
        },
      };
    }
