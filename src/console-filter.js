const FILTER_INSTALLED = Symbol("reminderBotConsoleFilterInstalled");

function installLibsignalConsoleFilter(target = console, now = () => new Date()) {
  if (!target || target[FILTER_INSTALLED]) return false;

  const originalInfo = target.info.bind(target);
  const originalWarn = target.warn.bind(target);
  const originalError = target.error.bind(target);
  let lastBadMacWarningAt = 0;

  target.info = (...args) => {
    // libsignal otherwise dumps the complete SessionEntry, including key buffers.
    if (args[0] === "Closing session:") return;
    originalInfo(...args);
  };

  target.warn = (...args) => {
    if (args[0] === "Closing open session in favor of incoming prekey bundle") return;
    originalWarn(...args);
  };

  target.error = (...args) => {
    const message = String(args[0] || "");
    if (message === "Failed to decrypt message with any known session...") return;
    if (message.startsWith("Session error:") && message.includes("Bad MAC")) {
      const warningAt = now();
      if (warningAt.getTime() - lastBadMacWarningAt >= 60_000) {
        lastBadMacWarningAt = warningAt.getTime();
        originalWarn(
          `[${warningAt.toISOString()}] [warn] [baileys-signal] Bad MAC; sesi pesan akan disinkronkan ulang`
        );
      }
      return;
    }
    originalError(...args);
  };

  Object.defineProperty(target, FILTER_INSTALLED, { value: true });
  return true;
}

module.exports = { installLibsignalConsoleFilter };
