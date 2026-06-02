function loginApp() {
  return {
    form: {
      username: "",
      password: "",
    },
    error: "",
    submitting: false,

    async api(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
      });

      const contentType = response.headers.get("content-type") || "";
      const payload = contentType.includes("application/json")
        ? await response.json()
        : { success: false, error: await response.text() || "Request failed" };
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || `Request failed (${response.status})`);
      }

      return payload.data;
    },

    async submit() {
      this.error = "";
      this.submitting = true;
      try {
        await this.api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify(this.form),
        });
        window.location.href = "/dashboard";
      } catch (error) {
        this.error = error.message;
      } finally {
        this.submitting = false;
      }
    },
  };
}
