/** Install a native capture policy before Aladin's canvas consumes wheel events.
 *
 * Plain wheel/touchpad gestures do not reach Aladin's zoom listener and are not
 * cancelled. The fixed-viewport app shell has no document scrolling to receive
 * them. Ctrl/Meta wheel reaches the native map listener. No document/window
 * listeners or synthetic replay are used.
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
