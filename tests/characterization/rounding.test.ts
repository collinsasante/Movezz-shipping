// Where does money rounding happen today? (per item / per line / at the invoice total / at display time)
//   * item price: browser, not rounded until the form submits (toFixed(2) in the form)           - see pricing.test.ts
//   * invoice total (browser): ONCE, on the sum of item prices                                    - see pricing.test.ts
//   * carton: total rounded to 2dp, then split per item (last item takes the remainder)           - below
//   * USD -> GHS: amount x rate rounded to 2dp, then split per line (last line takes remainder)   - below
//   * POST /api/orders Keepup lines: amount / n rounded per line, NO remainder handling           - see invoices.test.ts
//   * display: Intl.NumberFormat 2 decimals                                                      - see utils.test.ts
import { describe, it, expect, vi } from "vitest";
import { freshWorld, standardWorld } from "../helpers/world";
import { PRESERVE } from "../helpers/known";

describe(PRESERVE("carton price split: member prices always add back to the carton total"), () => {
  const cases: { n: number; sea: number }[] = [];
  for (let n = 1; n <= 9; n++) for (const sea of [100, 333.33, 350, 1234.5678]) cases.push({ n, sea });

  for (const { n, sea } of cases) {
    it(`${n} member(s) at ${sea}/m3`, async () => {
      const w = await freshWorld();
      w.seed.customer("recCustA");
      w.seed.packageRate("basic", sea, 8);
      const ids = Array.from({ length: n }, (_, i) => `recI${i}`);
      ids.forEach((id) => w.seed.item(id, "recCustA"));
      const res = await w.airtable.cartonsApi.create({ customerId: "recCustA", itemIds: ids, length: 37, width: 29, height: 11, dimensionUnit: "cm" });
      const shares = ids.map((id) => w.db.get("Items", id)?.fields["PkgEstShipping"] as number);
      const total = Math.round(shares.reduce((a, b) => a + b, 0) * 100) / 100;
      expect(total).toBe(res.totalPrice);
      // the first n-1 shares are equal; only the last one absorbs the remainder
      expect(new Set(shares.slice(0, Math.max(0, n - 1))).size).toBeLessThanOrEqual(1);
      // rounding happened before splitting: the total itself has at most 2 decimals
      expect(Math.round(res.totalPrice * 100) / 100).toBe(res.totalPrice);
    });
  }
});

describe(PRESERVE("USD -> GHS invoice allocation: line prices always add back to round(amount x rate)"), () => {
  const amounts = [0.01, 1, 33.33, 99.99, 100, 187.77, 1234.56];
  const rates = [1, 10.5, 12.3456, 15.99];
  const counts = [1, 2, 3, 7];
  for (const amount of amounts) {
    for (const rate of rates) {
      it(`amount ${amount} USD at ${rate} over ${counts.join("/")} lines`, async () => {
        for (const n of counts) {
          const { w, admin } = await standardWorld();
          w.seed.settings(rate);
          const ids = Array.from({ length: n }, (_, i) => `recI${i}`);
          ids.forEach((id) => w.seed.item(id, "recCustA"));
          w.seed.order("recOrd1", "recCustA", { InvoiceAmount: amount, Items: ids });
          await w.call("orders/[id]/create-invoice", "POST", { token: admin, params: { id: "recOrd1" }, body: {} });
          const lines = vi.mocked(w.keepup.createKeepupSale).mock.calls[0][0].items as { price: number }[];
          const sum = Math.round(lines.reduce((a, l) => a + l.price, 0) * 100) / 100;
          expect(sum, `n=${n}`).toBe(Math.round(amount * rate * 100) / 100);
          lines.forEach((l) => expect(Math.round(l.price * 100) / 100).toBe(l.price)); // every line has at most 2 decimals
        }
      });
    }
  }
});
