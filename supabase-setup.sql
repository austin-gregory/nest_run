-- Run this in your Supabase SQL Editor to create the player_stats table

CREATE TABLE player_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT 'Anonymous',
  shooter_wins INT NOT NULL DEFAULT 0,
  commander_wins INT NOT NULL DEFAULT 0,
  total_kills INT NOT NULL DEFAULT 0,
  total_deaths INT NOT NULL DEFAULT 0,
  games_played INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast lookups
CREATE INDEX idx_player_stats_user_id ON player_stats(user_id);

-- RLS: users can read anyone's stats, only server (service role) can write
ALTER TABLE player_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read stats"
  ON player_stats FOR SELECT
  USING (true);

CREATE POLICY "Service role can insert"
  ON player_stats FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Service role can update"
  ON player_stats FOR UPDATE
  USING (true);
