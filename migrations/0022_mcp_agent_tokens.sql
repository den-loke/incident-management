-- MCP agent credentials. Store only a SHA-256 digest; plaintext is returned once
-- at creation and cannot be recovered. Revocation is immediate.
CREATE TABLE IF NOT EXISTS mcp_agent_tokens (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_agent_tokens_active ON mcp_agent_tokens (token_hash) WHERE revoked_at IS NULL;
