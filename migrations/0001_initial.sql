PRAGMA foreign_keys = ON;

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('person_reference', 'turn_reference', 'generation_output')),
  r2_key TEXT UNIQUE,
  mime_type TEXT NOT NULL,
  byte_size INTEGER,
  width INTEGER,
  height INTEGER,
  sha256 TEXT,
  source_asset_id TEXT REFERENCES assets(id),
  deleted_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  handle TEXT NOT NULL UNIQUE,
  color_token TEXT NOT NULL,
  reference_asset_id TEXT NOT NULL REFERENCES assets(id),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  title_status TEXT NOT NULL CHECK (title_status IN ('fallback', 'generating', 'generated', 'failed')),
  forked_from_conversation_id TEXT REFERENCES conversations(id),
  forked_from_turn_id TEXT REFERENCES turns(id),
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  parent_turn_id TEXT REFERENCES turns(id),
  kind TEXT NOT NULL CHECK (kind IN ('generation', 'modification', 'regeneration')),
  authored_prompt TEXT NOT NULL,
  compiled_prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  aspect_ratio TEXT NOT NULL,
  quality TEXT NOT NULL,
  output_format TEXT NOT NULL DEFAULT 'png',
  status TEXT NOT NULL CHECK (status IN ('queued', 'starting', 'processing', 'persisting', 'succeeded', 'failed', 'canceled')),
  replicate_prediction_id TEXT UNIQUE,
  output_asset_id TEXT REFERENCES assets(id),
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE conversation_turn_links (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  turn_id TEXT NOT NULL REFERENCES turns(id),
  position INTEGER NOT NULL,
  is_snapshot INTEGER NOT NULL DEFAULT 0 CHECK (is_snapshot IN (0, 1)),
  is_fork_point INTEGER NOT NULL DEFAULT 0 CHECK (is_fork_point IN (0, 1)),
  PRIMARY KEY (conversation_id, position),
  UNIQUE (conversation_id, turn_id)
);

CREATE TABLE turn_inputs (
  turn_id TEXT NOT NULL REFERENCES turns(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  person_id TEXT REFERENCES people(id),
  role TEXT NOT NULL CHECK (role IN ('edit_base', 'person_reference', 'attached_reference')),
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (turn_id, ordinal)
);

CREATE TABLE generation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE webhook_deliveries (
  webhook_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  received_at TEXT NOT NULL
);

CREATE INDEX idx_people_active_handle ON people(archived_at, handle);
CREATE INDEX idx_conversations_active_created ON conversations(deleted_at, created_at DESC);
CREATE INDEX idx_turns_conversation_created ON turns(conversation_id, created_at);
CREATE INDEX idx_turns_status ON turns(status);
CREATE INDEX idx_assets_kind_created ON assets(kind, created_at DESC);
CREATE INDEX idx_links_turn ON conversation_turn_links(turn_id);
CREATE INDEX idx_events_turn ON generation_events(turn_id, id);
