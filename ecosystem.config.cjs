module.exports = {
  apps: [
    {
      name: 'order-system',
      script: 'server.mjs',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '8787',
        ADMIN_USER: 'admin',
        ADMIN_PASSWORD: 'jkdnanmdsk23829',
        DEFAULT_CARRIER: '其他',
      },
    },
  ],
};

