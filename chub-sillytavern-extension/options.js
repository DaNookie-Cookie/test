const defaults = {
  stUrl: 'http://127.0.0.1:8000',
  openStIfMissing: true,
};

const stUrl = document.getElementById('stUrl');
const openStIfMissing = document.getElementById('openStIfMissing');
const status = document.getElementById('status');

async function load() {
  const values = await chrome.storage.local.get(defaults);
  stUrl.value = values.stUrl;
  openStIfMissing.checked = values.openStIfMissing !== false;
}

document.getElementById('save').addEventListener('click', async () => {
  const value = stUrl.value.trim().replace(/\/+$/, '');
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) throw new Error();
  } catch {
    status.textContent = 'Enter a valid http(s) URL.';
    status.style.color = '#ff8c8c';
    return;
  }

  await chrome.storage.local.set({
    stUrl: value,
    openStIfMissing: openStIfMissing.checked,
  });
  status.textContent = 'Saved.';
  status.style.color = '#7fda9f';
  setTimeout(() => { status.textContent = ''; }, 1800);
});

load();
