import { describe, expect, it } from "vitest";

import { JimengClient } from "../../src/http/jimeng-client.js";

describe("JimengClient", () => {
  it("normalizes credit balances from the commerce response", async () => {
    const runtime = {
      config: {
        baseUrl: "https://jimeng.jianying.com",
      },
      getCookieValue: async () => undefined,
      requestJson: async () => ({
        ret: "0",
        data: {
          credit: {
            gift_credit: 10,
            purchase_credit: 20,
            vip_credit: 30,
          },
        },
      }),
    };

    const client = new JimengClient(runtime as never);
    await expect(client.getCreditBalance()).resolves.toEqual({
      giftCredit: 10,
      purchaseCredit: 20,
      vipCredit: 30,
      totalCredit: 60,
    });
  });
});
