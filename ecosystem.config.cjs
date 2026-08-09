module.exports = {
  apps: [
    {
      name: "reminder-bot",
      script: "index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "300M",
      restart_delay: 5000,
      node_args: "--max-old-space-size=256",
      env: { NODE_ENV: "production" },
    },
    {
      name: "whatsapp-bridge",
      script: "bridge/whatsapp-bridge.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "160M",
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
        ANDROID_BRIDGE_MANAGE_APPIUM: "true",
        ANDROID_AUTO_START_WHATSAPP: "true",
      },
    },
  ],
};
