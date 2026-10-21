-- Knowledge parse version (cycle-7 ST4). A change to vault frontmatter parsing
-- or sync semantics only reaches the files a later sync re-reads, so rows
-- indexed under the old rules keep their old classification until ONE full
-- reindex re-files them (F132 was such a change). A successful FULL vault
-- sync now records the parser version it ran (VAULT_PARSE_VERSION in
-- services/vault-sync.js); Perfin's operator checks compare the two and ask
-- for a full reindex while the stored one is older. NULL = never stamped.
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS vault_parse_version INT;
