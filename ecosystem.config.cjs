module.exports = {
  apps: [
    {
      name: "billing",
      script: "index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "300M",
      restart_delay: 5000,
      exp_backoff_restart_delay: 100,
      kill_timeout: 30000,
      listen_timeout: 60000,
      node_args: "--max-old-space-size=256",
      env: { NODE_ENV: "production" },
    },
  ],
};
