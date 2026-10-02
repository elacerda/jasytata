import { describe, expect, it, vi } from "vitest";
import { installMapWheelPolicy } from "./map-wheel";

describe("native map wheel capture policy", () => {
  it("does not zoom or cancel a plain wheel event over the map", () => {
    const container = document.createElement("div"); const canvas = document.createElement("canvas");
    container.append(canvas);
    const native = vi.fn((event: WheelEvent) => event.preventDefault());
    canvas.addEventListener("wheel", native);
    const remove = installMapWheelPolicy(container);
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120 });
    expect(canvas.dispatchEvent(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(native).not.toHaveBeenCalled();
    remove();
    canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true }));
    expect(native).toHaveBeenCalledOnce();
  });
  it.each(["ctrlKey", "metaKey"])("lets %s wheel reach the native zoom listener", (modifier) => {
    const container = document.createElement("div"); const canvas = document.createElement("canvas");
    container.append(canvas); const native = vi.fn((event: WheelEvent) => event.preventDefault());
    canvas.addEventListener("wheel", native); const remove = installMapWheelPolicy(container);
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -30, [modifier]: true });
    expect(canvas.dispatchEvent(event)).toBe(false);
    expect(native).toHaveBeenCalledOnce(); remove();
  });
  it("leaves click and pointer pan events available", () => {
    const container = document.createElement("div"); const canvas = document.createElement("canvas");
    container.append(canvas); const click = vi.fn(); const pan = vi.fn();
    canvas.addEventListener("click", click); canvas.addEventListener("pointerdown", pan);
    const remove = installMapWheelPolicy(container);
    canvas.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    canvas.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(click).toHaveBeenCalledOnce(); expect(pan).toHaveBeenCalledOnce(); remove();
  });
});
