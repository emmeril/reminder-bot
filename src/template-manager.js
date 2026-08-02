const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { CONFIG } = require("./config");
const { sanitizeInput, sanitizeMultilineText } = require("./utils");

class TemplateManager {
  constructor(activityLog) {
    this.activityLog = activityLog;
  }

  sanitizeFileName(name) {
    const clean = sanitizeInput(name).replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-");
    if (!clean) {
      throw new Error("Nama template wajib diisi.");
    }
    return clean.endsWith(".txt") ? clean : `${clean}.txt`;
  }

  getTemplatePath(name) {
    return path.join(CONFIG.TEMPLATE_PATH, this.sanitizeFileName(name));
  }

  async listTemplates() {
    const files = await fs.readdir(CONFIG.TEMPLATE_PATH, { withFileTypes: true }).catch(() => []);
    const templates = [];

    for (const entry of files.filter((item) => item.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = entry.name;
      const fullPath = path.join(CONFIG.TEMPLATE_PATH, file);
      try {
        const content = await fs.readFile(fullPath, "utf-8");
        templates.push({
          name: file,
          content,
          updatedAt: (await fs.stat(fullPath)).mtime.toISOString(),
        });
      } catch (error) {
        this.activityLog.push("error", "templates", `Failed to load template ${file}`, { error: error.message });
      }
    }

    return templates;
  }

  async createTemplate(name, content) {
    const fileName = this.sanitizeFileName(name);
    const templatePath = path.join(CONFIG.TEMPLATE_PATH, fileName);

    const safeContent = sanitizeMultilineText(content);
    try {
      await fs.writeFile(templatePath, safeContent, { flag: "wx" });
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error("Template dengan nama tersebut sudah ada.");
      }
      throw error;
    }
    return { name: fileName, content: safeContent };
  }

  async updateTemplate(name, content) {
    const templatePath = this.getTemplatePath(name);
    if (!fsSync.existsSync(templatePath)) {
      throw new Error("Template tidak ditemukan.");
    }

    const safeContent = sanitizeMultilineText(content);
    await fs.writeFile(templatePath, safeContent);
    return { name: path.basename(templatePath), content: safeContent };
  }

  async deleteTemplate(name) {
    const templatePath = this.getTemplatePath(name);
    if (!fsSync.existsSync(templatePath)) {
      throw new Error("Template tidak ditemukan.");
    }
    await fs.unlink(templatePath);
    return path.basename(templatePath);
  }

  applyTemplate(template, variables) {
    let message = String(template || "");
    for (const [key, value] of Object.entries(variables)) {
      const safeValue = typeof value === "string" ? value.replace(/[*_`~]/g, "\\$&") : String(value);
      message = message.replace(new RegExp(`{{${key}}}`, "gi"), safeValue);
    }
    return message;
  }
}

module.exports = TemplateManager;
