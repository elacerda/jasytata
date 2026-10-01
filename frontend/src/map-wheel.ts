/** Install a native capture policy before Aladin's canvas consumes wheel events.
 *
 * Plain wheel/touchpad gestures keep their default browser scrolling and never
 * reach Aladin's preventDefault/zoom accumulator. Ctrl/Meta wheel reaches the
 * native map listener. No document/window listeners or synthetic replay are used.
 *
 * @param container - Ancestor of the native Aladin canvases.
 * @returns Cleanup that removes this listener when the map unmounts.
 */
export function installMapWheelPolicy(container: HTMLElement): () => void {
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) event.stopPropagation();
  };
  container.addEventListener("wheel", onWheel, { capture: true, passive: true });
  return () => container.removeEventListener("wheel", onWheel, { capture: true });
}
