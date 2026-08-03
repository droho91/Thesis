const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown"]);
const PREVIOUS_KEYS = new Set(["ArrowLeft", "ArrowUp"]);

export function nextTabIndex(key, currentIndex, itemCount) {
  if (!Number.isSafeInteger(itemCount) || itemCount < 1) {
    throw new RangeError("Tab item count must be a positive safe integer");
  }
  if (!Number.isSafeInteger(currentIndex) || currentIndex < 0 || currentIndex >= itemCount) {
    throw new RangeError("Current tab index must identify an item in the tab list");
  }
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  if (NEXT_KEYS.has(key)) return (currentIndex + 1) % itemCount;
  if (PREVIOUS_KEYS.has(key)) return (currentIndex - 1 + itemCount) % itemCount;
  return null;
}
