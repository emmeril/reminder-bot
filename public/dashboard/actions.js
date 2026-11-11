function createDashboardActions() {
  return {
        openReminderDetail(reminder, trigger = null) {
          if (!reminder) return;
          this.reminderDetailModal = {
            open: true,
            reminder,
            returnFocusElement: trigger,
          };
          document.body.classList.add("overflow-hidden");
          this.$nextTick(() => document.getElementById("reminder-detail-close")?.focus());
        },

        closeReminderDetail() {
          if (!this.reminderDetailModal.open) return;
          const returnFocusElement = this.reminderDetailModal.returnFocusElement;
          this.reminderDetailModal = {
            open: false,
            reminder: null,
            returnFocusElement: null,
          };
          document.body.classList.remove("overflow-hidden");
          this.$nextTick(() => {
            if (returnFocusElement?.isConnected) {
              returnFocusElement.focus();
            } else {
              document.getElementById("reminders-search-input")?.focus();
            }
          });
        },

        getContactCreatePayload() {
          return {
            name: this.forms.contact.name,
            phoneNumber: this.forms.contact.phoneNumber,
            linkedApHost: this.forms.contact.linkedApHost,
            billingCycle: this.forms.contact.billingCycle,
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
            billingCycle: contact.billingCycle || "PREPAID",
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
                  billingCycle: this.forms.contactEdit.billingCycle,
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
            this.forms.hotspotAccount.macAddresses = [...(selected.mikrotikMacAddresses || [])];
            this.forms.hotspotAccount.username = selected.mikrotikUsername || this.suggestHotspotUsername(selected.name);
            this.forms.hotspotAccount.profile = selected.mikrotikProfile || "";
            this.forms.hotspotAccount.password = selected.mikrotikUsername ? "" : String(selected.phoneNumber || "").slice(-5);
            this.forms.hotspotAccount.sendCredentials = !selected.mikrotikUsername;
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
          this.forms.hotspotAccount.macAddresses = [...(selected.mikrotikMacAddresses || [])];
          this.forms.hotspotAccount.username = selected.mikrotikUsername || this.suggestHotspotUsername(selected.name);
          this.forms.hotspotAccount.profile = selected.mikrotikProfile || "";
          this.forms.hotspotAccount.password = selected.mikrotikUsername ? "" : String(selected.phoneNumber || "").slice(-5);
          this.forms.hotspotAccount.sendCredentials = !selected.mikrotikUsername;
        },

        async saveHotspotAccount() {
          if (this.hotspotAccountModal.loading) return;
          const form = this.forms.hotspotAccount;
          if (!form.contactId) return;
          if (String(form.newMacAddress || "").trim()) {
            this.addHotspotMacAddress();
            if (String(form.newMacAddress || "").trim()) return;
          }
          this.hotspotAccountModal.loading = true;
          this.clearFormError("hotspotAccount");
          try {
            await this.withProcessing("Menyimpan akun hotspot...", async () => {
              const payload = {
                mikrotikMacAddresses: form.macAddresses,
                mikrotikUsername: form.username,
                mikrotikProfile: form.profile,
                sendCredentials: form.sendCredentials,
              };
              if (form.password) payload.mikrotikPassword = form.password;
              const result = await this.api(`/api/contacts/${form.contactId}/hotspot`, {
                method: "POST",
                body: JSON.stringify(payload),
              });
              const bandwidthStatus = String(result.ipBindingBandwidthStatus || "").toUpperCase();
              if (["PARTIAL", "PENDING_DHCP"].includes(bandwidthStatus)) {
                this.notify("Akun hotspot tersimpan. Simple Queue per IP akan dibuat saat perangkat mendapat IP.");
              } else if (bandwidthStatus === "NO_RATE_LIMIT") {
                this.notify("Akun hotspot tersimpan. Atur rate limit profile agar IP Binding memiliki batas bandwidth.");
              } else if (bandwidthStatus === "FAILED") {
                this.notify("Akun hotspot tersimpan, tetapi sinkronisasi bandwidth perlu dicoba ulang.");
              } else {
                this.notify(result.hotspotSynced ? "Akun hotspot berhasil disinkronkan ke MikroTik." : "Akun hotspot sudah tersimpan.");
              }
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

        openHotspotAccessModeModal(contact, trigger = null) {
          if (!this.canConfigureHotspotAccessMode(contact)) return;
          this.hotspotAccessModeModal.contact = contact;
          this.hotspotAccessModeModal.mode = this.getEffectiveHotspotAccessMode(contact);
          this.hotspotAccessModeModal.returnFocusId = trigger?.id || "";
          this.clearFormError("hotspotAccessMode");
          this.hotspotAccessModeModal.open = true;
          document.body.classList.add("overflow-hidden");
          this.$nextTick(() => document.getElementById("hotspot-access-mode-close")?.focus());
        },

        closeHotspotAccessModeModal() {
          if (this.hotspotAccessModeModal.loading) return;
          const returnFocusId = this.hotspotAccessModeModal.returnFocusId;
          this.hotspotAccessModeModal.open = false;
          this.hotspotAccessModeModal.contact = null;
          this.hotspotAccessModeModal.mode = "HOTSPOT_ONLY";
          this.hotspotAccessModeModal.returnFocusId = "";
          this.clearFormError("hotspotAccessMode");
          document.body.classList.remove("overflow-hidden");
          if (returnFocusId) this.$nextTick(() => document.getElementById(returnFocusId)?.focus());
        },

        hotspotAccessModeNeedsMac(mode = this.hotspotAccessModeModal.mode) {
          return ["IP_BINDING_ONLY", "BOTH"].includes(String(mode || "").toUpperCase());
        },

        async saveHotspotAccessMode() {
          const modal = this.hotspotAccessModeModal;
          if (modal.loading || !modal.contact?.id) return;
          const hasBindings = Array.isArray(modal.contact.mikrotikMacAddresses)
            && modal.contact.mikrotikMacAddresses.length > 0;
          if (this.hotspotAccessModeNeedsMac(modal.mode) && !hasBindings) {
            this.setFormError("hotspotAccessMode", "Tambahkan minimal satu MAC address sebelum mengaktifkan IP Binding.");
            return;
          }

          modal.loading = true;
          this.clearFormError("hotspotAccessMode");
          try {
            const selectedMode = modal.mode;
            await this.withProcessing("Menerapkan mode akses...", async () => {
              await this.api(`/api/contacts/${modal.contact.id}/hotspot/access-mode`, {
                method: "POST",
                body: JSON.stringify({ mode: selectedMode }),
              });
              const messages = {
                HOTSPOT_ONLY: "Akun Hotspot aktif. Perangkat IP Binding tetap wajib login.",
                IP_BINDING_ONLY: "IP Binding aktif otomatis. Akun Hotspot dinonaktifkan.",
                BOTH: "Akun Hotspot dan IP Binding aktif bersamaan.",
                DISABLED: "Seluruh akses pelanggan berhasil dinonaktifkan.",
              };
              modal.loading = false;
              this.closeHotspotAccessModeModal();
              this.notify(messages[selectedMode] || "Mode akses berhasil diperbarui.");
              await Promise.all([this.loadContacts(), this.loadStatus(), this.loadLogs()]);
            });
          } catch (error) {
            this.setFormError("hotspotAccessMode", error);
          } finally {
            modal.loading = false;
          }
        },

        openHotspotScheduleModal(contact) {
          if (!contact?.id || !contact.mikrotikUsername || !contact.mikrotikProfile) return;
          this.hotspotScheduleModal.contact = contact;
          this.forms.hotspotSchedule = {
            contactId: String(contact.id),
            mode: contact.hotspotReactivationEnabled
              ? "REACTIVATE"
              : (contact.hotspotReactivationAt ? "DEACTIVATE" : "NONE"),
            date: this.formatDateInput(contact.hotspotReactivationAt),
            time: this.formatTimeInput(contact.hotspotReactivationAt) || "00:00",
          };
          if (!this.isRecurringSubscription(contact) && this.forms.hotspotSchedule.mode === "REACTIVATE") {
            this.forms.hotspotSchedule.mode = "NONE";
          }
          this.clearFormError("hotspotSchedule");
          this.hotspotScheduleModal.open = true;
          document.body.classList.add("overflow-hidden");
        },

        closeHotspotScheduleModal() {
          if (this.hotspotScheduleModal.loading) return;
          this.hotspotScheduleModal.open = false;
          this.hotspotScheduleModal.contact = null;
          this.forms.hotspotSchedule = this.blankHotspotScheduleForm();
          this.clearFormError("hotspotSchedule");
          document.body.classList.remove("overflow-hidden");
        },

        getHotspotScheduleSummary() {
          const form = this.forms.hotspotSchedule;
          if (form.mode === "NONE") return "Tidak ada perubahan otomatis pada akun hotspot.";
          if (!form.date) return "Pilih tanggal dan waktu untuk melihat ringkasan jadwal.";
          const schedule = this.formatDateTime(this.buildHotspotReactivationAt(form));
          if (form.mode === "REACTIVATE") {
            return `Akun akan diaktifkan kembali pada ${schedule}. Setelah berhasil, jadwal berikutnya dibuat untuk bulan selanjutnya.`;
          }
          return `Akun akan dinonaktifkan pada ${schedule}. Data akun tetap tersimpan di MikroTik.`;
        },

        async saveHotspotSchedule() {
          if (this.hotspotScheduleModal.loading) return;
          const contact = this.hotspotScheduleModal.contact;
          const form = this.forms.hotspotSchedule;
          if (!contact?.id) return;
          if (form.mode !== "NONE" && !form.date) {
            this.setFormError("hotspotSchedule", "Tanggal jadwal wajib dipilih.");
            return;
          }

          this.hotspotScheduleModal.loading = true;
          this.clearFormError("hotspotSchedule");
          try {
            await this.withProcessing("Menyimpan jadwal layanan...", async () => {
              await this.api(`/api/contacts/${contact.id}/hotspot`, {
                method: "POST",
                body: JSON.stringify({
                  mikrotikUsername: contact.mikrotikUsername,
                  mikrotikProfile: contact.mikrotikProfile,
                  sendCredentials: false,
                  hotspotReactivationEnabled: form.mode === "REACTIVATE",
                  hotspotReactivationAt: form.mode === "NONE" ? "" : this.buildHotspotReactivationAt(form),
                }),
              });
              const message = form.mode === "REACTIVATE"
                ? "Jadwal aktif otomatis bulanan berhasil disimpan."
                : (form.mode === "DEACTIVATE" ? "Jadwal penonaktifan berhasil disimpan." : "Jadwal layanan berhasil dihapus.");
              this.hotspotScheduleModal.loading = false;
              this.closeHotspotScheduleModal();
              this.notify(message);
              await Promise.all([this.loadContacts(), this.loadStatus(), this.loadLogs()]);
            });
          } catch (error) {
            this.setFormError("hotspotSchedule", error);
          } finally {
            this.hotspotScheduleModal.loading = false;
          }
        },

        hasBillingPaymentActions(contact) {
          if (!contact?.id) return false;
          if (this.isPrepaidPackage(contact)) return this.canPurchaseActivePeriod(contact);
          return Boolean(
            (contact.subscriptionActive !== false && contact.currentPaymentStatus !== "PAID")
            || this.hasDebt(contact)
            || this.canSendBillingReminder(contact)
            || (contact.subscriptionActive !== false && contact.currentPaymentStatus === "PAID")
          );
        },

        hasBillingActions(contact) {
          return Boolean(contact?.id);
        },

        openBillingActionModal(contact, trigger = null) {
          if (!this.hasBillingActions(contact)) return;
          this.billingActionModal = {
            open: true,
            contact,
            activeTab: "actions",
            amountDraft: String(contact.monthlyPaymentAmount ?? 0),
            amountSaving: false,
            amountError: "",
            returnFocusId: trigger?.id || "",
          };
          document.body.classList.add("overflow-hidden");
          this.$nextTick(() => document.getElementById("billing-action-close")?.focus());
        },

        closeBillingActionModal() {
          if (!this.billingActionModal.open || this.billingActionModal.amountSaving) return;
          const returnFocusId = this.billingActionModal.returnFocusId;
          this.billingActionModal = {
            open: false,
            contact: null,
            activeTab: "actions",
            amountDraft: "",
            amountSaving: false,
            amountError: "",
            returnFocusId: "",
          };
          document.body.classList.remove("overflow-hidden");
          this.$nextTick(() => document.getElementById(returnFocusId)?.focus());
        },

        selectBillingActionTab(tab) {
          if (!this.billingActionModal.open || this.billingActionModal.amountSaving) return;
          if (!["actions", "amount"].includes(tab)) return;
          this.billingActionModal.activeTab = tab;
          this.billingActionModal.amountError = "";
          this.$nextTick(() => document.getElementById(`billing-action-tab-${tab}`)?.focus());
        },

        async saveBillingActionAmount() {
          const modal = this.billingActionModal;
          if (!modal.open || !modal.contact?.id || modal.amountSaving) return;
          const raw = String(modal.amountDraft ?? "").trim();
          const amount = Number(raw);
          if (!/^\d+$/.test(raw) || !Number.isSafeInteger(amount) || amount > 1_000_000_000) {
            modal.amountError = "Masukkan nominal bulanan dari Rp 0 sampai Rp 1.000.000.000.";
            return;
          }
          modal.amountSaving = true;
          modal.amountError = "";
          try {
            const updated = await this.saveContactPaymentAmount({
              ...modal.contact,
              monthlyPaymentAmount: amount,
            });
            if (updated) {
              modal.contact = updated;
              modal.amountDraft = String(updated.monthlyPaymentAmount);
            }
          } catch (error) {
            modal.amountError = error?.message || "Nominal gagal disimpan. Coba lagi.";
          } finally {
            modal.amountSaving = false;
          }
        },

        async resetBillingActionAmount() {
          const modal = this.billingActionModal;
          if (!modal.open || !modal.contact?.id || modal.amountSaving || !this.hasProfileMonthlyAmount(modal.contact)) return;
          modal.amountSaving = true;
          modal.amountError = "";
          try {
            const updated = await this.resetContactPaymentAmount(modal.contact);
            if (updated) {
              modal.contact = updated;
              modal.amountDraft = String(updated.monthlyPaymentAmount);
            }
          } catch (error) {
            modal.amountError = error?.message || "Tarif profil gagal dipulihkan. Coba lagi.";
          } finally {
            modal.amountSaving = false;
          }
        },

        trapModalFocus(event, dialogId) {
          const dialog = document.getElementById(dialogId);
          if (!dialog) return;
          const controls = Array.from(dialog.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
          )).filter((element) => element.offsetParent !== null);
          if (!controls.length) return;
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        },

        async runBillingPayment(status, paymentType = "") {
          const contact = this.billingActionModal.contact;
          if (!contact?.id) return;
          await this.togglePayment(contact.id, status, paymentType);
          this.closeBillingActionModal();
        },

        async sendBillingActionReminder() {
          const contact = this.billingActionModal.contact;
          if (!contact?.id) return;
          await this.sendBillingReminder(contact);
          this.closeBillingActionModal();
        },

        async payArrears(contact) {
          const paymentAmount = Number(this.arrearsPaymentAmounts[contact.id]);
          const debtAmount = this.getDebtAmount(contact);
          if (!Number.isSafeInteger(paymentAmount) || paymentAmount <= 0) {
            this.notify("Masukkan nominal pembayaran tunggakan lebih dari Rp0.");
            return;
          }
          if (paymentAmount > debtAmount) {
            this.notify(`Nominal pembayaran tidak boleh melebihi sisa tunggakan ${this.formatRupiah(debtAmount)}.`);
            return;
          }

          await this.togglePayment(contact.id, "UNPAID", "ARREARS-ONLY", paymentAmount);
          delete this.arrearsPaymentAmounts[contact.id];
          this.closeBillingActionModal();
        },

        canPurchaseActivePeriod(contact) {
          if (!contact?.id) return false;
          if (String(contact.subscriptionType || "RECURRING").toUpperCase().replace(/-/g, "_") !== "RECURRING") return false;
          if (!contact.mikrotikUsername || !contact.mikrotikProfile || Number(contact.monthlyPaymentAmount) <= 0) return false;
          const status = this.getHotspotProvisioningStatus(contact);
          return this.isPrepaidPackage(contact) && (status === "ACTIVE" || status === "DISABLED");
        },

        getActivePeriodPurchaseLabel(contact) {
          return contact?.packageActive ? "Tambah paket 1 bulan" : "Beli paket 1 bulan";
        },

        getActivePeriodPurchaseHelp(contact) {
          if (contact?.packageActive && contact?.hotspotReactivationAt) {
            return `Masa aktif baru ditambahkan setelah ${this.formatDateTime(contact.hotspotReactivationAt)}.`;
          }
          return "Paket berlaku satu bulan sejak pembayaran dan tidak membuat tunggakan.";
        },

        purchaseActivePeriod(contact) {
          if (!this.canPurchaseActivePeriod(contact)) return;
          const amount = this.formatRupiah(contact.monthlyPaymentAmount);
          const extending = Boolean(contact.packageActive && contact.hotspotReactivationAt);
          this.closeBillingActionModal();
          this.openDeleteConfirm({
            title: extending ? "Tambah masa aktif satu bulan?" : "Beli masa aktif satu bulan?",
            description: extending
              ? `Pembayaran ${amount} akan menambah masa aktif satu bulan setelah paket yang sekarang.`
              : `Pembayaran ${amount} akan mengaktifkan paket hotspot selama satu bulan tanpa membuat tunggakan.`,
            confirmLabel: extending ? "Tambah masa aktif" : "Beli dan aktifkan",
            processingMessage: extending ? "Menambah masa aktif..." : "Mencatat pembelian masa aktif...",
            action: async () => {
              const storageKey = `active-period-purchase:${contact.id}`;
              let requestId = sessionStorage.getItem(storageKey);
              if (!/^ACT-[0-9a-f-]{36}$/i.test(requestId || "")) {
                let uuid = globalThis.crypto?.randomUUID?.();
                if (!uuid && globalThis.crypto?.getRandomValues) {
                  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
                  bytes[6] = (bytes[6] & 0x0f) | 0x40;
                  bytes[8] = (bytes[8] & 0x3f) | 0x80;
                  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
                  uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
                }
                if (!uuid) throw new Error("Browser tidak mendukung pembuatan ID transaksi aman.");
                requestId = `ACT-${uuid}`;
                sessionStorage.setItem(storageKey, requestId);
              }
              const endpoint = `/api/contacts/${contact.id}/active-period-purchase`;
              const checkStatus = () => this.api(`${endpoint}/${encodeURIComponent(requestId)}`, { silent: true });
              let result;
              try {
                const current = await checkStatus();
                if (current.status === "COMPLETED" && current.purchase) {
                  result = current;
                } else if (["PROCESSING", "REVIEW_REQUIRED"].includes(current.status)) {
                  throw new Error("Pembelian masih diproses atau perlu diperiksa. Masa aktif tidak ditambahkan lagi. Periksa riwayat dan status transaksi.");
                } else {
                  result = await this.api(endpoint, {
                    method: "POST",
                    body: JSON.stringify({ requestId }),
                    timeoutMs: 30_000,
                    timeoutMessage: "Respons pembelian terlambat. Status transaksi sedang diperiksa.",
                    silent: true,
                  });
                }
              } catch (error) {
                try {
                  const current = await checkStatus();
                  if (current.status === "COMPLETED" && current.purchase) {
                    result = current;
                  } else if (current.status === "PROCESSING" || current.status === "REVIEW_REQUIRED") {
                    throw new Error("Status pembelian belum pasti. Jangan membeli ulang. Periksa status dan riwayat sebelum mencoba lagi.");
                  }
                } catch (statusError) {
                  if (/Status pembelian belum pasti/.test(statusError.message)) throw statusError;
                  throw new Error("Tidak dapat memastikan hasil pembelian. Jangan membuat pembelian baru sampai status transaksi diperiksa.");
                }
                if (!result) throw error;
              }
              sessionStorage.removeItem(storageKey);
              const notificationText = result.notificationQueued ? " Bukti pembayaran sedang dikirim." : "";
              this.notify(`Masa aktif tercatat sampai ${this.formatDateTime(result.purchase.activeUntil)}.${notificationText}`);
              await Promise.all([this.loadContacts(), this.loadStatus(), this.loadLogs()]);
            },
          });
        },

        async togglePayment(id, status, paymentType = "", paymentAmount = null) {
          await this.withProcessing("Memperbarui status pembayaran...", async () => {
            const contact = this.contacts.find((item) => String(item.id) === String(id));
            const payload = { status };
            if (paymentType && contact) {
              payload.paymentType = paymentType || contact.paymentType || this.inferPaymentType(contact);
            }
            if (payload.paymentType === "ARREARS-ONLY" && paymentAmount !== null) {
              payload.paymentAmount = paymentAmount;
            }
            const result = await this.api(`/api/contacts/${id}/payment`, {
              method: "POST",
              body: JSON.stringify(payload),
            });
            if (status === "UNPAID" && payload.paymentType === "ARREARS-ONLY") {
              const paidText = this.formatRupiah(result.paymentAmount || paymentAmount);
              const remainingText = this.formatRupiah(result.remainingDebtAmount);
              if (result.notificationSent) {
                this.notify(`Pembayaran ${paidText} dicatat. Sisa tunggakan ${remainingText}. Notifikasi terkirim (${result.transactionId}).`);
              } else if (result.notificationError) {
                this.notify(`Pembayaran ${paidText} dicatat dengan sisa ${remainingText}, tapi notifikasi gagal: ${result.notificationError}`);
              } else {
                this.notify(`Pembayaran ${paidText} dicatat. Sisa tunggakan ${remainingText}.`);
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
              if (result.contact.hotspotManualActivationWithArrears && result.contact.hotspotReactivationAt) {
                this.notify(`Hotspot ${result.username} aktif manual sampai ${this.formatDateTime(result.contact.hotspotReactivationAt)}. Tunggakan tetap tersimpan.`);
              } else if (result.contact.hotspotReactivationEnabled && result.contact.hotspotReactivationAt) {
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
              : contact.hasDebt
                ? `Akun hotspot ${contact.mikrotikUsername || "ini"} akan aktif selama satu bulan dari sekarang. Tunggakan tetap tersimpan dan perpanjangan otomatis tetap dijeda sampai seluruh tunggakan lunas.`
                : `Akun hotspot ${contact.mikrotikUsername || "ini"} akan diaktifkan kembali di MikroTik.`,
            confirmLabel: disabled ? "Nonaktifkan" : "Aktifkan",
            action: async () => {
              await this.api(`/api/contacts/${contact.id}/hotspot/${disabled ? "disable" : "enable"}`, {
                method: "POST",
                body: JSON.stringify({}),
              });
              this.notify(!disabled && contact.hasDebt
                ? "Akun hotspot aktif selama satu bulan. Tunggakan tetap tersimpan."
                : `Akun hotspot berhasil ${action}.`);
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
          const hasHotspot = Boolean(contact?.mikrotikUsername);
          this.openDeleteConfirm({
            title: hasHotspot ? "Hapus pelanggan dan akun hotspot?" : "Hapus pelanggan?",
            description: hasHotspot
              ? `Data pelanggan ${label}, akun hotspot ${contact.mikrotikUsername} di MikroTik, dan reminder terkait akan dihapus. Tindakan ini tidak bisa dibatalkan.`
              : `Data pelanggan ${label} dan reminder terkait akan dihapus. Tindakan ini tidak bisa dibatalkan.`,
            confirmLabel: hasHotspot ? "Hapus pelanggan dan hotspot" : "Hapus pelanggan",
            action: async () => {
              await this.api(`/api/contacts/${contact.id}`, { method: "DELETE" });
              this.notify(hasHotspot ? "Pelanggan dan akun hotspot dihapus." : "Pelanggan dihapus.");
              await Promise.all([this.loadContacts(), this.loadReminders(), this.loadStatus()]);
            },
          });
        },

        applyTemplateContent(templateContent, contact, dateIso) {
          let msg = String(templateContent || "");
          const companyName = String(this.forms.settings.companyName || "Emmeril Hotspot").trim();
          const variables = {
            name: contact?.name || "",
            phoneNumber: contact?.phoneNumber || "",
            companyName,
            companyNameUpper: companyName.toUpperCase(),
            supportSignature: String(this.forms.settings.supportSignature || "CS Emmeril Hotspot").trim(),
          };
          if (dateIso) {
            try {
              variables.date = new Date(dateIso).toLocaleString("id-ID", { timeZone: this.getAppTimezone() });
            } catch {}
          }
          for (const [key, value] of Object.entries(variables)) {
            msg = msg.replace(new RegExp(`{{\\s*${key}\\s*}}`, "gi"), String(value));
          }
          return msg;
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

        openTemplateCreateModal(trigger = null) {
          this.forms.template = { name: "", content: "" };
          this.clearFormError("template");
          this.templateModal = {
            open: true,
            loading: false,
            mode: "create",
            originalName: "",
            returnFocusId: trigger?.id || "template-add-button",
          };
          document.body.classList.add("overflow-hidden");
          this.$nextTick(() => document.getElementById("template-name-input")?.focus());
        },

        openTemplateEditModal(template, trigger = null) {
          if (!template?.name) return;
          this.forms.template = {
            name: template.name,
            content: template.content || "",
          };
          this.clearFormError("template");
          this.templateModal = {
            open: true,
            loading: false,
            mode: "edit",
            originalName: template.name,
            returnFocusId: trigger?.id || "",
          };
          document.body.classList.add("overflow-hidden");
          this.$nextTick(() => document.getElementById("template-content-input")?.focus());
        },

        closeTemplateModal() {
          if (!this.templateModal.open || this.templateModal.loading) return;
          const returnFocusId = this.templateModal.returnFocusId;
          this.templateModal = {
            open: false,
            loading: false,
            mode: "create",
            originalName: "",
            returnFocusId: "",
          };
          this.forms.template = { name: "", content: "" };
          this.clearFormError("template");
          document.body.classList.remove("overflow-hidden");
          this.$nextTick(() => document.getElementById(returnFocusId)?.focus());
        },

        async saveTemplate() {
          if (this.templateModal.loading) return;
          const isEditing = this.templateModal.mode === "edit";
          const name = String(this.forms.template.name || "").trim();
          const content = String(this.forms.template.content || "");
          if (!name) {
            this.setFormError("template", "Nama file template wajib diisi.");
            return;
          }
          if (!content.trim()) {
            this.setFormError("template", "Isi template wajib diisi.");
            return;
          }

          this.templateModal.loading = true;
          this.clearFormError("template");
          try {
            await this.withProcessing(isEditing ? "Memperbarui template..." : "Menyimpan template...", async () => {
              const endpoint = isEditing
                ? `/api/templates/${encodeURIComponent(this.templateModal.originalName)}`
                : "/api/templates";
              const result = await this.api(endpoint, {
                method: isEditing ? "PUT" : "POST",
                body: JSON.stringify(isEditing ? { content } : { name, content }),
              });
              await this.loadTemplates();
              if (isEditing) await this.loadReminders();
              const syncedCount = Math.max(0, Number(result?.remindersUpdated) || 0);
              this.notify(isEditing && syncedCount > 0
                ? `Template diperbarui. ${syncedCount} jadwal reminder disinkronkan.`
                : (isEditing ? "Template diperbarui." : "Template ditambahkan."));
              this.templateModal.loading = false;
              this.closeTemplateModal();
            });
          } catch (error) {
            this.setFormError("template", error);
          } finally {
            this.templateModal.loading = false;
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

        savedAppIconUrl() {
          return this.branding.hasIcon && this.branding.version
            ? `/branding/icon?v=${encodeURIComponent(this.branding.version)}`
            : "";
        },

        appIconPreviewUrl() {
          if (this.branding.dirty) {
            if (this.branding.removePending) return "";
            if (this.branding.pendingDataUrl) return this.branding.pendingDataUrl;
          }
          return this.savedAppIconUrl();
        },

        async chooseAppIcon(event) {
          const file = event?.target?.files?.[0];
          if (!file) return;
          this.clearFormError("appIcon");
          this.branding.processing = true;
          let objectUrl = "";
          try {
            if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
              throw new Error("Gunakan gambar PNG, JPG, atau WebP.");
            }
            if (file.size > 3 * 1024 * 1024) {
              throw new Error("Ukuran gambar maksimal 3 MB.");
            }
            objectUrl = URL.createObjectURL(file);
            const image = new Image();
            image.src = objectUrl;
            await image.decode();
            if (!image.naturalWidth || !image.naturalHeight) {
              throw new Error("Gambar tidak dapat dibuka.");
            }

            const canvas = document.createElement("canvas");
            canvas.width = 256;
            canvas.height = 256;
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Browser tidak mendukung pengolahan gambar.");
            const scale = Math.min(256 / image.naturalWidth, 256 / image.naturalHeight);
            const width = Math.max(1, Math.round(image.naturalWidth * scale));
            const height = Math.max(1, Math.round(image.naturalHeight * scale));
            context.clearRect(0, 0, 256, 256);
            context.drawImage(image, Math.floor((256 - width) / 2), Math.floor((256 - height) / 2), width, height);

            const dataUrl = canvas.toDataURL("image/png");
            if (dataUrl.length > 350000) {
              throw new Error("Ikon masih terlalu besar setelah diperkecil. Pilih gambar lain.");
            }
            this.branding.pendingDataUrl = dataUrl;
            this.branding.removePending = false;
            this.branding.dirty = true;
            this.settingsDirty = true;
          } catch (error) {
            const message = String(error?.message || "");
            const failedToDecode = error?.name === "EncodingError"
              || /(?:cannot be decoded|failed to decode|image decode)/i.test(message);
            this.setFormError("appIcon", failedToDecode
              ? new Error("Gambar tidak dapat dibaca oleh browser. Pilih gambar PNG, JPG, atau WebP lain yang valid.")
              : error);
          } finally {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            if (event.target) event.target.value = "";
            this.branding.processing = false;
          }
        },

        removeAppIcon() {
          this.clearFormError("appIcon");
          this.branding.pendingDataUrl = "";
          this.branding.removePending = this.branding.hasIcon;
          this.branding.dirty = this.branding.hasIcon;
          if (this.branding.dirty) this.settingsDirty = true;
        },

        async saveSettings() {
          this.clearFormError("settings");
          this.clearFormError("recipients");
          this.clearFormError("appIcon");
          try {
            await this.withProcessing("Menyimpan pengaturan...", async () => {
              await this.api("/api/settings", {
                method: "PUT",
                body: JSON.stringify(this.forms.settings),
              });
              this.settingsDirty = false;
              if (typeof document !== "undefined") {
                document.title = this.forms.settings.dashboardTitle || document.title;
              }

              if (this.branding.dirty) {
                try {
                  const removing = this.branding.removePending;
                  const iconDataUrl = this.branding.pendingDataUrl;
                  const result = await this.api("/api/settings/icon", {
                    method: removing ? "DELETE" : "PUT",
                    ...(removing ? {} : { body: JSON.stringify({ dataUrl: iconDataUrl }) }),
                  });
                  if (this.branding.pendingDataUrl === iconDataUrl && this.branding.removePending === removing) {
                    this.branding.dirty = false;
                    this.branding.pendingDataUrl = "";
                    this.branding.removePending = false;
                  }
                  this.branding.hasIcon = Boolean(result.hasIcon);
                  this.branding.version = String(result.version || "");
                  if (typeof document !== "undefined") {
                    const favicon = document.querySelector('link[rel="icon"]');
                    if (favicon) favicon.href = this.savedAppIconUrl() || "/favicon.ico";
                  }
                } catch (error) {
                  this.setFormError("appIcon", error);
                  throw new Error(`Pengaturan lain sudah tersimpan, tetapi ikon aplikasi gagal disimpan: ${error.message}`);
                }
              }

              const saveRecipients = this.recipientsDirty;
              if (saveRecipients) {
                const recipients = this.forms.recipients;
                try {
                  await this.api("/api/admin-recipients", {
                    method: "PUT",
                    body: JSON.stringify({ recipients }),
                  });
                  if (this.forms.recipients === recipients) this.recipientsDirty = false;
                } catch (error) {
                  this.setFormError("recipients", error);
                  throw new Error(`Pengaturan lain tersimpan, tetapi penerima admin gagal disimpan: ${error.message}`);
                }
              }

              await Promise.all([this.loadStatus(), this.loadReminders(),
                ...(saveRecipients ? [this.loadRecipients()] : [])]);
              this.notify("Pengaturan diperbarui.");
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
          if (this.loading.broadcast) return;
          this.loading.broadcast = true;
          this.clearFormError("broadcast");
          try {
            await this.withProcessing("Mengirim broadcast...", async () => {
              const job = await this.api("/api/notifications/broadcast", {
                method: "POST",
                body: JSON.stringify(this.forms.broadcast),
              });
              const response = await this.waitForOperationJob(job);
              const successCount = response.filter((item) => ["accepted", "sent", "delivered", "read"].includes(item.status)).length;
              const failedCount = response.filter(r => r.status === "failed").length;
              this.forms.broadcast = { title: "", templateName: "", message: "" };
              this.notify(`Broadcast terkirim: ${successCount} berhasil, ${failedCount} gagal.`);
              await this.loadLogs();
            });
          } catch (error) {
            this.setFormError("broadcast", error);
          } finally {
            this.loading.broadcast = false;
          }
        },

        async sendBackupsNow() {
          if (this.loading.backups) return;
          this.loading.backups = true;
          this.clearFormError("settings");
          try {
            await this.withProcessing("Membuat dan mengirim backup MikroTik & Aplikasi...", async () => {
              const job = await this.api("/api/backups/send", {
                method: "POST",
                body: JSON.stringify({}),
              });
              const response = await this.waitForOperationJob(job);
              const files = Array.isArray(response?.files) ? response.files : [];
              const describe = (kind, name) => {
                const file = files.find((item) => item.kind === kind);
                if (!file) return `${name}: hasil tidak tersedia`;
                if (file.error) return `${name}: gagal dibuat (${file.error})`;
                if (file.status === "sent") return `${name}: terkirim ke ${file.sentCount} tujuan`;
                if (file.status === "partial") return `${name}: terkirim ${file.sentCount}, gagal ${file.failedCount}`;
                return `${name}: gagal dikirim ke ${file.failedCount} tujuan`;
              };
              const summary = `${describe("mikrotik", "MikroTik")}. ${describe("database", "Database aplikasi")}.`;
              this.notify(summary);
              if (files.length !== 2 || files.some((item) => item.status !== "sent")) {
                this.setFormError("settings", new Error(summary));
              }
              await Promise.allSettled([this.loadLogs(), this.loadStatus()]);
            });
          } catch (error) {
            this.setFormError("settings", error);
          } finally {
            this.loading.backups = false;
          }
        },

        async runScheduler() {
          if (this.loading.scheduler) return;
          this.loading.scheduler = true;
          try {
            await this.withProcessing("Menjalankan scheduler...", async () => {
              const job = await this.api("/api/scheduler/run", {
                method: "POST",
                body: JSON.stringify({}),
              });
              await this.waitForOperationJob(job);
              this.notify("Scheduler selesai dijalankan.");
              await this.refreshAll();
            });
          } finally {
            this.loading.scheduler = false;
          }
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
