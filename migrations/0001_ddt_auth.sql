-- [2026-11-25] Přihlašování přístupovými klíči (WebAuthn) – databáze Cloudflare D1 pro API functions/api/auth/.
-- Migraci spustí: npx wrangler d1 migrations apply DB --local (lokálně) / --remote (Cloudflare, dělá to i workflow).
-- Soubor pochází ze šablony domdocument-template (static-export/repository/migrations/). Hotovou migraci neměnit –
-- změna schématu = nový soubor 0002_….sql (wrangler si v tabulce d1_migrations pamatuje, které už proběhly).
-- Časy jsou unixové v sekundách.

CREATE TABLE users (
	id TEXT PRIMARY KEY,                -- user handle WebAuthn (32 náhodných bajtů v base64url), neprozrazuje nic o uživateli
	display_name TEXT NOT NULL,         -- jméno zvolené při registraci, uživatel ho mění v profilu
	created_at INTEGER NOT NULL
);

CREATE TABLE credentials (
	id TEXT PRIMARY KEY,                -- ID přístupového klíče (base64url)
	user_id TEXT NOT NULL REFERENCES users ( id ) ON DELETE CASCADE,
	public_key TEXT NOT NULL,           -- veřejný klíč jako JWK (JSON)
	algorithm INTEGER NOT NULL,         -- COSE: -8 EdDSA, -7 ES256, -257 RS256
	sign_count INTEGER NOT NULL DEFAULT 0,
	transports TEXT NOT NULL DEFAULT '[]', -- JSON pole (internal, hybrid, usb…) – nápověda prohlížeči při přidávání dalšího klíče
	backup_eligible INTEGER NOT NULL DEFAULT 0, -- 1 = synchronizovaný klíč (správce hesel, iCloud, Google…)
	backed_up INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER
);
CREATE INDEX credentials_user_id ON credentials ( user_id );

CREATE TABLE challenges (               -- jednorázové výzvy (platí CHALLENGE_TTL), použitím se smažou
	challenge TEXT PRIMARY KEY,         -- base64url, 32 náhodných bajtů
	purpose TEXT NOT NULL,              -- register | login | add-passkey
	user_id TEXT,                       -- register: nový user handle, add-passkey: přihlášený uživatel
	display_name TEXT,                  -- register: zvolené jméno
	expires_at INTEGER NOT NULL
);
CREATE INDEX challenges_expires_at ON challenges ( expires_at );

CREATE TABLE sessions (
	token_hash TEXT PRIMARY KEY,        -- SHA-256 tokenu z cookie (base64url) – únik databáze neprozradí platné cookies
	user_id TEXT NOT NULL REFERENCES users ( id ) ON DELETE CASCADE,
	credential_id TEXT,                 -- klíč, kterým se uživatel přihlásil
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user_id ON sessions ( user_id );
CREATE INDEX sessions_expires_at ON sessions ( expires_at );
