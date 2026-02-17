/**
 * MetricsStore - Auto-selects PostgreSQL or Redis based on configuration
 * PostgreSQL is used when POSTGRES_HOST is configured (persistent storage)
 * Redis fallback for environments without PostgreSQL
 */

const usePostgres = !!process.env.POSTGRES_HOST;

if (usePostgres) {
  // Use PostgreSQL implementation
  module.exports = require('./metricsStorePostgres');
} else {
  // Fallback to Redis implementation
  module.exports = require('./metricsStoreRedis');
}
