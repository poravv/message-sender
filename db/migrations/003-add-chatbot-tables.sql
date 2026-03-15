-- Migration: Add chatbot tables
-- Run this on existing databases that were created before the chatbot feature.
-- Safe to run multiple times (uses IF NOT EXISTS / IF EXISTS).

-- ========================================
-- CHATBOT CONFIGURATION TABLE
-- ========================================
CREATE TABLE IF NOT EXISTS chatbot_configs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL DEFAULT 'Mi Bot',
  enabled BOOLEAN DEFAULT false,
  -- Smart activation rules
  active_hours_start TIME DEFAULT '08:00',
  active_hours_end TIME DEFAULT '22:00',
  active_days INTEGER[] DEFAULT '{1,2,3,4,5}', -- 1=Mon..7=Sun
  cooldown_minutes INTEGER DEFAULT 30,
  only_known_contacts BOOLEAN DEFAULT true,
  max_responses_per_contact INTEGER DEFAULT 5,
  ai_enabled BOOLEAN DEFAULT false,
  ai_provider VARCHAR(50),
  ai_api_key_encrypted TEXT,
  ai_model VARCHAR(100),
  ai_system_prompt TEXT,
  welcome_message TEXT,
  fallback_message TEXT DEFAULT 'No entendí tu mensaje. Escribí "menu" para ver las opciones.',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chatbot_configs_user ON chatbot_configs(user_id);

-- ========================================
-- CHATBOT FLOW NODES TABLE
-- ========================================
CREATE TABLE IF NOT EXISTS chatbot_nodes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  config_id UUID NOT NULL REFERENCES chatbot_configs(id) ON DELETE CASCADE,
  node_id VARCHAR(100) NOT NULL,
  type VARCHAR(50) NOT NULL,
  content JSONB NOT NULL DEFAULT '{}',
  position_x INTEGER DEFAULT 0,
  position_y INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chatbot_nodes_config ON chatbot_nodes(config_id);
CREATE INDEX IF NOT EXISTS idx_chatbot_nodes_node_id ON chatbot_nodes(config_id, node_id);

-- ========================================
-- CHATBOT CONVERSATION STATE TABLE
-- ========================================
CREATE TABLE IF NOT EXISTS chatbot_conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  contact_phone VARCHAR(20) NOT NULL,
  current_node_id VARCHAR(100),
  context JSONB DEFAULT '{}',
  responses_today INTEGER DEFAULT 0,
  last_response_at TIMESTAMPTZ,
  last_human_intervention_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, contact_phone)
);

CREATE INDEX IF NOT EXISTS idx_chatbot_conv_user ON chatbot_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_chatbot_conv_user_phone ON chatbot_conversations(user_id, contact_phone);

-- ========================================
-- INCOMING MESSAGES LOG TABLE
-- ========================================
CREATE TABLE IF NOT EXISTS incoming_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  contact_phone VARCHAR(20) NOT NULL,
  contact_name VARCHAR(255),
  message_text TEXT,
  message_type VARCHAR(50) DEFAULT 'text',
  media_url TEXT,
  is_from_contact BOOLEAN DEFAULT true,
  is_bot_reply BOOLEAN DEFAULT false,
  read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incoming_user_phone ON incoming_messages(user_id, contact_phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incoming_user_date ON incoming_messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_incoming_unread ON incoming_messages(user_id, read, created_at DESC);

-- ========================================
-- TRIGGERS
-- ========================================
DROP TRIGGER IF EXISTS update_chatbot_configs_updated_at ON chatbot_configs;
CREATE TRIGGER update_chatbot_configs_updated_at
  BEFORE UPDATE ON chatbot_configs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_chatbot_conversations_updated_at ON chatbot_conversations;
CREATE TRIGGER update_chatbot_conversations_updated_at
  BEFORE UPDATE ON chatbot_conversations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
