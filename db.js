const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  async setTrackingStartTime(guildId, channelId, userId, itemId, startTime) {
    await pool.query(
      'UPDATE tracked_items SET tracking_started_at = $1 WHERE guild_id = $2 AND channel_id = $3 AND user_id = $4 AND item_id = $5',
      [startTime, guildId, channelId, userId, itemId]
    );
  },
  async getTrackingStartTime(guildId, channelId, userId, itemId) {
    const { rows } = await pool.query(
      'SELECT tracking_started_at FROM tracked_items WHERE guild_id = $1 AND channel_id = $2 AND user_id = $3 AND item_id = $4',
      [guildId, channelId, userId, itemId]
    );
    return rows[0]?.tracking_started_at;
  }
}; 