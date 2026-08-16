CREATE TABLE IF NOT EXISTS purchases (
    id SERIAL PRIMARY KEY,
    purchase_token TEXT UNIQUE NOT NULL,
    product_id TEXT NOT NULL,
    package_name TEXT NOT NULL,
    product_type TEXT NOT NULL,
    status TEXT NOT NULL,
    raw_response JSONB,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
