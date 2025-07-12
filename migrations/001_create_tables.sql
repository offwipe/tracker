-- Whitelisted channels table
CREATE TABLE IF NOT EXISTS whitelisted_channels (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);

-- Tracked items table
CREATE TABLE IF NOT EXISTS tracked_items (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  last_ad_id TEXT,
  PRIMARY KEY (guild_id, channel_id, user_id, item_id)
); 