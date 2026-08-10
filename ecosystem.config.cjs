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
  ],
};
