export function createLoginThrottle(capacity = 4096) {
  const windows = new Map();
  function reserve(address, now = performance.now()) {
    // Fixed windows expire in insertion order. A busy address cannot extend its window.
    for (const [key, record] of windows) {
      if (record.until > now) break;
      windows.delete(key);
    }
    let record = windows.get(address);
    if (!record) {
      if (windows.size >= capacity) {
        const oldest = windows.values().next().value;
        return Math.ceil((oldest.until - now) / 1000);
      }
      record = {count:0, until:now + 600000};
      windows.set(address, record);
    }
    if (record.count >= 6) return Math.ceil((record.until - now) / 1000);
    record.count++;
    return 0;
  }
  return {reserve, clear:address => windows.delete(address)};
}
