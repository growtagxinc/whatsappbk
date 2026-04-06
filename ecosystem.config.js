module.exports = {
  apps: [{
    name: 'whatsapp-engine',
    script: 'server.js',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '800M',
    kill_timeout: 5000,
    listen_timeout: 10000,
    env: {
      NODE_ENV: 'production',
      PORT: 80,
      MONGODB_URI: 'mongodb://127.0.0.1:27017/brandpro'
    }
  }]
};
