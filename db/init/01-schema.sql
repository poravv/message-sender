-- WhatsApp Message Sender Database Schema
-- Version: 1.0.0

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ========================================
-- CONTACTS TABLE
-- ========================================
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NOT NULL,
  nombre VARCHAR(255),
  sustantivo VARCHAR(50),
  grupo VARCHAR(100),
  source VARCHAR(50) DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
CREATE INDEX IF NOT EXISTS idx_contacts_grupo ON contacts(grupo);
CREATE INDEX IF NOT EXISTS idx_contacts_user_grupo ON contacts(user_id, grupo);

-- ========================================
-- CAMPAIGNS TABLE
-- ========================================
CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(50) DEFAULT 'queued',
  message_type VARCHAR(50) DEFAULT 'text',
  template_count INTEGER DEFAULT 1,
  total_recipients INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_campaigns_user_id ON campaigns(user_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_created_at ON campaigns(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaigns_user_created ON campaigns(user_id, created_at DESC);

-- ========================================
-- CAMPAIGN RECIPIENTS TABLE
-- ========================================
CREATE TABLE IF NOT EXISTS campaign_recipients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  phone VARCHAR(50) NOT NULL,
  nombre VARCHAR(255),
  sustantivo VARCHAR(50),
  grupo VARCHAR(100),
  status VARCHAR(50) DEFAULT 'queued',
  template_index INTEGER,
  attempts INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  error_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_recipients_campaign_id ON campaign_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_recipients_status ON campaign_recipients(status);
CREATE INDEX IF NOT EXISTS idx_recipients_phone ON campaign_recipients(phone);

-- ========================================
-- METRIC EVENTS TABLE (for analytics)
-- ========================================
CREATE TABLE IF NOT EXISTS metric_events (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
  phone VARCHAR(50),
  contact_id UUID,
  grupo VARCHAR(100),
  error_message TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_user_id ON metric_events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON metric_events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON metric_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_user_date ON metric_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_campaign ON metric_events(campaign_id);

-- ========================================
-- MONTHLY STATS AGGREGATION TABLE
-- ========================================
CREATE TABLE IF NOT EXISTS monthly_stats (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  month VARCHAR(7) NOT NULL, -- YYYY-MM format
  sent_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  campaign_count INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, month)
);

CREATE INDEX IF NOT EXISTS idx_monthly_user ON monthly_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_monthly_month ON monthly_stats(month);

-- ========================================
-- CONTACT STATS TABLE
-- ========================================
CREATE TABLE IF NOT EXISTS contact_stats (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NOT NULL,
  contact_id UUID,
  nombre VARCHAR(255),
  grupo VARCHAR(100),
  sent_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  last_activity_at TIMESTAMPTZ,
  UNIQUE(user_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_contact_stats_user ON contact_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_contact_stats_phone ON contact_stats(phone);

-- ========================================
-- TRIGGERS FOR AUTO-UPDATE
-- ========================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Contacts trigger
DROP TRIGGER IF EXISTS update_contacts_updated_at ON contacts;
CREATE TRIGGER update_contacts_updated_at
  BEFORE UPDATE ON contacts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Campaigns trigger
DROP TRIGGER IF EXISTS update_campaigns_updated_at ON campaigns;
CREATE TRIGGER update_campaigns_updated_at
  BEFORE UPDATE ON campaigns
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Recipients trigger
DROP TRIGGER IF EXISTS update_recipients_updated_at ON campaign_recipients;
CREATE TRIGGER update_recipients_updated_at
  BEFORE UPDATE ON campaign_recipients
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ========================================
-- HELPER VIEWS
-- ========================================

-- Dashboard summary view
CREATE OR REPLACE VIEW v_user_summary AS
SELECT 
  user_id,
  COUNT(DISTINCT id) as total_campaigns,
  SUM(sent_count) as total_sent,
  SUM(error_count) as total_errors,
  MAX(created_at) as last_campaign_at
FROM campaigns
GROUP BY user_id;

-- Monthly activity view
CREATE OR REPLACE VIEW v_monthly_activity AS
SELECT 
  user_id,
  TO_CHAR(created_at, 'YYYY-MM') as month,
  COUNT(*) as campaigns,
  SUM(sent_count) as sent,
  SUM(error_count) as errors
FROM campaigns
GROUP BY user_id, TO_CHAR(created_at, 'YYYY-MM')
ORDER BY month DESC;

-- Grant permissions (el owner ya tiene todos los permisos)
-- Si necesitas un rol específico, créalo manualmente
