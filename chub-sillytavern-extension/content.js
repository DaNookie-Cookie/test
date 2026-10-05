(() => {
  const BUTTON_ID = 'chub-st-import-button';
  const STATUS_ID = 'chub-st-import-status';
  let lastUrl = location.href;

  function addButton() {
    if (document.getElementById(BUTTON_ID)) return;
    if (!isCharacterPage()) return;

    const wrap = document.createElement('div');
    wrap.id = 'chub-st-importer-wrap';

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = '⇥ Send to SillyTavern';
    button.title = 'Download this Chub character card and import it into SillyTavern';

    const status = document.createElement('div');
    status.id = STATUS_ID;
    status.hidden = true;

    button.addEventListener('click', async () => {
      button.disabled = true;
      setStatus('Downloading card…', 'busy');

      try {
        const result = await chrome.runtime.sendMessage({
          type: 'IMPORT_CHUB_CHARACTER',
          url: location.href,
        });

        if (!result?.ok) throw new Error(result?.error || 'Import failed.');
        setStatus(`Imported${result.characterName ? `: ${result.characterName}` : ''}`, 'success');
      } catch (error) {
        setStatus(error?.message || String(error), 'error');
      } finally {
        button.disabled = false;
      }
    });

    wrap.append(button, status);
    document.documentElement.appendChild(wrap);
  }

  function setStatus(text, state) {
    const status = document.getElementById(STATUS_ID);
    if (!status) return;
    status.hidden = false;
    status.textContent = text;
    status.dataset.state = state;
  }

  function isCharacterPage() {
    return /^\/characters\/[^/]+\/[^/]+/.test(location.pathname);
  }

  const observer = new MutationObserver(() => addButton());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      const old = document.getElementById('chub-st-importer-wrap');
      old?.remove();
      addButton();
    }
  }, 1000);

  addButton();
})();
