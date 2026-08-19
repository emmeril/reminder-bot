function customerLoginApp() {
  return {
    form: { username: "", password: "" },
    error: "",
    submitting: false,
    showPassword: false,

    async submit() {
      this.error = "";
      this.submitting = true;
      try {
        const response = await fetch("/api/pelanggan/auth/login", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(this.form),
        });
        const payload = await response.json();
        if (!response.ok || !payload.success) {
          throw new Error(payload.error || "Login gagal.");
        }
        window.location.href = "/pelanggan";
      } catch (error) {
        this.error = error.message || "Login gagal. Silakan coba lagi.";
      } finally {
        this.submitting = false;
      }
    },
  };
}
