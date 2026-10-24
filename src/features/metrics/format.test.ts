// Shares in percent (#276): rounded, but a share above 0 and below 1 % reads "<1%", never "1%" or "0%".
import { describe, expect, it } from "vitest";
import { i18n } from "../../i18n";
import { isBelowOnePercent, percentKey, percentOf, shareOf } from "./format";

describe("shares in percent", () => {
  it("round to a whole percent, keep a share below 1 % as it is, and give 0 only for nothing", () => {
    expect(shareOf(5, 1000)).toBe(0.5);
    expect(shareOf(0, 1000)).toBe(0);
    expect(shareOf(10, 1000)).toBe(1);
    expect(shareOf(126, 1000)).toBe(13);
    // Usage over its request is not capped; a percent of a whole is.
    expect(shareOf(1500, 1000)).toBe(150);
    expect(percentOf(1500, 1000)).toBe(100);
    expect(percentOf(1, 1000)).toBe(0.1);
    expect(percentOf(1, 0)).toBeUndefined();
    expect(percentOf(1, undefined)).toBeUndefined();
  });

  it("are told as <1% below 1 %, in every place that names one", () => {
    expect(isBelowOnePercent(0.5)).toBe(true);
    expect(isBelowOnePercent(0)).toBe(false);
    expect(isBelowOnePercent(1)).toBe(false);
    expect(isBelowOnePercent(undefined)).toBe(false);
    const t = (key: string, percent: number) => i18n.t(percentKey(key, percent), { value: percent, text: "5m / 1" });
    expect(t("metrics:percent", 0.5)).toBe("<1%");
    expect(t("metrics:percent", 0)).toBe("0%");
    expect(t("metrics:percentOf", 0.5)).toBe("<1% · 5m / 1");
    expect(t("metrics:requests.shareOfLimit", 0.2)).toBe("<1% of limit");
    expect(t("metrics:requests.shareOfRequest", 12)).toBe("12% of request");
    expect(i18n.t(percentKey("kueue:quota.ofQuota", 0.3), { value: "10m", percent: 0.3 })).toBe("10m (<1%)");
  });
});
