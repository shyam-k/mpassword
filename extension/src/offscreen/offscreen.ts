/** Offscreen document: writes to the clipboard and clears it after a delay (MV3 service workers cannot). */
let clearTimer: ReturnType<typeof setTimeout> | undefined;
let lastCopied = '';

function write(text: string): void {
  const ta = document.getElementById('buf') as HTMLTextAreaElement;
  ta.value = text;
  ta.select();
  document.execCommand('copy');
  ta.value = '';
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id || msg?.target !== 'offscreen' || msg.type !== 'copy') return;
  write(String(msg.text));
  lastCopied = String(msg.text);
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    // Overwrite with an empty value. (Reading the clipboard to compare would need an extra permission.)
    if (lastCopied) write(' ');
    lastCopied = '';
  }, Number(msg.clearAfterMs) || 30_000);
});
