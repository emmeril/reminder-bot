function createDashboardSelectors() {
  return {
        getAppTimezone() {
          return this.forms.settings.timezone || "Asia/Jakarta";
        },

        getZonedParts(value) {
          if (value === null || value === undefined || value === "") return null;
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

        getReminderDeliveryLabel(reminder) {
          const labels = {
            GRACE_PERIOD: "Pengingat masa tenggang",
            BILLING_DUE: "Jatuh tempo tagihan",
            RETRY: "Percobaan ulang",
          };
          return labels[String(reminder?.deliveryScheduleType || "").toUpperCase()] || "Waktu reminder";
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
            billingCycle: "PREPAID",
          };
        },

        blankHotspotAccountForm() {
          return {
            contactId: "",
            macAddresses: [],
            newMacAddress: "",
            username: "",
            profile: "",
            password: "",
            sendCredentials: true,
          };
        },

        blankHotspotScheduleForm() {
          return {
            contactId: "",
            mode: "NONE",
            date: "",
            time: "00:00",
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

        hasMikrotikAccess(contact) {
          return Boolean(contact?.mikrotikUsername);
        },

        getMikrotikAccessIdentifier(contact) {
          return contact?.mikrotikUsername || "Belum ada user";
        },

        getIpBindingCountLabel(contact) {
          const count = Array.isArray(contact?.mikrotikMacAddresses) ? contact.mikrotikMacAddresses.length : 0;
          return count > 0 ? `${count} perangkat` : "Belum ada";
        },

        getIpBindingTableStatus(contact) {
          const status = String(contact?.ipBindingBandwidthStatus || "").toUpperCase();
          const pendingCount = Array.isArray(contact?.ipBindingBandwidthPendingMacAddresses)
            ? contact.ipBindingBandwidthPendingMacAddresses.length
            : 0;
          if (status === "ACTIVE") return "Queue per IP aktif";
          if (status === "PARTIAL") return pendingCount > 0
            ? `${pendingCount} menunggu IP`
            : "Sebagian tersinkron";
          if (status === "PENDING_DHCP") return "Menunggu IP";
          if (status === "NO_RATE_LIMIT") return "Profile tanpa limit";
          if (status === "FAILED") return "Sinkronisasi gagal";
          return "Belum disinkronkan";
        },

        normalizeMacAddressInput(value) {
          const compact = String(value || "").replace(/[^a-fA-F0-9]/g, "").toUpperCase();
          if (!/^[A-F0-9]{12}$/.test(compact)) return "";
          const normalized = compact.match(/.{2}/g).join(":");
          if (normalized === "00:00:00:00:00:00" || (Number.parseInt(normalized.slice(0, 2), 16) & 1) === 1) return "";
          return normalized;
        },

        addHotspotMacAddress() {
          const normalized = this.normalizeMacAddressInput(this.forms.hotspotAccount.newMacAddress);
          if (!normalized) {
            this.formErrors.hotspotAccount = "Format MAC address tidak valid. Gunakan AA:BB:CC:DD:EE:FF.";
            return;
          }
          if (this.forms.hotspotAccount.macAddresses.includes(normalized)) {
            this.formErrors.hotspotAccount = `MAC ${normalized} sudah ada dalam daftar.`;
            return;
          }
          if (this.forms.hotspotAccount.macAddresses.length >= 10) {
            this.formErrors.hotspotAccount = "Maksimal 10 MAC address per pelanggan.";
            return;
          }
          this.forms.hotspotAccount.macAddresses.push(normalized);
          this.forms.hotspotAccount.newMacAddress = "";
          this.clearFormError("hotspotAccount");
        },

        removeHotspotMacAddress(macAddress) {
          this.forms.hotspotAccount.macAddresses = this.forms.hotspotAccount.macAddresses.filter(
            (item) => item !== macAddress
          );
        },

        getHotspotAccountSelectedContact() {
          return this.contacts.find((contact) => (
            String(contact.id) === String(this.forms.hotspotAccount.contactId)
          )) || null;
        },

        getIpBindingBandwidthDevice(macAddress) {
          const contact = this.getHotspotAccountSelectedContact();
          return (contact?.ipBindingBandwidthDevices || []).find((device) => (
            device.macAddress === macAddress
          )) || null;
        },

        getIpBindingDeviceStatus(macAddress) {
          const device = this.getIpBindingBandwidthDevice(macAddress);
          if (device?.address) return `${device.address} · ${device.source === "HOTSPOT" ? "Hotspot" : "DHCP"}`;
          const contact = this.getHotspotAccountSelectedContact();
          const bandwidthStatus = String(contact?.ipBindingBandwidthStatus || "").toUpperCase();
          if (bandwidthStatus === "NO_RATE_LIMIT") return "Menunggu rate limit pada profile";
          if (bandwidthStatus === "FAILED") return "Status bandwidth belum tersedia";
          if ((contact?.mikrotikMacAddresses || []).includes(macAddress)) {
            return "Menunggu IP dari DHCP atau Hotspot";
          }
          return "IP akan dicari setelah disimpan";
        },

        getIpBindingBandwidthSummary() {
          const form = this.forms.hotspotAccount;
          if (!form.macAddresses.length) return { status: "NONE", text: "" };
          const contact = this.getHotspotAccountSelectedContact();
          const savedMacs = [...(contact?.mikrotikMacAddresses || [])].sort().join(",");
          const formMacs = [...form.macAddresses].sort().join(",");
          if (!contact || savedMacs !== formMacs || String(contact.mikrotikProfile || "") !== String(form.profile || "")) {
            return { status: "PENDING_SAVE", text: "Simple Queue per IP akan disinkronkan setelah perubahan disimpan." };
          }
          const status = String(contact.ipBindingBandwidthStatus || "PENDING_DHCP").toUpperCase();
          const rateLimit = contact.ipBindingBandwidthRateLimit || "";
          const targetCount = (contact.ipBindingBandwidthTargetAddresses || []).length;
          const pendingCount = (contact.ipBindingBandwidthPendingMacAddresses || []).length;
          if (status === "ACTIVE") {
            return { status, text: `Rate limit ${rateLimit} aktif pada ${targetCount} Simple Queue perangkat.` };
          }
          if (status === "PARTIAL") {
            return { status, text: `Rate limit ${rateLimit} aktif pada ${targetCount} perangkat; ${pendingCount} perangkat masih menunggu IP.` };
          }
          if (status === "NO_RATE_LIMIT") {
            return { status, text: `Profile ${form.profile || "ini"} belum memiliki rate limit.` };
          }
          if (status === "FAILED") {
            return { status, text: contact.ipBindingBandwidthError || "Sinkronisasi bandwidth perlu dicoba ulang." };
          }
          return { status: "PENDING_DHCP", text: "Menunggu perangkat memperoleh IP dari DHCP atau Hotspot." };
        },

        isRecurringSubscription(contact) {
          return String(contact?.subscriptionType || "RECURRING").toUpperCase().replace(/-/g, "_") === "RECURRING";
        },

        suggestHotspotUsername(name) {
          return String(name || "")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, "_")
            .replace(/[^a-z0-9_]/g, "");
        },

        buildHotspotReactivationAt(form) {
          const date = form.hotspotReactivationDate || form.reactivationDate || form.date;
          const time = form.hotspotReactivationTime || form.reactivationTime || form.time;
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
          return this.hasMikrotikAccess(contact) ? "ACTIVE" : "NONE";
        },

        getHotspotProvisioningLabel(contact) {
          const status = this.getHotspotProvisioningStatus(contact);
          if (contact?.hotspotSuspendedForArrears && status === "DISABLED") return "Nonaktif karena tunggakan";
          if (contact?.hotspotManualActivationWithArrears && status === "ACTIVE") return "Aktif manual";
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
          }[status] || "Status tidak dikenal";
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

        getContactHotspotAccessMode(contact) {
          const mode = String(contact?.hotspotAccessMode || "").trim().toUpperCase();
          if (["HOTSPOT_ONLY", "IP_BINDING_ONLY", "BOTH"].includes(mode)) return mode;
          return Array.isArray(contact?.mikrotikMacAddresses) && contact.mikrotikMacAddresses.length > 0
            ? "BOTH"
            : "HOTSPOT_ONLY";
        },

        getEffectiveHotspotAccessMode(contact) {
          return ["DISABLED", "DEACTIVATED"].includes(this.getHotspotProvisioningStatus(contact))
            ? "DISABLED"
            : this.getContactHotspotAccessMode(contact);
        },

        getHotspotUserAccessLabel(contact) {
          if (!contact?.mikrotikUsername) return "Nonaktif";
          if (this.getHotspotProvisioningStatus(contact) !== "ACTIVE") return "Nonaktif";
          return ["HOTSPOT_ONLY", "BOTH"].includes(this.getEffectiveHotspotAccessMode(contact))
            ? "Aktif"
            : "Nonaktif";
        },

        getHotspotUserAccessClass(contact) {
          return this.getHotspotUserAccessLabel(contact) === "Aktif"
            ? "bg-moss/10 text-moss"
            : "bg-red-100 text-red-700";
        },

        getIpBindingAccessLabel(contact) {
          const hasBindings = Array.isArray(contact?.mikrotikMacAddresses) && contact.mikrotikMacAddresses.length > 0;
          if (!hasBindings || this.getHotspotProvisioningStatus(contact) !== "ACTIVE") return "Nonaktif";
          return ["IP_BINDING_ONLY", "BOTH"].includes(this.getEffectiveHotspotAccessMode(contact))
            ? "Aktif"
            : "Nonaktif";
        },

        getIpBindingAccessClass(contact) {
          return this.getIpBindingAccessLabel(contact) === "Aktif"
            ? "bg-moss/10 text-moss"
            : "bg-red-100 text-red-700";
        },

        canConfigureHotspotAccessMode(contact) {
          return Boolean(contact?.id && contact?.mikrotikUsername && contact?.mikrotikProfile);
        },

        canRetryHotspotProvisioning(contact) {
          return ["PENDING", "FAILED", "MISSING", "CHANGED"].includes(
            this.getHotspotProvisioningStatus(contact)
          );
        },

        canReactivateHotspot(contact) {
          if (this.isPrepaidPackage(contact)) return false;
          return this.getHotspotProvisioningStatus(contact) === "DEACTIVATED";
        },

        canDisableHotspot(contact) {
          return this.getHotspotProvisioningStatus(contact) === "ACTIVE";
        },

        canEnableHotspot(contact) {
          if (contact?.hasDebt) return false;
          const status = this.getHotspotProvisioningStatus(contact);
          if (this.isPrepaidPackage(contact)) {
            return Boolean(contact?.packageActive) && status === "DISABLED";
          }
          return status === "DISABLED"
            || (status === "CHANGED" && /akun dinonaktifkan/i.test(String(contact?.hotspotProvisioningError || "")));
        },

        canSendHotspotAccount(contact) {
          const status = this.getHotspotProvisioningStatus(contact);
          if (["NONE", "MISSING", "DEACTIVATED", "DISABLED"].includes(status)) return false;
          if (this.getContactHotspotAccessMode(contact) === "IP_BINDING_ONLY") return false;
          return !(status === "CHANGED" && /akun dinonaktifkan/i.test(String(contact?.hotspotProvisioningError || "")));
        },

        getReactivationLabel(contact) {
          if (this.isPrepaidPackage(contact)) {
            return contact?.packageActive ? "Paket aktif" : "Paket tidak aktif";
          }
          if (contact.hotspotManualActivationWithArrears) return "Aktif manual satu bulan";
          if (contact.billingPausedForArrears && !contact.hotspotReactivationAt) return "Perpanjangan dijeda";
          if (!contact.hotspotReactivationAt) return contact.hotspotReactivationEnabled ? "Belum dijadwalkan" : "Tanpa jadwal";
          if (!contact.hotspotReactivationEnabled) return "Penonaktifan terjadwal";
          return "Aktif otomatis";
        },

        getReactivationDetail(contact) {
          if (this.isPrepaidPackage(contact)) {
            return contact?.hotspotReactivationAt
              ? `Berakhir ${this.formatDateTime(contact.hotspotReactivationAt)}`
              : "Beli paket untuk mengaktifkan layanan";
          }
          if (!contact.hotspotReactivationAt) {
            return contact.hotspotReactivationEnabled ? "Tanggal belum dipilih" : "Tidak ada perubahan otomatis";
          }
          return this.formatDateTime(contact.hotspotReactivationAt);
        },

        getReactivationClass(contact) {
          if (this.isPrepaidPackage(contact)) {
            return contact?.packageActive ? "bg-moss/10 text-moss" : "bg-slate-200/70 text-slate-700";
          }
          if (contact.hotspotReactivationEnabled) return "bg-moss/10 text-moss";
          if (contact.hotspotReactivationAt) return "bg-amber-100 text-amber-800";
          return "bg-slate-200/70 text-slate-700";
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
            "CURRENT-ONLY": "Periode Tagihan",
            "FULL-PAID": "Lunas Semua",
            "ACTIVE-PERIOD": "Masa Aktif 1 Bulan"
          };
          return labels[type] || type || "-";
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
          if (!contact) return [];
          if (this.isPrepaidPackage(contact)) return [];
          if (Array.isArray(contact.debtPeriods)) return contact.debtPeriods;

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
          if (!contact) return false;
          if (contact.hasDebt !== undefined) return Boolean(contact.hasDebt);
          return this.getDebtPeriods(contact).length > 0;
        },

        canSendBillingReminder(contact) {
          if (this.isPrepaidPackage(contact)) return false;
          const status = String(contact?.currentPaymentStatus || contact?.paymentStatus || "UNPAID").toUpperCase();
          const dueStatus = String(contact?.dueStatus || "NOT_SCHEDULED").toUpperCase();
          const debtCount = Math.max(0, Number(contact?.debtCount ?? this.getDebtPeriods(contact).length) || 0);
          if (debtCount >= 2) return false;
          return this.hasDebt(contact) || (status === "UNPAID" && dueStatus === "OVERDUE");
        },

        canPayCurrentBilling(contact) {
          if (this.isPrepaidPackage(contact)) return false;
          const status = String(contact?.currentPaymentStatus || contact?.paymentStatus || "UNPAID").toUpperCase();
          return contact?.subscriptionActive !== false && status !== "PAID";
        },

        getCurrentBillingPeriodLabel(contact = null) {
          if (contact?.billingPeriodLabel) return contact.billingPeriodLabel;
          const [periodYear, periodMonth] = String(this.billingPeriod || "").split("-").map(Number);
          const nowParts = this.getZonedParts(new Date());
          const year = periodYear || Number(nowParts?.year);
          const month = periodMonth || Number(nowParts?.month);
          return this.getBillingPeriodLabel(year, month);
        },

        getCurrentBillingActionLabel(contact) {
          if (this.isPrepaidPackage(contact)) {
            const amount = Math.max(0, Number(contact?.monthlyPaymentAmount) || 0);
            return amount > 0
              ? `Beli paket 1 bulan · ${this.formatRupiah(amount)}`
              : "Beli paket 1 bulan";
          }
          const period = this.getCurrentBillingPeriodLabel(contact);
          if (contact?.subscriptionActive === false) return `Tidak ada tagihan ${period}`;
          if (!this.canPayCurrentBilling(contact)) return `${period} sudah lunas`;
          const amount = Math.max(0, Number(contact?.monthlyPaymentAmount) || 0);
          return amount > 0
            ? `Bayar ${period} · ${this.formatRupiah(amount)}`
            : `Bayar ${period}`;
        },

        getBillingCycleLabel() {
          return "Bulanan prabayar";
        },

        getBillingCycleValue() {
          return "PREPAID";
        },

        getBillingCycleBadgeClass() {
          return "border-moss/15 bg-moss/10 text-moss";
        },

        isPrepaidPackage(contact) {
          return String(contact?.subscriptionType || "RECURRING").toUpperCase().replace(/-/g, "_") === "RECURRING";
        },

        getCurrentPaymentLabel(contact) {
          if (this.isPrepaidPackage(contact)) {
            return contact?.packageActive ? "Paket aktif" : "Paket tidak aktif";
          }
          if (contact?.subscriptionActive === false) return "Tidak ada tagihan baru";
          if (contact?.currentPaymentStatus !== "PAID") return "Belum Bayar";
          if (contact?.currentPaymentType) return this.getPaymentTypeLabel(contact.currentPaymentType);
          return "Lunas";
        },

        getPaymentAmountSourceLabel(contact) {
          if (!this.hasProfileMonthlyAmount(contact)) return "Tarif manual";
          if (!contact?.monthlyPaymentAmountCustomized) return "Mengikuti tarif profile";
          const amount = Number(this.getProfileMonthlyAmount(contact.mikrotikProfile)).toLocaleString("id-ID");
          return `Nominal custom · default profile Rp ${amount}`;
        },

        getDebtNote(contact) {
          const periods = this.getDebtPeriods(contact);
          return contact.debtNote || `Masih ada hutang ${periods.map((period) => period.label).join(", ") || contact.debtPeriodLabel || this.getPreviousBillingPeriodLabel()}.`;
        },

        getDebtAmount(contact) {
          if (contact?.debtAmount !== undefined) {
            return Math.max(0, Number(contact.debtAmount) || 0);
          }
          return this.getDebtPeriods(contact).reduce((total, period) => (
            total + Math.max(0, Number(period.remainingAmount ?? contact?.monthlyPaymentAmount) || 0)
          ), 0);
        },

        getOldestDebtPeriod(contact) {
          return this.getDebtPeriods(contact)[0] || null;
        },

        getArrearsPaymentLabel(contact) {
          const periods = this.getDebtPeriods(contact);
          const oldest = periods[0];
          if (!oldest?.label) return "Bayar tunggakan lama";
          return periods.length > 1
            ? `Bayar tunggakan mulai ${oldest.label}`
            : `Bayar tunggakan ${oldest.label}`;
        },

        getArrearsPaymentHelp(contact) {
          const periods = this.getDebtPeriods(contact);
          const oldest = periods[0];
          const amount = this.formatRupiah(this.getDebtAmount(contact));
          if (!oldest?.label) return `Sisa tunggakan ${amount}. Pembayaran masuk ke periode paling lama.`;
          if (periods.length > 1) {
            return `Total sisa ${periods.length} bulan ${amount}. Pembayaran dimulai dari ${oldest.label}.`;
          }
          return `Sisa ${oldest.label} ${amount}.`;
        },

        getArrearsPaymentSubmitLabel(contact) {
          const oldest = this.getOldestDebtPeriod(contact);
          return oldest?.label ? `Catat ke ${oldest.label}` : "Catat pembayaran tunggakan";
        },

        getTotalOutstandingAmount(contact) {
          const currentAmount = this.canPayCurrentBilling(contact)
            ? Math.max(0, Number(contact?.monthlyPaymentAmount) || 0)
            : 0;
          return this.getDebtAmount(contact) + currentAmount;
        },

        getFullPaymentActionLabel(contact) {
          return `Lunasi semua · ${this.formatRupiah(this.getTotalOutstandingAmount(contact))}`;
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

        getRevenuePeriodLabel(period = "") {
          const [year, month] = String(period || "").split("-").map(Number);
          if (!year || month < 1 || month > 12) return "Periode belum dipilih";
          return this.getBillingPeriodLabel(year, month);
        },

        isValidRevenueDate(value) {
          const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
          if (!match) return false;
          const year = Number(match[1]);
          const month = Number(match[2]);
          const day = Number(match[3]);
          const date = new Date(Date.UTC(year, month - 1, day));
          return date.getUTCFullYear() === year
            && date.getUTCMonth() === month - 1
            && date.getUTCDate() === day;
        },

        validateRevenueDateRange(options = {}) {
          const dateFrom = String(this.revenueDateFrom || "");
          const dateTo = String(this.revenueDateTo || "");
          let error = "";
          if (!this.isValidRevenueDate(dateFrom) || !this.isValidRevenueDate(dateTo)) {
            error = "Pilih tanggal mulai dan tanggal akhir laporan.";
          } else if (dateFrom > dateTo) {
            error = "Tanggal mulai tidak boleh melewati tanggal akhir.";
          }
          if (options.updateError) this.revenueRangeError = error;
          return !error;
        },

        getRevenueDateKey(value) {
          const parts = this.getZonedParts(value);
          return parts ? `${parts.year}-${parts.month}-${parts.day}` : "";
        },

        isDateWithinRevenueRange(value) {
          if (!this.validateRevenueDateRange()) return false;
          const dateKey = this.getRevenueDateKey(value);
          return Boolean(dateKey && dateKey >= this.revenueDateFrom && dateKey <= this.revenueDateTo);
        },

        getRevenueRangeFileSuffix() {
          return this.validateRevenueDateRange()
            ? `${this.revenueDateFrom}-sampai-${this.revenueDateTo}`
            : "rentang-tanggal";
        },

        handleRevenueDateRangeChange() {
          if (!this.validateRevenueDateRange({ updateError: true })) return;
          this.resetPage("revenue");
          this.resetPage("voucherRevenue");
          if (this.activeRevenueTab === "vouchers") void this.loadVoucherRevenue({ silent: true });
        },

        async loadVoucherRevenue(options = {}) {
          if (!this.validateRevenueDateRange({ updateError: true })) return;
          const dateFrom = this.revenueDateFrom;
          const dateTo = this.revenueDateTo;
          const requestId = ++this.voucherRevenueRequestId;
          this.loading.voucherRevenue = true;
          this.voucherRevenueError = "";
          if (this.voucherRevenue.dateFrom !== dateFrom || this.voucherRevenue.dateTo !== dateTo) {
            this.voucherRevenue = {
              dateFrom,
              dateTo,
              summary: { revenue: 0, costPrice: 0, commission: 0, quantity: 0, profiles: 0 },
              profileSummary: [],
              entries: [],
            };
          }
          try {
            const report = await this.api(`/api/mikrotik/voucher-revenue?from=${dateFrom}&to=${dateTo}`, {
              silent: Boolean(options.silent),
              timeoutMs: 45_000,
              timeoutMessage: "MikroTik belum merespons laporan voucher. Periksa koneksi lalu tekan Muat ulang.",
            });
            if (requestId !== this.voucherRevenueRequestId) return;
            const revenue = Number(report?.summary?.revenue || 0);
            const costPrice = Number(report?.summary?.costPrice || 0);
            const commission = Number(report?.summary?.commission || 0);
            this.voucherRevenue = {
              dateFrom: report?.dateFrom || dateFrom,
              dateTo: report?.dateTo || dateTo,
              summary: {
                revenue,
                costPrice,
                commission,
                quantity: Number(report?.summary?.quantity || 0),
                profiles: Number(report?.summary?.profiles || 0),
              },
              profileSummary: Array.isArray(report?.profileSummary) ? report.profileSummary : [],
              entries: Array.isArray(report?.entries) ? report.entries : [],
            };
            if (!options.silent) this.notify("Laporan pendapatan voucher diperbarui dari MikroTik.");
          } catch (error) {
            if (requestId !== this.voucherRevenueRequestId) return;
            this.voucherRevenueError = error.message || "Laporan pendapatan voucher gagal dimuat.";
          } finally {
            if (requestId === this.voucherRevenueRequestId) this.loading.voucherRevenue = false;
          }
        },

        get voucherRevenueProfiles() {
          return Array.from(new Set(this.voucherRevenue.entries.map((entry) => entry.profile).filter(Boolean)))
            .sort((a, b) => a.localeCompare(b, "id-ID"));
        },

        get filteredVoucherRevenueEntries() {
          const selectedProfile = this.filters.voucherRevenue.profile || "ALL";
          const entries = this.voucherRevenue.entries.filter((entry) => {
            if (selectedProfile !== "ALL" && entry.profile !== selectedProfile) return false;
            return this.searchMatches(
              entry,
              ["username", "profile", "amount", "costPrice", "commission", "validity"],
              this.filters.voucherRevenue.search
            );
          });
          return this.sortTableItems(entries, "voucherRevenue", {
            username: (entry) => entry.username,
            profile: (entry) => entry.profile,
            amount: (entry) => Number(entry.amount || 0),
            costPrice: (entry) => Number(entry.costPrice || 0),
            commission: (entry) => Number(entry.commission || 0),
            validity: (entry) => entry.validity,
            usedAt: (entry) => this.getSortTimestamp(entry.usedAt),
          });
        },

        get paginatedVoucherRevenueEntries() {
          return this.paginate(this.filteredVoucherRevenueEntries, "voucherRevenue");
        },

        get revenueEntries() {
          if (!this.validateRevenueDateRange()) return [];

          return this.contacts
            .flatMap((contact) => {
              const entries = [];
              for (const [period, payment] of Object.entries(contact.paymentMonths || {})) {
                if (!payment || payment.billingPaused) continue;
                const paymentDate = payment.lastPaymentDate || payment.paidDate || null;
                if (!this.isDateWithinRevenueRange(paymentDate)) continue;
                const monthlyAmount = Math.max(0, Math.floor(Number(contact.monthlyPaymentAmount) || 0));
                const status = String(payment.status || "UNPAID").toUpperCase();
                const recordedAmount = Math.max(0, Math.floor(Number(payment.paidAmount) || 0));
                const amount = status === "PAID"
                  ? recordedAmount || monthlyAmount
                  : recordedAmount;
                if (amount > 0) {
                  entries.push({
                    id: `billing-${contact.id}-${period}`,
                    contactId: contact.id,
                    name: contact.name || "-",
                    phoneNumber: contact.phoneNumber || "-",
                    period,
                    status: status === "PAID" ? "PAID" : "PARTIAL",
                    paymentType: payment.paymentType || null,
                    amount,
                    paymentDate,
                    activeUntil: null,
                  });
                }
              }

              for (const purchase of contact.activePeriodPurchases || []) {
                if (!this.isDateWithinRevenueRange(purchase.purchasedAt)) continue;
                const parts = this.getZonedParts(purchase.purchasedAt);
                if (!parts) continue;
                const purchasePeriod = `${parts.year}-${parts.month}`;
                const amount = Math.max(0, Math.floor(Number(purchase.amount) || 0));
                if (amount <= 0) continue;
                entries.push({
                  id: `active-period-${contact.id}-${purchase.id}`,
                  contactId: contact.id,
                  name: contact.name || "-",
                  phoneNumber: contact.phoneNumber || "-",
                  period: purchasePeriod,
                  status: "PAID",
                  paymentType: "ACTIVE-PERIOD",
                  amount,
                  paymentDate: purchase.purchasedAt || null,
                  activeUntil: purchase.activeUntil || null,
                });
              }
              return entries;
            })
            .sort((a, b) => {
              const dateDifference = new Date(b.paymentDate || 0).getTime() - new Date(a.paymentDate || 0).getTime();
              return dateDifference || a.name.localeCompare(b.name, "id-ID");
            });
        },

        get filteredRevenueEntries() {
          const selectedStatus = String(this.filters.revenue.status || "ALL").toUpperCase();
          const entries = this.revenueEntries.filter((entry) => {
            if (selectedStatus !== "ALL" && entry.status !== selectedStatus) return false;
            return this.searchMatches(
              entry,
              ["name", "phoneNumber", "paymentType", "status", "amount"],
              this.filters.revenue.search
            );
          });
          return this.sortTableItems(entries, "revenue", {
            name: (entry) => entry.name,
            period: (entry) => entry.period,
            status: (entry) => entry.status === "PAID" ? "Lunas" : "Sebagian",
            paymentType: (entry) => this.getPaymentTypeLabel(entry.paymentType),
            amount: (entry) => Number(entry.amount || 0),
            paymentDate: (entry) => this.getSortTimestamp(entry.paymentDate),
          });
        },

        get paginatedRevenueEntries() {
          return this.paginate(this.filteredRevenueEntries, "revenue");
        },

        get revenueTotal() {
          return this.revenueEntries.reduce((total, entry) => total + entry.amount, 0);
        },

        get revenuePaidCount() {
          return this.revenueEntries.filter((entry) => entry.status === "PAID").length;
        },

        get revenuePartialTotal() {
          return this.revenueEntries
            .filter((entry) => entry.status === "PARTIAL")
            .reduce((total, entry) => total + entry.amount, 0);
        },

        get revenueAverage() {
          return this.revenueEntries.length ? Math.round(this.revenueTotal / this.revenueEntries.length) : 0;
        },

        exportRevenueReport() {
          const rows = [
            ["Periode", "Pelanggan", "Nomor WhatsApp", "Status", "Jenis Pembayaran", "Pendapatan Tercatat", "Tanggal Pembayaran", "Aktif Sampai"],
            ...this.filteredRevenueEntries.map((entry) => [
              this.getRevenuePeriodLabel(entry.period),
              entry.name,
              entry.phoneNumber,
              entry.status === "PAID" ? "Lunas" : "Sebagian",
              this.getPaymentTypeLabel(entry.paymentType),
              entry.amount,
              entry.paymentDate ? this.formatDateTime(entry.paymentDate) : "Belum tercatat",
              entry.activeUntil ? this.formatDateTime(entry.activeUntil) : "-",
            ]),
          ];
          const csvCell = (value) => {
            let text = String(value ?? "");
            if (/^[=+\-@]/.test(text)) text = `'${text}`;
            return `"${text.replace(/"/g, '""')}"`;
          };
          const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\n")}`;
          const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
          const link = document.createElement("a");
          link.href = url;
          link.download = `laporan-pendapatan-${this.getRevenueRangeFileSuffix()}.csv`;
          document.body.appendChild(link);
          link.click();
          link.remove();
          URL.revokeObjectURL(url);
          this.notify("Laporan pendapatan sedang diunduh dalam format CSV.");
        },

        exportVoucherRevenueReport() {
          const rows = [
            ["Periode", "Username Voucher", "Profile", "Harga Jual", "HPP", "Keuntungan", "Tanggal Digunakan", "Masa Berlaku", "Alamat IP", "MAC Address"],
            ...this.filteredVoucherRevenueEntries.map((entry) => [
              this.getRevenuePeriodLabel(entry.period),
              entry.username,
              entry.profile,
              entry.amount,
              entry.costPrice,
              entry.commission,
              entry.usedAt ? this.formatDateTime(entry.usedAt) : "-",
              entry.validity || "-",
              entry.address || "-",
              entry.macAddress || "-",
            ]),
          ];
          const csvCell = (value) => {
            let text = String(value ?? "");
            if (/^[=+\-@]/.test(text)) text = `'${text}`;
            return `"${text.replace(/"/g, '""')}"`;
          };
          const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\n")}`;
          const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
          const link = document.createElement("a");
          link.href = url;
          link.download = `laporan-pendapatan-voucher-${this.getRevenueRangeFileSuffix()}.csv`;
          document.body.appendChild(link);
          link.click();
          link.remove();
          URL.revokeObjectURL(url);
          this.notify("Laporan pendapatan voucher sedang diunduh dalam format CSV.");
        },

        getDueStatusLabel(status) {
          const labels = {
            NOT_SCHEDULED: "Perlu Dijadwalkan",
            UPCOMING: "Belum Jatuh Tempo",
            OVERDUE: "Jatuh Tempo",
            PAID: "Lunas",
          };
          return labels[String(status || "").toUpperCase()] || "Perlu Dijadwalkan";
        },

        getDueDateLabel(contact) {
          if (contact?.dueDate) return this.formatDateTime(contact.dueDate);
          return "Jadwal belum tersedia";
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
          if (["DOWN", "OFFLINE", "FAIL", "MISSING"].includes(normalized)) return "bg-clay/10 text-clay";
          return "bg-slate-200/70 text-slate-700";
        },

        getApLinkStatusLabel(status) {
          const labels = {
            LINKED: "Terhubung",
            UNLINKED: "Tanpa pelanggan",
            MISSING: "AP tidak ditemukan",
          };
          return labels[String(status || "").toUpperCase()] || "Belum diketahui";
        },

        getApLinkStatusClass(status) {
          const normalized = String(status || "").toUpperCase();
          if (normalized === "LINKED") return "bg-moss/10 text-[#0b5f50]";
          if (normalized === "MISSING") return "bg-clay/10 text-[#9a3412]";
          return "bg-slate-200/70 text-[#475467]";
        },

        getApCustomerSummary(ap) {
          const names = (ap?.linkedContacts || []).map((contact) => contact.name).filter(Boolean);
          if (!names.length) return "Belum ada pelanggan";
          if (names.length <= 2) return names.join(", ");
          return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
        },

        showApCustomers(ap) {
          if (!ap?.host || !Number(ap.customerCount || 0)) return;
          this.filters.contacts.search = ap.host;
          this.filters.contacts.page = 1;
          this.activeContactTab = "data";
          this.selectMenu("contacts");
        },

        get selectableApMonitors() {
          return this.apMonitors.filter((ap) => ap.availableInNetwatch !== false);
        },

        get networkMonitorSummary() {
          const monitoredAccessPoints = this.apMonitors.filter((ap) => ap.availableInNetwatch !== false);
          return {
            netwatch: monitoredAccessPoints.length,
            up: monitoredAccessPoints.filter((ap) => String(ap.status || "").toUpperCase() === "UP").length,
            down: monitoredAccessPoints.filter((ap) => String(ap.status || "").toUpperCase() === "DOWN").length,
            unlinkedMonitors: monitoredAccessPoints.filter((ap) => (
              String(ap.linkStatus || "").toUpperCase() === "UNLINKED"
            )).length,
            linkedCustomers: this.contacts.filter((contact) => this.normalizeHost(contact.linkedApHost)).length,
            unlinkedCustomers: this.contacts.filter((contact) => !this.normalizeHost(contact.linkedApHost)).length,
            missingReferences: this.apMonitors.filter((ap) => String(ap.linkStatus || "").toUpperCase() === "MISSING").length,
          };
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

        searchValuesMatch(values, search) {
          const needle = String(search || "").trim().toLocaleLowerCase("id-ID");
          if (!needle) return true;
          return values
            .flat(Infinity)
            .map((value) => String(value ?? "").toLocaleLowerCase("id-ID"))
            .some((value) => value.includes(needle));
        },


        getMobileSortOptions(tableKey) {
          const fields = this.mobileSortFields[tableKey] || [];
          return [
            { value: "", label: "Urutan awal" },
            ...fields.flatMap(([key, label]) => [
              { value: `${key}:asc`, label: `${label} (menaik)` },
              { value: `${key}:desc`, label: `${label} (menurun)` },
            ]),
          ];
        },

        getMobileSortValue(tableKey) {
          const { key, direction } = this.sorts[tableKey] || {};
          return key && direction ? `${key}:${direction}` : "";
        },

        changeMobileSort(tableKey, value) {
          if (!this.sorts[tableKey]) return;
          const selected = this.getMobileSortOptions(tableKey).find((option) => option.value === value);
          if (!selected) return;
          const [key = "", direction = ""] = String(value).split(":");
          this.sorts[tableKey] = { key, direction };
          if (this.filters[tableKey]) this.resetPage(tableKey);
        },

        toggleSort(tableKey, columnKey) {
          const current = this.sorts[tableKey] || { key: "", direction: "" };
          if (current.key !== columnKey) {
            this.sorts[tableKey] = { key: columnKey, direction: "asc" };
          } else if (current.direction === "asc") {
            this.sorts[tableKey] = { key: columnKey, direction: "desc" };
          } else {
            this.sorts[tableKey] = { key: "", direction: "" };
          }
          if (this.filters[tableKey]) this.resetPage(tableKey);
        },

        getSortDirection(tableKey, columnKey) {
          const sort = this.sorts[tableKey];
          return sort?.key === columnKey ? sort.direction : "";
        },

        getSortAria(tableKey, columnKey) {
          const direction = this.getSortDirection(tableKey, columnKey);
          if (direction === "asc") return "ascending";
          if (direction === "desc") return "descending";
          return "none";
        },

        getSortIcon(tableKey, columnKey) {
          const direction = this.getSortDirection(tableKey, columnKey);
          if (direction === "asc") return "fa-solid fa-sort-up";
          if (direction === "desc") return "fa-solid fa-sort-down";
          return "fa-solid fa-sort";
        },

        getSortLabel(tableKey, columnKey, label) {
          const direction = this.getSortDirection(tableKey, columnKey);
          if (direction === "asc") return `Urutkan ${label} menurun`;
          if (direction === "desc") return `Kembalikan urutan awal ${label}`;
          return `Urutkan ${label} menaik`;
        },

        sortTableItems(items, tableKey, valueGetters) {
          const list = Array.isArray(items) ? items : [];
          const sort = this.sorts[tableKey];
          const getValue = sort?.key ? valueGetters[sort.key] : null;
          if (!getValue || !sort.direction) return list;

          return list
            .map((item, index) => ({ item, index, value: getValue(item) }))
            .sort((left, right) => {
              const leftEmpty = left.value === null || left.value === undefined || left.value === "";
              const rightEmpty = right.value === null || right.value === undefined || right.value === "";
              if (leftEmpty || rightEmpty) {
                if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1;
                return left.index - right.index;
              }

              let comparison;
              if (typeof left.value === "number" && typeof right.value === "number") {
                comparison = left.value - right.value;
              } else {
                comparison = String(left.value).localeCompare(String(right.value), "id-ID", {
                  numeric: true,
                  sensitivity: "base",
                });
              }
              if (!comparison) return left.index - right.index;
              return sort.direction === "desc" ? -comparison : comparison;
            })
            .map(({ item }) => item);
        },

        getSortTimestamp(value) {
          if (!value) return null;
          const timestamp = new Date(value).getTime();
          return Number.isFinite(timestamp) ? timestamp : null;
        },

        get sortedVoucherProfiles() {
          return this.sortTableItems(this.voucherProfiles, "voucherProfiles", {
            name: (profile) => profile.name,
            validity: (profile) => profile.validity,
            expiredMode: (profile) => this.voucherExpiryModes.find((mode) => mode.value === profile.expiredMode)?.label || "Belum diatur",
            status: (profile) => profile.voucherReady
              ? "Siap voucher"
              : (profile.status === "SCHEDULER_MISSING" ? "Monitor tidak aktif" : "Masa berlaku belum diatur"),
          });
        },

        get sortedVoucherStatsProfiles() {
          return this.sortTableItems(this.voucherStats.profiles, "voucherStats", {
            profile: (row) => row.profile,
            validity: (row) => row.validity,
            total: (row) => Number(row.total || 0),
            used: (row) => Number(row.used || 0),
            unused: (row) => Number(row.unused || 0),
          });
        },

        get contactBillingCycleOptions() {
          const values = new Map();
          for (const contact of this.contacts) {
            values.set(this.getBillingCycleValue(contact), this.getBillingCycleLabel(contact));
          }
          return Array.from(values, ([value, label]) => ({ value, label }));
        },

        get contactApStatusOptions() {
          const values = new Map();
          for (const contact of this.contacts) {
            values.set(this.getContactApStatus(contact), this.getContactApStatusLabel(contact));
          }
          return Array.from(values, ([value, label]) => ({ value, label }));
        },

        get billingStatusFilterOptions() {
          const values = new Map();
          let hasDebt = false;
          let hasNoDebt = false;
          for (const contact of this.contacts) {
            const label = this.getCurrentPaymentLabel(contact);
            values.set(`PAYMENT|${label}`, `Bulan ini · ${label}`);
            if (this.hasDebt(contact)) hasDebt = true;
            else hasNoDebt = true;
          }
          if (hasDebt) values.set("DEBT|YES", "Tunggakan · Ada tunggakan");
          if (hasNoDebt) values.set("DEBT|NO", "Tunggakan · Tidak ada tunggakan");
          return Array.from(values, ([value, label]) => ({ value, label }));
        },

        get billingDueStatusOptions() {
          const values = new Map();
          for (const contact of this.contacts) {
            const value = String(contact.dueStatus || "NOT_SCHEDULED").toUpperCase();
            values.set(value, this.getDueStatusLabel(value));
          }
          return Array.from(values, ([value, label]) => ({ value, label }));
        },

        get hotspotTableStatusOptions() {
          const values = new Map();
          const add = (scope, label, column) => values.set(`${scope}|${label}`, `${column} · ${label}`);
          for (const contact of this.contacts) {
            add("HOTSPOT", this.getHotspotUserAccessLabel(contact), "Akun Hotspot");
            add("IP_BINDING", this.getIpBindingAccessLabel(contact), "Akun IP Binding");
            add("SCHEDULE", this.getReactivationLabel(contact), "Status Jadwal");
            add("AP", this.getContactApStatusLabel(contact), "Status AP");
          }
          return Array.from(values, ([value, label]) => ({ value, label }));
        },

        get reminderBillingCycleOptions() {
          const values = new Map();
          for (const reminder of this.reminders) {
            values.set(this.getBillingCycleValue(reminder), this.getBillingCycleLabel(reminder));
          }
          return Array.from(values, ([value, label]) => ({ value, label }));
        },

        get reminderDeliveryTypeOptions() {
          const values = new Map();
          for (const reminder of this.reminders) {
            const value = String(reminder.deliveryScheduleType || "DEFAULT").toUpperCase();
            values.set(value, this.getReminderDeliveryLabel(reminder));
          }
          return Array.from(values, ([value, label]) => ({ value, label }));
        },

        get sentDeliveryStatuses() {
          return Array.from(new Set(this.sent.map((item) => (
            String(item.deliveryStatus || "SENT").toUpperCase()
          )))).sort((a, b) => a.localeCompare(b, "id-ID"));
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
          const contacts = this.contacts.filter((contact) => {
            const billingCycle = this.getBillingCycleValue(contact);
            const apStatus = this.getContactApStatus(contact);
            const selectedBillingCycle = String(this.filters.contacts.billingCycle || "ALL").toUpperCase();
            const selectedApStatus = String(this.filters.contacts.apStatus || "ALL").toUpperCase();
            if (selectedBillingCycle !== "ALL" && billingCycle !== selectedBillingCycle) return false;
            if (selectedApStatus !== "ALL" && apStatus !== selectedApStatus) return false;
            return this.searchValuesMatch([
              contact.name,
              contact.phoneNumber,
              this.getBillingCycleLabel(contact),
              contact.linkedApHost || "-",
              this.getContactApStatusLabel(contact),
            ], this.filters.contacts.search);
          });
          return this.sortTableItems(contacts, "contacts", {
            name: (contact) => contact.name,
            phone: (contact) => contact.phoneNumber,
            billingCycle: (contact) => this.getBillingCycleLabel(contact),
            linkedAp: (contact) => contact.linkedApHost,
            apStatus: (contact) => this.getContactApStatusLabel(contact),
          });
        },

        get filteredBillingContacts() {
          const contacts = this.contacts.filter((contact) => {
            const selectedStatus = String(this.filters.contactBilling.status || "ALL").toUpperCase();
            const selectedDueStatus = String(this.filters.contactBilling.dueStatus || "ALL").toUpperCase();
            const selectedBillingCycle = String(this.filters.contactBilling.billingCycle || "ALL").toUpperCase();
            const dueStatus = String(contact.dueStatus || "NOT_SCHEDULED").toUpperCase();

            if (selectedBillingCycle !== "ALL" && this.getBillingCycleValue(contact) !== selectedBillingCycle) return false;
            if (selectedStatus !== "ALL") {
              const [scope, ...labelParts] = String(this.filters.contactBilling.status).split("|");
              const expected = labelParts.join("|");
              if (scope === "PAYMENT" && this.getCurrentPaymentLabel(contact) !== expected) return false;
              if (scope === "DEBT" && (this.hasDebt(contact) ? "YES" : "NO") !== expected) return false;
            }
            if (selectedDueStatus !== "ALL" && dueStatus !== selectedDueStatus) return false;

            return this.searchValuesMatch([
              contact.name,
              contact.phoneNumber,
              this.getBillingCycleLabel(contact),
              this.getDueDateLabel(contact),
              contact.dueDate,
              this.getDueStatusLabel(dueStatus),
              contact.monthlyPaymentAmount,
              this.formatRupiah(contact.monthlyPaymentAmount),
              this.getPaymentAmountSourceLabel(contact),
              this.getCurrentPaymentLabel(contact),
              this.hasDebt(contact) ? this.getDebtCountLabel(contact) : "Tidak ada tunggakan",
              this.hasDebt(contact) ? this.getDebtNote(contact) : "",
            ], this.filters.contactBilling.search);
          });
          return this.sortTableItems(contacts, "contactBilling", {
            name: (contact) => contact.name,
            phone: (contact) => contact.phoneNumber,
            billingCycle: (contact) => this.getBillingCycleLabel(contact),
            dueDate: (contact) => this.getSortTimestamp(contact.dueDate),
            dueStatus: (contact) => this.getDueStatusLabel(contact.dueStatus || "NOT_SCHEDULED"),
            amount: (contact) => Number(contact.monthlyPaymentAmount || 0),
            amountSource: (contact) => this.getPaymentAmountSourceLabel(contact),
            currentPayment: (contact) => this.getCurrentPaymentLabel(contact),
            debt: (contact) => this.hasDebt(contact) ? Number(contact.debtCount || 1) : 0,
          });
        },

        get filteredHotspotContacts() {
          const contacts = this.contacts.filter((contact) => {
            const selectedStatus = String(this.filters.contactHotspot.status || "ALL").toUpperCase();
            if (selectedStatus !== "ALL") {
              const [scope, ...labelParts] = String(this.filters.contactHotspot.status).split("|");
              const expected = labelParts.join("|");
              const actual = {
                HOTSPOT: this.getHotspotUserAccessLabel(contact),
                IP_BINDING: this.getIpBindingAccessLabel(contact),
                SCHEDULE: this.getReactivationLabel(contact),
                AP: this.getContactApStatusLabel(contact),
              }[scope];
              if (actual !== expected) return false;
            }

            return this.searchValuesMatch([
              contact.name,
              contact.phoneNumber,
              this.getMikrotikAccessIdentifier(contact),
              contact.mikrotikProfile || "Belum ada profile",
              this.getIpBindingCountLabel(contact),
              this.getIpBindingTableStatus(contact),
              this.getHotspotUserAccessLabel(contact),
              contact.hotspotProvisioningError,
              this.getIpBindingAccessLabel(contact),
              this.getReactivationLabel(contact),
              this.getReactivationDetail(contact),
              contact.linkedApHost || "Belum dipilih",
              this.getContactApStatusLabel(contact),
            ], this.filters.contactHotspot.search);
          });
          return this.sortTableItems(contacts, "contactHotspot", {
            name: (contact) => contact.name,
            phone: (contact) => contact.phoneNumber,
            username: (contact) => this.getMikrotikAccessIdentifier(contact),
            profile: (contact) => contact.mikrotikProfile,
            ipBinding: (contact) => Array.isArray(contact.mikrotikMacAddresses) ? contact.mikrotikMacAddresses.length : 0,
            hotspotAccess: (contact) => this.getHotspotUserAccessLabel(contact),
            ipBindingAccess: (contact) => this.getIpBindingAccessLabel(contact),
            scheduleStatus: (contact) => this.getReactivationLabel(contact),
            scheduleAt: (contact) => this.getSortTimestamp(contact.hotspotReactivationAt),
            linkedAp: (contact) => contact.linkedApHost,
            apStatus: (contact) => this.getContactApStatusLabel(contact),
          });
        },

        get filteredApMonitors() {
          const monitors = this.apMonitors.filter((ap) => {
            const selectedStatus = String(this.filters.monitorAp.status || "ALL").toUpperCase();
            const selectedLinkStatus = String(this.filters.monitorAp.linkStatus || "ALL").toUpperCase();
            const status = String(ap.status || "UNKNOWN").toUpperCase();
            if (selectedStatus !== "ALL" && status !== selectedStatus) return false;
            if (selectedLinkStatus !== "ALL" && String(ap.linkStatus || "UNLINKED").toUpperCase() !== selectedLinkStatus) return false;
            const searchableAp = {
              ...ap,
              linkedCustomerNames: (ap.linkedContacts || []).map((contact) => contact.name).join(" "),
              linkedCustomerPhones: (ap.linkedContacts || []).map((contact) => contact.phoneNumber).join(" "),
            };
            return this.searchMatches(searchableAp, [
              "host",
              "status",
              "since",
              "comment",
              "interval",
              "timeout",
              "type",
              "linkStatus",
              "linkedCustomerNames",
              "linkedCustomerPhones",
            ], this.filters.monitorAp.search);
          });
          return this.sortTableItems(monitors, "monitorAp", {
            host: (ap) => ap.host,
            status: (ap) => ap.status,
            customers: (ap) => Number(ap.customerCount ?? ap.linkedContacts?.length ?? 0),
            linkStatus: (ap) => ap.linkStatus,
            since: (ap) => ap.since,
            interval: (ap) => ap.interval,
            timeout: (ap) => ap.timeout,
            comment: (ap) => ap.comment,
          });
        },

        get filteredReminders() {
          const now = Date.now();
          const reminders = this.reminders.filter((reminder) => {
            const deliveryDateTime = reminder.deliveryDateTime || reminder.reminderDateTime;
            const reminderTime = new Date(deliveryDateTime).getTime();
            const schedule = this.filters.reminders.schedule;
            const billingCycle = this.getBillingCycleValue(reminder);
            const deliveryType = String(reminder.deliveryScheduleType || "DEFAULT").toUpperCase();
            const selectedBillingCycle = String(this.filters.reminders.billingCycle || "ALL").toUpperCase();
            const selectedDeliveryType = String(this.filters.reminders.deliveryType || "ALL").toUpperCase();
            if (selectedBillingCycle !== "ALL" && billingCycle !== selectedBillingCycle) return false;
            if (selectedDeliveryType !== "ALL" && deliveryType !== selectedDeliveryType) return false;
            if (schedule === "TODAY" && !this.isToday(deliveryDateTime)) return false;
            if (schedule === "UPCOMING" && (!Number.isFinite(reminderTime) || reminderTime < now)) return false;
            if (schedule === "OVERDUE" && (!Number.isFinite(reminderTime) || reminderTime >= now)) return false;
            return this.searchValuesMatch([
              reminder.contactName || "Contact tidak ditemukan",
              reminder.phoneNumber || "-",
              this.getBillingCycleLabel(reminder),
              this.getReminderDeliveryLabel(reminder),
              deliveryDateTime,
              this.formatDateTime(deliveryDateTime),
              reminder.reminderDateTime,
              reminder.reminderDateTime ? this.formatDateTime(reminder.reminderDateTime) : "",
              reminder.templateName || "-",
              reminder.message,
            ], this.filters.reminders.search);
          });
          return this.sortTableItems(reminders, "reminders", {
            contact: (reminder) => reminder.contactName || reminder.phoneNumber,
            billingCycle: (reminder) => this.getBillingCycleLabel(reminder),
            deliveryAt: (reminder) => this.getSortTimestamp(reminder.deliveryDateTime || reminder.reminderDateTime),
            template: (reminder) => reminder.templateName,
            message: (reminder) => reminder.message,
          });
        },

        get filteredSent() {
          const entries = this.sent.filter((item) => {
            const status = String(item.deliveryStatus || "SENT").toUpperCase();
            const selectedStatus = String(this.filters.sent.status || "ALL").toUpperCase();
            if (selectedStatus !== "ALL" && status !== selectedStatus) return false;
            const sentAt = item.sentAt || item.reminderDateTime;
            return this.searchValuesMatch([
              item.contactName || "Contact tidak ditemukan",
              item.phoneNumber || "-",
              sentAt,
              sentAt ? this.formatDateTime(sentAt) : "",
              status,
              item.message || "-",
            ], this.filters.sent.search);
          });
          return this.sortTableItems(entries, "sent", {
            contact: (item) => item.contactName || item.phoneNumber,
            sentAt: (item) => this.getSortTimestamp(item.sentAt || item.reminderDateTime),
            status: (item) => item.deliveryStatus || "SENT",
            message: (item) => item.message,
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
            revenue: this.filteredRevenueEntries.length,
            voucherRevenue: this.filteredVoucherRevenueEntries.length,
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

        get hasContactBillingFilters() {
          const filters = this.filters.contactBilling;
          return Boolean(String(filters.search || "").trim())
            || String(filters.billingCycle || "ALL") !== "ALL"
            || String(filters.status || "ALL") !== "ALL"
            || String(filters.dueStatus || "ALL") !== "ALL";
        },

        resetContactBillingFilters() {
          this.filters.contactBilling.search = "";
          this.filters.contactBilling.billingCycle = "ALL";
          this.filters.contactBilling.status = "ALL";
          this.filters.contactBilling.dueStatus = "ALL";
          this.resetPage("contactBilling");
        },

        get hasContactHotspotFilters() {
          const filters = this.filters.contactHotspot;
          return Boolean(String(filters.search || "").trim())
            || String(filters.status || "ALL") !== "ALL";
        },

        resetContactHotspotFilters() {
          this.filters.contactHotspot.search = "";
          this.filters.contactHotspot.status = "ALL";
          this.resetPage("contactHotspot");
        },

        get hasContactDataFilters() {
          const filters = this.filters.contacts;
          return Boolean(String(filters.search || "").trim())
            || String(filters.billingCycle || "ALL") !== "ALL"
            || String(filters.apStatus || "ALL") !== "ALL";
        },

        resetContactDataFilters() {
          this.filters.contacts.search = "";
          this.filters.contacts.billingCycle = "ALL";
          this.filters.contacts.apStatus = "ALL";
          this.resetPage("contacts");
        },

        get hasReminderFilters() {
          const filters = this.filters.reminders;
          return Boolean(String(filters.search || "").trim())
            || String(filters.billingCycle || "ALL") !== "ALL"
            || String(filters.deliveryType || "ALL") !== "ALL"
            || String(filters.schedule || "ALL") !== "ALL";
        },

        resetReminderFilters() {
          this.filters.reminders.search = "";
          this.filters.reminders.billingCycle = "ALL";
          this.filters.reminders.deliveryType = "ALL";
          this.filters.reminders.schedule = "ALL";
          this.resetPage("reminders");
        },

        get hasSentFilters() {
          const filters = this.filters.sent;
          return Boolean(String(filters.search || "").trim())
            || String(filters.status || "ALL") !== "ALL";
        },

        resetSentFilters() {
          this.filters.sent.search = "";
          this.filters.sent.status = "ALL";
          this.resetPage("sent");
        },


        getDefaultRevenueDateRange() {
          const today = this.formatDateInput(new Date());
          const period = /^\d{4}-\d{2}$/.test(String(this.billingPeriod || ""))
            ? this.billingPeriod
            : today.slice(0, 7);
          return { from: `${period}-01`, to: today };
        },

        hasChangedRevenueDateRange() {
          const defaults = this.getDefaultRevenueDateRange();
          return this.revenueDateFrom !== defaults.from || this.revenueDateTo !== defaults.to;
        },

        restoreRevenueDateRange() {
          if (!this.hasChangedRevenueDateRange()) return;
          const defaults = this.getDefaultRevenueDateRange();
          this.revenueDateFrom = defaults.from;
          this.revenueDateTo = defaults.to;
          this.handleRevenueDateRangeChange();
        },

        get hasRevenueFilters() {
          return Boolean(String(this.filters.revenue.search || "").trim())
            || String(this.filters.revenue.status || "ALL") !== "ALL"
            || this.hasChangedRevenueDateRange();
        },

        resetRevenueFilters() {
          this.filters.revenue.search = "";
          this.filters.revenue.status = "ALL";
          this.resetPage("revenue");
          this.restoreRevenueDateRange();
        },

        get hasVoucherRevenueFilters() {
          return Boolean(String(this.filters.voucherRevenue.search || "").trim())
            || String(this.filters.voucherRevenue.profile || "ALL") !== "ALL"
            || this.hasChangedRevenueDateRange();
        },

        resetVoucherRevenueFilters() {
          this.filters.voucherRevenue.search = "";
          this.filters.voucherRevenue.profile = "ALL";
          this.resetPage("voucherRevenue");
          this.restoreRevenueDateRange();
        },

        get hasMonitorApFilters() {
          return Boolean(String(this.filters.monitorAp.search || "").trim())
            || String(this.filters.monitorAp.status || "ALL") !== "ALL"
            || String(this.filters.monitorAp.linkStatus || "ALL") !== "ALL";
        },

        resetMonitorApFilters() {
          this.filters.monitorAp.search = "";
          this.filters.monitorAp.status = "ALL";
          this.filters.monitorAp.linkStatus = "ALL";
          this.resetPage("monitorAp");
        },

        paginationLabel(key, total) {
          this.clampPage(key, total);
          if (!total) return "Menampilkan 0 data";
          const pageSize = this.filters[key].pageSize;
          const start = (this.filters[key].page - 1) * pageSize + 1;
          const end = Math.min(total, start + pageSize - 1);
          return `Menampilkan ${start}-${end} dari ${total} data`;
        },

  };
}
