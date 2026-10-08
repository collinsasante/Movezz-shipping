-- STAGING HARNESS ONLY (fictional data). Run as the database owner after migrations.
INSERT INTO fx_rates (base_currency, quote_currency, rate, source, effective_at) VALUES ('USD','GHS',12.5,'harness', now() - interval '1 hour');
INSERT INTO package_rates (tier, freight_type, rate_usd) VALUES ('basic','sea',350),('basic','air',8),('business','sea',280),('business','air',6),('enterprise','sea',450),('enterprise','air',12),('special','sea',500),('special','air',15);
INSERT INTO warehouses (name, address, country) VALUES ('Guangzhou Transit', 'Baiyun District', 'CN');
INSERT INTO customers (name, phone, email, shipping_mark, shipping_address, package_tier) VALUES
  ('Ama Owusu', '+233244000111', 'ama@example.invalid', 'MOVEZZ-AO0111', 'MOVEZZ-AO0111, A-Z Bulk Warehouse', 'basic'),
  ('Kojo Mensah', '+233244000222', 'kojo@example.invalid', 'MOVEZZ-KM0222', 'MOVEZZ-KM0222, A-Z Bulk Warehouse', 'basic');
INSERT INTO users (auth_uid, email, role) VALUES ('uid-admin', 'admin@example.invalid', 'super_admin'), ('uid-staff', 'staff@example.invalid', 'warehouse_staff');
INSERT INTO users (auth_uid, email, role, customer_id) SELECT 'uid-ama', 'ama@example.invalid', 'customer', id FROM customers WHERE shipping_mark = 'MOVEZZ-AO0111';
INSERT INTO users (auth_uid, email, role, customer_id) SELECT 'uid-kojo', 'kojo@example.invalid', 'customer', id FROM customers WHERE shipping_mark = 'MOVEZZ-KM0222';
-- the harness key (scripts/ui-staging/start.sh) must be registered once:  SELECT movezz_sec.set_actor_key(decode('<hex of the 32-byte key>','hex'));
