import { describe, expect, it } from "vitest";
import {
  buildLoadTimeRangeOptions,
  buildPingTimeRangeOptions,
  createTimeAxisFormatter,
  getAxisTicks,
  getCountAxisRange,
  getDiskPercentAxisRange,
  getTimeAxisSpace,
} from "@/components/instance/chartShared";

describe("detail chart time ranges", () => {
  it("uses the same 4h, 1d, 3d, 7d and 15d ranges for Ping and load", () => {
    const expected = [
      { label: "4 小时", value: 4 },
      { label: "1 天", value: 24 },
      { label: "3 天", value: 72 },
      { label: "7 天", value: 168 },
      { label: "15 天", value: 360 },
    ];
    expect(buildPingTimeRangeOptions(90 * 24)).toEqual(expected);
    expect(buildLoadTimeRangeOptions(90 * 24)).toEqual(expected);
  });

  it("limits both chart ranges to the history window advertised by the backend", () => {
    const expected = [
      { label: "4 小时", value: 4 },
      { label: "1 天", value: 24 },
      { label: "3 天", value: 72 },
      { label: "7 天", value: 168 },
    ];
    expect(buildPingTimeRangeOptions(10 * 24)).toEqual(expected);
    expect(buildLoadTimeRangeOptions(10 * 24)).toEqual(expected);
  });

  it("uses dated time labels for long windows instead of repeating dates", () => {
    const midnight = new Date(2025, 10, 17, 0, 0).getTime() / 1000;
    const formatter = createTimeAxisFormatter(720);
    expect(formatter({} as never, [midnight, midnight + 6 * 3600, midnight + 12 * 3600])).toEqual([
      "11/17",
      "11/17 06:00",
      "11/17 12:00",
    ]);
  });

  it("increases x-axis spacing for longer chart windows", () => {
    expect(getTimeAxisSpace(1)).toBe(70);
    expect(getTimeAxisSpace(24)).toBe(90);
    expect(getTimeAxisSpace(720)).toBe(110);
  });

  it("keeps small disk percentage changes on a readable, non-zoomed axis", () => {
    expect(getDiskPercentAxisRange(49.41, 49.43)).toEqual([45, 55]);
    expect(getDiskPercentAxisRange(21.2, 23.8)).toEqual([20, 30]);
    expect(getDiskPercentAxisRange(49, 58)).toEqual([45, 60]);
    expect(getDiskPercentAxisRange(0, 0)).toEqual([0, 10]);
    expect(getDiskPercentAxisRange(99.9, 100)).toEqual([90, 100]);
    expect(getDiskPercentAxisRange(NaN, NaN)).toEqual([0, 100]);
  });

  it("gives process and connection counts integer axis bounds", () => {
    expect(getCountAxisRange(72.4, 77.9)).toEqual([72, 78]);
    expect(getCountAxisRange(74, 74)).toEqual([72, 76]);
    expect(getCountAxisRange(0.4, 120.2)).toEqual([0, 121]);
    expect(getCountAxisRange(NaN, NaN)).toEqual([0, 4]);
  });

  it("keeps every y-axis at three or four ticks", () => {
    expect(getAxisTicks(0, 24)).toEqual([0, 10, 20]);
    expect(getAxisTicks(29.2, 33.2)).toEqual([30, 31, 32, 33]);
    expect(getAxisTicks(45, 55)).toEqual([45, 50, 55]);
    expect(getAxisTicks(0, 1_600_000)).toEqual([0, 500_000, 1_000_000, 1_500_000]);
  });

  it("uses integer tick steps for process and connection counts", () => {
    expect(getAxisTicks(72, 78, true)).toEqual([72, 74, 76, 78]);
    expect(getAxisTicks(13, 17, true)).toEqual([13, 14, 15, 16]);
    expect(getAxisTicks(0, 121, true)).toEqual([0, 50, 100]);
    for (const tick of getAxisTicks(3, 87, true)) {
      expect(Number.isInteger(tick)).toBe(true);
    }
  });

});
