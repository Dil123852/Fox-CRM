// Runs before each test file (jest `setupFiles`), so these are in place
// before index.js is required.
//
// JWT_SECRET is load-bearing: index.js refuses to start without it
// (process.exit(1)). Requiring index.js without this set kills the Jest
// worker with no output at all, which is a genuinely confusing failure.
process.env.JWT_SECRET = 'test-jwt-secret-not-a-real-key';

// The dashboard's dev origin, so CORS assertions have a known allowed value
// to test against alongside a disallowed one.
process.env.CORS_ALLOWED_ORIGINS = 'http://localhost:5173';

// Shared secret for POST /api/calls (the Android call-tracker sync).
process.env.CALL_TRACKER_API_KEY = 'test-call-tracker-key';

process.env.DATABASE_URL = 'postgresql://crm:test@localhost:5432/crm_test';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
process.env.WHATSAPP_TOKEN = 'test-whatsapp-token';
process.env.VERIFY_TOKEN = 'test-verify-token';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
