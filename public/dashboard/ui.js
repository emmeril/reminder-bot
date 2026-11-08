function createDashboardUi() {
  return {
        async init() {
          const requestedMenu = new URLSearchParams(window.location.search).get("menu");
          const savedMenu = requestedMenu || localStorage.getItem("dashboardActiveMenu");
          const savedContactTab = localStorage.getItem("dashboardContactTab");
          const savedSettingsTab = localStorage.getItem("dashboardSettingsTab");
          const savedRevenueTab = localStorage.getItem("dashboardRevenueTab");
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
          if (["general", "rates", "isolation", "backup", "messages", "automation"].includes(savedSettingsTab)) {
            this.activeSettingsTab = savedSettingsTab;
          }
          if (["customers", "vouchers"].includes(savedRevenueTab)) {
            this.activeRevenueTab = savedRevenueTab;
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
          this.$watch("activeSettingsTab", (value) => {
            localStorage.setItem("dashboardSettingsTab", value);
          });
          this.$watch("activeRevenueTab", (value) => {
            localStorage.setItem("dashboardRevenueTab", value);
          });

          await this.loadStatus();
          await Promise.all([
            this.loadContacts(),
            this.loadReminders(),
            this.loadTemplates(),
          ]);

          if (this.activeMenu === "vouchers") {
            void this.loadVisibleVoucherData();
          }
          if (this.activeMenu === "revenue" && this.activeRevenueTab === "vouchers") {
            void this.loadVoucherRevenue({ silent: true });
          }

          setTimeout(() => {
            void this.loadNonCriticalData();
          }, this.isMobile ? 900 : 250);

          void this.loadVisibleMikrotikData();
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
              if (this.activeMenu === "monitor-ap") {
                requests.push(this.loadContacts({ silent: true }), this.loadApMonitors({ silent: true }));
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
          } else if (key === "hotspot-accounts") {
            this.activeContactTab = "hotspot";
            key = "contacts";
          }
          this.activeMenu = key;
          this.mobileSidebarOpen = false;
          void this.loadVisibleMikrotikData();
          if (key === "vouchers") {
            void this.loadVisibleVoucherData();
          }
          if (key === "revenue" && this.activeRevenueTab === "vouchers") {
            void this.loadVoucherRevenue({ silent: true });
          }
          window.scrollTo({ top: 0, behavior: "smooth" });
        },

        selectContactTab(key) {
          if (!["data", "billing", "hotspot"].includes(key)) return;
          this.activeContactTab = key;
          if (key === "hotspot") void this.loadVisibleMikrotikData();
        },

        selectSettingsTab(key) {
          if (!["general", "rates", "isolation", "backup", "messages", "automation"].includes(key)) return;
          this.activeSettingsTab = key;
          if (key === "rates") void this.loadVisibleMikrotikData();
        },

        selectRevenueTab(key) {
          if (!["customers", "vouchers"].includes(key)) return;
          this.activeRevenueTab = key;
          if (key === "vouchers") void this.loadVoucherRevenue({ silent: true });
        },

        selectAdjacentSettingsTab(direction) {
          const tabs = ["general", "rates", "isolation", "backup", "messages", "automation"];
          const currentIndex = tabs.indexOf(this.activeSettingsTab);
          const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
          this.activeSettingsTab = tabs[nextIndex];
          if (tabs[nextIndex] === "rates") void this.loadVisibleMikrotikData();
          this.$nextTick(() => document.getElementById(`settings-${tabs[nextIndex]}-tab`)?.focus());
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
          return total ? Math.min(100, Math.round((this.summaryValue("Paket aktif") / total) * 100)) : 0;
        },

        async loadVisibleVoucherData() {
          if (this.activeMenu !== "vouchers") return;
          const options = { silent: true };
          if (this.activeVoucherTab === "stats") {
            await this.loadVoucherStats(options);
          } else if (this.activeVoucherTab === "profiles") {
            await this.loadVoucherOptions(options);
          } else {
            await this.loadVoucherOptions(options);
            if (this.activeMenu === "vouchers" && this.activeVoucherTab === "create") {
              await this.loadVoucherBatches(options);
            }
          }
        },

        async loadNonCriticalData() {
          await Promise.allSettled([
            this.loadSent(),
            this.loadRecipients(),
            this.loadLogs(),
          ]);
        },

        async loadVisibleMikrotikData(options = {}) {
          const { refresh = false } = options;
          const requests = [];
          const loadOptions = { silent: true, fresh: refresh };
          if (this.activeMenu === "monitor-ap" && (refresh || !this.apMonitors.length)) {
            requests.push(this.loadApMonitors(loadOptions));
          }
          if (this.activeMenu === "contacts" && this.activeContactTab === "hotspot") {
            if (refresh || !this.hotspotUsers.length) requests.push(this.loadHotspotUsers(loadOptions));
            if (refresh || !this.mikrotikProfiles.length) requests.push(this.loadMikrotikProfiles(loadOptions));
          }
          if (this.activeMenu === "settings" && this.activeSettingsTab === "rates"
            && (refresh || !this.mikrotikProfiles.length)) {
            requests.push(this.loadMikrotikProfiles(loadOptions));
          }
          await Promise.allSettled(requests);
        },

        async api(path, options = {}) {
          const {
            silent = false,
            timeoutMs = 0,
            timeoutMessage = "Permintaan terlalu lama diproses. Silakan coba lagi.",
            ...fetchOptions
          } = options;
          const requestTimeoutMs = Math.max(0, Number(timeoutMs) || 0);
          const timeoutController = requestTimeoutMs > 0 ? new AbortController() : null;
          let timeoutId = null;
          let timedOut = false;
          if (timeoutController) {
            timeoutId = setTimeout(() => {
              timedOut = true;
              timeoutController.abort();
            }, requestTimeoutMs);
          }

          let response;
          try {
            response = await fetch(path, {
              ...fetchOptions,
              signal: timeoutController?.signal || fetchOptions.signal,
              cache: "no-store",
              credentials: "same-origin",
              headers: {
                "Content-Type": "application/json",
                ...(fetchOptions.headers || {}),
              },
            });
          } catch (error) {
            if (!timedOut) throw error;
            if (!silent) this.notify(timeoutMessage);
            const timeoutError = new Error(timeoutMessage);
            timeoutError.name = "TimeoutError";
            throw timeoutError;
          } finally {
            if (timeoutId) clearTimeout(timeoutId);
          }

          if (response.status === 401) {
            window.location.href = "/login";
            throw new Error("Unauthorized");
          }

          const contentType = response.headers.get("content-type") || "";
          let payload;
          if (contentType.includes("application/json")) {
            try {
              payload = await response.json();
            } catch {
              payload = { success: false, error: `Respons server tidak valid (${response.status}).` };
            }
          } else {
            const responseText = await response.text();
            const isHtmlResponse = /<!doctype\s+html|<html[\s>]/i.test(responseText);
            const error = response.status === 524
              ? "Permintaan terlalu lama diproses. Proses di server mungkin masih berjalan; periksa riwayat sebelum mencoba lagi."
              : (isHtmlResponse
                ? `Server tidak dapat menyelesaikan permintaan (${response.status}). Silakan coba lagi.`
                : responseText || `Request failed (${response.status})`);
            payload = { success: false, error };
          }
          if (!response.ok || !payload.success) {
            const message = payload.error || `Request failed (${response.status})`;
            if (!silent) this.notify(message);
            const error = new Error(message);
            error.status = response.status;
            throw error;
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

        openDeleteConfirm({ title, description, confirmLabel = "Hapus", processingMessage = "Memproses tindakan...", action }) {
          const returnFocusElement = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
          this.deleteConfirm = {
            open: true,
            loading: false,
            title,
            description,
            confirmLabel,
            processingMessage,
            action,
            returnFocusElement,
          };
          this.clearFormError("deleteConfirm");
          document.body.classList.add("overflow-hidden");
          this.$nextTick(() => document.getElementById("delete-confirm-cancel")?.focus());
        },

        closeDeleteConfirm() {
          const returnFocusElement = this.deleteConfirm.returnFocusElement;
          this.deleteConfirm.open = false;
          this.deleteConfirm.loading = false;
          this.deleteConfirm.title = "";
          this.deleteConfirm.description = "";
          this.deleteConfirm.confirmLabel = "Hapus";
          this.deleteConfirm.processingMessage = "Memproses tindakan...";
          this.deleteConfirm.action = null;
          this.deleteConfirm.returnFocusElement = null;
          this.clearFormError("deleteConfirm");
          document.body.classList.remove("overflow-hidden");
          this.$nextTick(() => {
            if (returnFocusElement?.isConnected) returnFocusElement.focus();
          });
        },

        async confirmDeleteAction() {
          if (!this.deleteConfirm.action || this.deleteConfirm.loading) return;
          this.deleteConfirm.loading = true;
          this.clearFormError("deleteConfirm");
          try {
            await this.withProcessing(this.deleteConfirm.processingMessage, () => this.deleteConfirm.action());
            this.closeDeleteConfirm();
          } catch (error) {
            this.setFormError("deleteConfirm", error);
          } finally {
            this.deleteConfirm.loading = false;
          }
        },

  };
}
