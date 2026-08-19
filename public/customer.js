function customerPortalApp() {
  return {
    data: null,
    loading: true,
    loggingOut: false,
    error: "",
    showHotspotPassword: false,
    copied: "",

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
