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
-- Items expected by ui-run.mjs (flow, flow2): three priced boxes for Ama (invoiced by `flow`), one for Kojo (cancelled by `flow`),
-- and a fifth Ama box that stays un-invoiced for `flow2`. All priced from the seeded package rates (basic sea, 100x100x100 cm = 1 CBM = USD 350).
INSERT INTO items (item_ref, customer_id, description, freight_type, length, width, height, dimension_unit, quantity, package_tier, tier_rate_usd, tier_price_usd)
SELECT v.ref, c.id, v.descr, 'sea', 100, 100, 100, 'cm', 1, 'basic', 350, 350
  FROM (VALUES ('ITM-0001','MOVEZZ-AO0111','Ama box 1'), ('ITM-0002','MOVEZZ-AO0111','Ama box 2'), ('ITM-0003','MOVEZZ-AO0111','Ama box 3'),
               ('ITM-0004','MOVEZZ-KM0222','Kojo box'),  ('ITM-0005','MOVEZZ-AO0111','Ama box 4')) AS v(ref, mark, descr)
  JOIN customers c ON c.shipping_mark = v.mark;
