process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://fervor:fervor@localhost:5432/fervor_test';
process.env.DB_COLOCATED = process.env.CORE_DATABASE_URL && process.env.MARKET_DATABASE_URL
    ? 'false'
    : 'true';
process.env.JWT_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.FRONTEND_URL = 'http://localhost:3002';
process.env.ENABLE_TELEGRAM_NOTIFICATIONS = 'false';
process.env.ENABLE_DISCORD_NOTIFICATIONS = 'false';
process.env.MARKET_DATA_REQUIRED = 'false';
process.env.JUPITER_API_KEY = 'test-jupiter-api-key';
