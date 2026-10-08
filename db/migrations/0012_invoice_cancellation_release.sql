-- 0012_invoice_cancellation_release: database integrity for the cancellation / release / re-invoice lifecycle (Phase 7E).
-- The workflow itself (lock order, payment prerequisite, release, events, audit) is the transaction service cancelInvoice();
-- these triggers only make inconsistent states impossible through any other path. No drops, no row rewrites.
--
--   1. Cancelling an invoice is an internal-staff act (verified actor, role from the database): customers, service actors and
--      unknown actors are refused (MV012). The full permission matrix is Phase 7F.
--   2. At COMMIT a newly cancelled invoice must no longer own any item or carton (deferred check, MV005).
--   3. Nothing can be attached to a Cancelled invoice (item.invoice_id, carton -> invoiced), except by the import actor.
--   4. An item cannot be attached to a dissolved carton, and a carton with member items cannot be dissolved.

-- ============================== 1. who may cancel ====================================================================
CREATE OR REPLACE FUNCTION invoices_actor_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_actor uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_actor := movezz_sec.require_actor();
    IF NEW.created_by IS NOT NULL AND NEW.created_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'created_by does not match the verified actor' USING ERRCODE = 'MV007';
    END IF;
    NEW.created_by := v_actor;
  ELSIF OLD.status <> 'Cancelled' AND NEW.status = 'Cancelled' THEN
    v_actor := movezz_sec.require_actor();
    IF movezz_sec.actor_role() IS NULL OR movezz_sec.actor_role() NOT IN ('super_admin', 'warehouse_staff') THEN
      RAISE EXCEPTION 'Only Movezz staff may cancel an invoice' USING ERRCODE = 'MV012';
    END IF;
    IF NEW.cancelled_by IS NOT NULL AND NEW.cancelled_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'cancelled_by does not match the verified actor' USING ERRCODE = 'MV007';
    END IF;
    NEW.cancelled_by := v_actor;
  END IF;
  RETURN NEW;
END $$;

-- ============================== 2. a cancelled invoice owns nothing at commit =========================================
CREATE FUNCTION invoices_cancel_release_check() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM items WHERE invoice_id = NEW.id)
     OR EXISTS (SELECT 1 FROM cartons WHERE invoice_id = NEW.id) THEN
    RAISE EXCEPTION 'Invoice % was cancelled but still holds items or cartons; release them in the same transaction', NEW.invoice_ref
      USING ERRCODE = 'MV005';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER invoices_cancel_release_check AFTER UPDATE OF status ON invoices
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'Cancelled' AND OLD.status IS DISTINCT FROM 'Cancelled')
  EXECUTE FUNCTION invoices_cancel_release_check();
REVOKE ALL ON FUNCTION invoices_cancel_release_check() FROM PUBLIC;

-- ============================== 3/4. link guards =====================================================================
CREATE FUNCTION items_link_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_status text; v_cstatus text;
BEGIN
  IF movezz_sec.current_actor_type() IS NOT DISTINCT FROM 'import' THEN RETURN NEW; END IF;   -- historical links come from the legacy system
  IF NEW.invoice_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id) THEN
    SELECT status INTO v_status FROM invoices WHERE id = NEW.invoice_id;
    IF v_status = 'Cancelled' THEN
      RAISE EXCEPTION 'Item % cannot be attached to a cancelled invoice', NEW.item_ref USING ERRCODE = 'MV005';
    END IF;
  END IF;
  IF NEW.carton_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.carton_id IS DISTINCT FROM OLD.carton_id) THEN
    SELECT status INTO v_cstatus FROM cartons WHERE id = NEW.carton_id;
    IF v_cstatus = 'dissolved' THEN
      RAISE EXCEPTION 'Item % cannot be put into a dissolved carton', NEW.item_ref USING ERRCODE = 'MV005';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER items_link_guard BEFORE INSERT OR UPDATE OF invoice_id, carton_id ON items FOR EACH ROW EXECUTE FUNCTION items_link_guard();
REVOKE ALL ON FUNCTION items_link_guard() FROM PUBLIC;

CREATE FUNCTION cartons_link_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_status text;
BEGIN
  IF NEW.status = 'invoiced' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'invoiced')
     AND movezz_sec.current_actor_type() IS DISTINCT FROM 'import' THEN
    SELECT status INTO v_status FROM invoices WHERE id = NEW.invoice_id;
    IF v_status = 'Cancelled' THEN
      RAISE EXCEPTION 'Carton % cannot be attached to a cancelled invoice', NEW.carton_ref USING ERRCODE = 'MV005';
    END IF;
  END IF;
  IF NEW.status = 'dissolved' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'dissolved')
     AND EXISTS (SELECT 1 FROM items WHERE carton_id = NEW.id) THEN
    RAISE EXCEPTION 'Carton % still has member items; take them out before dissolving it', NEW.carton_ref USING ERRCODE = 'MV005';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cartons_link_guard BEFORE INSERT OR UPDATE OF status, invoice_id ON cartons FOR EACH ROW EXECUTE FUNCTION cartons_link_guard();
REVOKE ALL ON FUNCTION cartons_link_guard() FROM PUBLIC;
