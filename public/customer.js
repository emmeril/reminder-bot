function customerPortalApp() {
  return {
    data: null,
    loading: true,
    loggingOut: false,
    error: "",
    showHotspotPassword: false,
    copied: "",
    passwordModalOpen: false,
    passwordModalTarget: "hotspot",
    changingPassword: false,
    passwordForm: { currentPassword: "", newPassword: "", confirmPassword: "" },
    passwordMessage: { type: "", text: "" },
    showPasswordFields: { current: false, new: false, confirm: false },

    async request(path, options = {}) {
      const response = await fetch(path, { credentials: "same-origin", ...options });
      const payload = await response.json();
      if (response.status === 401) {
        window.location.href = "/pelanggan/login";
        throw new Error("Sesi berakhir. Silakan masuk kembali.");
      }
      if (!response.ok || !payload.success) throw new Error(payload.error || "Permintaan gagal.");
      return payload.data;
    },

    async load() {
      this.loading = true;
      this.error = "";
      try {
        this.data = await this.request("/api/pelanggan/account");
      } catch (error) {
        this.error = error.message;
      } finally {
        this.loading = false;
      }
    },

    async logout() {
      this.loggingOut = true;
      try {
        await this.request("/api/pelanggan/auth/logout", { method: "POST" });
      } catch (_) {
        // Redirect tetap dilakukan agar sesi lokal tidak dipakai lagi.
      }
      window.location.href = "/pelanggan/login";
    },

    openPasswordModal(target = "hotspot") {
      this.passwordModalTarget = target === "portal" ? "portal" : "hotspot";
      this.passwordModalOpen = true;
      this.passwordMessage = { type: "", text: "" };
      document.body.style.overflow = "hidden";
      this.$nextTick(() => this.$refs.currentPasswordInput?.focus());
    },

    closePasswordModal() {
      if (this.changingPassword) return;
      this.passwordModalOpen = false;
      this.passwordModalTarget = "hotspot";
      this.passwordForm = { currentPassword: "", newPassword: "", confirmPassword: "" };
      this.passwordMessage = { type: "", text: "" };
      this.showPasswordFields = { current: false, new: false, confirm: false };
      document.body.style.overflow = "";
    },

    async changePassword() {
      this.passwordMessage = { type: "", text: "" };
      if (this.passwordForm.newPassword !== this.passwordForm.confirmPassword) {
        this.passwordMessage = { type: "error", text: "Konfirmasi password baru tidak sama." };
        return;
      }
      this.changingPassword = true;
      try {
        const changingPortalPassword = this.passwordModalTarget === "portal";
        const endpoint = changingPortalPassword
          ? "/api/pelanggan/account/password"
          : "/api/pelanggan/hotspot/password";
        this.data = await this.request(endpoint, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(this.passwordForm),
        });
        this.passwordForm = { currentPassword: "", newPassword: "", confirmPassword: "" };
        this.showPasswordFields = { current: false, new: false, confirm: false };
        this.showHotspotPassword = false;
        this.passwordMessage = {
          type: "success",
          text: changingPortalPassword
            ? "Password akun pelanggan berhasil diubah. Gunakan password baru saat login berikutnya."
            : "Password hotspot berhasil diubah dan disinkronkan ke MikroTik.",
        };
      } catch (error) {
        this.passwordMessage = { type: "error", text: error.message || "Password gagal diubah." };
      } finally {
        this.changingPassword = false;
      }
    },

    currency(value) {
      return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(Number(value) || 0);
    },

    date(value) {
      if (!value) return "-";
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) return "-";
      return new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", year: "numeric" }).format(parsed);
    },

    isPaid() { return this.data?.billing?.currentPaymentStatus === "PAID"; },
    hotspotIsActive() { return this.data?.hotspot?.status === "ACTIVE"; },
    hotspotStatusLabel() {
      const labels = { ACTIVE: "Aktif", PENDING: "Diproses", PROVISIONING: "Diproses", FAILED: "Perlu dicek", DEACTIVATED: "Nonaktif", MISSING: "Tidak ditemukan", CHANGED: "Berubah", NONE: "Belum aktif" };
      return labels[this.data?.hotspot?.status] || "Belum aktif";
    },
    debtLabel() {
      const count = Number(this.data?.billing?.debtCount) || 0;
      return count ? `${count} bulan belum lunas` : "Tidak ada tunggakan";
    },
    billingSummary() {
      return Number(this.data?.billing?.totalAmount) > 0 ? "Jumlah yang perlu dibayar" : "Tidak ada tagihan tertunda";
    },
    dueLabel() {
      return this.data?.billing?.dueDate ? `Jatuh tempo ${this.date(this.data.billing.dueDate)}` : "Jatuh tempo belum dijadwalkan";
    },
    maskedPassword() {
      const length = Math.max(5, String(this.data?.hotspot?.password || "").length);
      return "•".repeat(length);
    },

    async copyText(value, key) {
      if (!value) return;
      try {
        await navigator.clipboard.writeText(String(value));
        this.copied = key;
        window.setTimeout(() => { if (this.copied === key) this.copied = ""; }, 1500);
      } catch (_) {
        this.copied = "";
      }
    },
  };
}
